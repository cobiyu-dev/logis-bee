// CDP로 Keycloak SSO 로그인 + OTP 입력 후 grafana_session 쿠키 추출.
import { GrafanaConfig, loadDotEnv, sleep } from './config.js';
import { CDP_PORT, CHROME_PROFILE_DIR } from './config.js';
import { CdpSession, createTarget, listTargets } from './cdp.js';
import { closeSpawnedBrowser, ensureCdpBrowser } from './chrome.js';
import { readOtpFromExtension, waitForFreshOtpWindow } from './otp.js';
import { SessionData } from './session.js';

/** Grafana 탭 하나를 확보한다 (기존 탭 재사용 → 없으면 새 탭 1회 생성). */
async function acquireGrafanaTab(cfg: GrafanaConfig) {
  const loginUrl = `${cfg.grafanaUrl}/login`;
  let targets = await listTargets(CDP_PORT);
  let tab = targets?.find(
    (t) => t.type === 'page' && t.url.includes(cfg.host) && t.webSocketDebuggerUrl,
  );
  if (tab?.webSocketDebuggerUrl) return tab;

  const created = await createTarget(CDP_PORT, loginUrl);
  if (created?.webSocketDebuggerUrl) return created;

  // 새 탭 URL이 즉시 안 채워지는 경우 재조회
  await sleep(1500);
  targets = await listTargets(CDP_PORT);
  tab = targets?.find(
    (t) => t.type === 'page' && (t.url.includes(cfg.host) || t.url === 'about:blank') && t.webSocketDebuggerUrl,
  );
  return tab ?? null;
}

/** 로그인된 페이지에서 grafana_session / expiry 쿠키 추출 */
async function extractCookies(page: CdpSession, cfg: GrafanaConfig): Promise<SessionData | null> {
  const res = await page.call('Network.getCookies', { urls: [cfg.grafanaUrl] });
  const cookies: Array<{ name: string; value: string }> = res?.cookies ?? [];
  let session = '';
  let expiry = '';
  for (const c of cookies) {
    if (c.name === 'grafana_session') session = c.value;
    else if (c.name === 'grafana_session_expiry') expiry = c.value;
  }
  return session ? { grafana_session: session, grafana_session_expiry: expiry } : null;
}

/**
 * 브라우저 자동 로그인 1회 시도. 성공 시 쿠키(SessionData) 반환, 실패 시 null.
 * 사전조건: CDP 브라우저가 떠 있어야 함(ensureCdpBrowser가 보장).
 */
export async function acquireViaBrowser(cfg: GrafanaConfig): Promise<SessionData | null> {
  // 우리가 새로 띄운 브라우저만 끝나고 닫는다(handle.spawned). 기존 브라우저는 붙어 쓰고 그대로 둔다.
  const handle = await ensureCdpBrowser(`${cfg.grafanaUrl}/login`);
  try {
    return await runLoginFlow(cfg);
  } finally {
    await closeSpawnedBrowser(handle);
  }
}

/** 실제 로그인 시퀀스. 브라우저 생명주기는 호출자(acquireViaBrowser)가 관리한다. */
async function runLoginFlow(cfg: GrafanaConfig): Promise<SessionData | null> {
  const tab = await acquireGrafanaTab(cfg);
  if (!tab?.webSocketDebuggerUrl) return null;

  const page = await CdpSession.connect(tab.webSocketDebuggerUrl);
  try {
    await page.call('Page.enable', {});
    await page.call('Network.enable', {});

    // 1) 로그인 페이지로 이동
    await page.call('Page.navigate', { url: `${cfg.grafanaUrl}/login` });
    await sleep(3000);

    let url: string = (await page.eval('window.location.href')) ?? '';
    if (url.includes(cfg.host) && !url.includes('/login')) {
      // 이미 로그인 상태 (SSO 쿠키 살아있음)
      return await extractCookies(page, cfg);
    }

    // 2) Keycloak-OAuth 버튼 클릭
    await page.eval(`
      (() => {
        for (const a of document.querySelectorAll('a')) {
          if (a.textContent.includes('Keycloak') || a.textContent.includes('Sign in with')) { a.click(); return; }
        }
      })()
    `);
    await sleep(4000);

    url = (await page.eval('window.location.href')) ?? '';
    if (!url.includes('keycloak')) {
      // SSO가 이미 살아있어 곧장 Grafana로 돌아왔을 수도 있음
      if (url.includes(cfg.host) && !url.includes('/login')) return await extractCookies(page, cfg);
      return null;
    }

    // 3) .env에서 Keycloak SSO 자격 증명 로드
    const env = { ...loadDotEnv(), ...process.env };
    const user = env['KEYCLOAK_USERNAME'];
    const pass = env['KEYCLOAK_PASSWORD'];
    if (!user || !pass) return null;

    // 4) 폼 입력 (값 세팅 + input 이벤트 dispatch)
    const setInput = (selector: string, valueJson: string) => `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'no_el';
        el.value = ${valueJson};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `;
    await page.eval(setInput('input[name=username]', JSON.stringify(user)));
    await page.eval(setInput('input[name=password]', JSON.stringify(pass)));
    await page.eval(`document.querySelector('input[type=submit]')?.click()`);
    await sleep(4000);

    // 5) OTP 단계
    const hasOtp = (await page.eval(`document.querySelector('input[name=otp]') ? 'y' : 'n'`)) === 'y';
    if (hasOtp) {
      await waitForFreshOtpWindow();
      const code = await readOtpFromExtension();
      if (!code) return null;
      await page.eval(setInput('input[name=otp]', JSON.stringify(code)));
      await page.eval(`document.querySelector('input[type=submit]')?.click()`);
      await sleep(5000);
    }

    // 6) 로그인 결과 확인 + 쿠키 추출
    url = (await page.eval('window.location.href')) ?? '';
    if (url.includes(cfg.host) && !url.includes('/login')) {
      return await extractCookies(page, cfg);
    }
    return null;
  } finally {
    page.close();
  }
}

export { CHROME_PROFILE_DIR };
