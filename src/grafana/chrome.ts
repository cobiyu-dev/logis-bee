// 전용 프로필 Chrome을 CDP 모드로 기동/보장.
// 워치독 없이 필요 시점에 전용 프로필 Chrome을 lazy 기동한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CDP_PORT, CHROME_PROFILE_DIR, sleep } from './config.js';
import { cdpAlive, browserWsUrl, CdpSession } from './cdp.js';

/** OS별 Chrome 실행 파일 후보. GRAFANA_CHROME_PATH 환경변수가 있으면 최우선. */
function chromeCandidates(): string[] {
  const fromEnv = process.env.GRAFANA_CHROME_PATH;
  const candidates: string[] = fromEnv ? [fromEnv] : [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else if (process.platform === 'win32') {
    for (const root of [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ]) {
      if (root) candidates.push(`${root}\\Google\\Chrome\\Application\\chrome.exe`);
    }
  }
  return candidates;
}

export function findChrome(): string | null {
  for (const p of chromeCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** ensureCdpBrowser 결과. spawned=true면 이번 호출이 새로 띄운 것 → 호출자가 닫을 책임을 진다. */
export interface CdpBrowserHandle {
  spawned: boolean;
  pid?: number;
}

/**
 * CDP 포트가 살아있으면 그대로 두고, 죽어있으면 전용 프로필로 Chrome을 띄운다.
 * 전용 프로필(~/.logisbi/chrome-profile)을 쓰는 이유:
 *  - 사용자의 일상 Chrome을 디버깅 포트로 열지 않는다 (보안·간섭 회피)
 *  - Authenticator 확장·Keycloak SSO 쿠키를 이 프로필에 1회 세팅해 두면 이후 재사용
 *
 * 이미 떠 있던 브라우저에는 붙기만 하고(spawned:false) 절대 닫지 않는다 — 남의 컨텍스트를 침범하지 않기 위해.
 */
export async function ensureCdpBrowser(startUrl = 'about:blank'): Promise<CdpBrowserHandle> {
  if (await cdpAlive(CDP_PORT)) return { spawned: false };

  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      'Chrome 실행 파일을 찾지 못했습니다. GRAFANA_CHROME_PATH 환경변수로 경로를 지정하세요.',
    );
  }

  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      startUrl,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  // CDP 응답 대기 (최대 20초)
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await cdpAlive(CDP_PORT)) return { spawned: true, pid: child.pid };
  }
  // 응답 없으면 우리가 띄운 좀비를 남기지 않고 정리
  await closeSpawnedBrowser({ spawned: true, pid: child.pid });
  throw new Error(`Chrome을 띄웠지만 CDP 포트(${CDP_PORT})가 응답하지 않습니다.`);
}

/**
 * ensureCdpBrowser가 직접 띄운 브라우저만 종료한다. spawned:false면 아무것도 하지 않는다.
 *
 * process.kill(pid)로는 안 된다: macOS Chrome은 런처(pid)와 실제 브라우저·렌더러가 별도 프로세스라,
 * 런처만 죽이면 창이 살아남아 CDP 포트가 계속 응답한다. 그래서 CDP `Browser.close`로 Chrome이
 * 자식까지 스스로 정상 종료하게 한다. 그게 실패하면 프로세스 그룹 전체(-pid)를 kill한다.
 */
export async function closeSpawnedBrowser(handle: CdpBrowserHandle): Promise<void> {
  if (!handle.spawned || !handle.pid) return;

  // 1) CDP Browser.close — 자식 프로세스까지 정상 종료 (권장 경로)
  try {
    const wsUrl = await browserWsUrl(CDP_PORT);
    if (wsUrl) {
      const browser = await CdpSession.connect(wsUrl);
      await browser.call('Browser.close');
      browser.close();
      // 포트가 실제로 닫혔는지 잠깐 확인
      for (let i = 0; i < 5; i++) {
        if (!(await cdpAlive(CDP_PORT))) return;
        await sleep(500);
      }
    }
  } catch {
    /* CDP 종료 실패 → 아래 프로세스 kill로 폴백 */
  }

  // 2) 폴백: detached로 띄웠으므로 프로세스 그룹(-pid) 전체를 죽인다. 그것도 실패하면 단일 pid.
  try {
    process.kill(-handle.pid);
  } catch {
    try {
      process.kill(handle.pid);
    } catch {
      /* 이미 죽었으면 무시 */
    }
  }
}
