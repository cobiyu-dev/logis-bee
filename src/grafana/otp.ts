// Authenticator 확장 팝업에서 TOTP 코드를 읽는다.
import {
  CDP_PORT,
  OTP_ACCOUNT_LABEL,
  OTP_EXTENSION_ID,
  sleep,
} from './config.js';
import { browserWsUrl, CdpSession, closeTarget, listTargets } from './cdp.js';

const OTP_PERIOD_SECS = 30;
const OTP_MIN_REMAINING_SECS = 5;

/**
 * TOTP 윈도 끝자락이면 다음 윈도 시작까지 대기.
 * 만료 직전에 제출하면 Keycloak이 거부하고 미인증 쿠키가 추출되는 레이스를 막는다.
 */
export async function waitForFreshOtpWindow(): Promise<void> {
  const remaining = OTP_PERIOD_SECS - ((Date.now() / 1000) % OTP_PERIOD_SECS);
  if (remaining < OTP_MIN_REMAINING_SECS) {
    await sleep((remaining + 0.5) * 1000);
  }
}

/** 확장 팝업을 새 탭으로 열어 innerText에서 계정 라벨 아래 6자리 코드를 파싱. */
export async function readOtpFromExtension(): Promise<string | null> {
  const browserWs = await browserWsUrl(CDP_PORT);
  if (!browserWs) return null;

  // 브라우저 레벨 세션으로 팝업 타깃 생성
  let browser: CdpSession;
  try {
    browser = await CdpSession.connect(browserWs);
  } catch {
    return null;
  }

  let targetId: string | undefined;
  try {
    const created = await browser.call('Target.createTarget', {
      url: `chrome-extension://${OTP_EXTENSION_ID}/view/popup.html`,
    });
    targetId = created?.targetId;
  } catch {
    browser.close();
    return null;
  }
  browser.close();
  if (!targetId) return null;

  await sleep(3000); // 팝업 렌더 대기

  try {
    const targets = await listTargets(CDP_PORT);
    const popup = targets?.find((t) => t.id === targetId);
    if (!popup?.webSocketDebuggerUrl) return null;

    const page = await CdpSession.connect(popup.webSocketDebuggerUrl);
    let body = '';
    try {
      body = (await page.eval('document.body.innerText')) ?? '';
    } finally {
      page.close();
    }

    if (!body) return null;
    return parseOtp(body);
  } finally {
    await closeTarget(CDP_PORT, targetId);
  }
}

/** "kakaostyle" 계정 줄 아래 3줄 안에서 6자리 숫자를 찾는다. */
export function parseOtp(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const six = /^\d{6}$/;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(OTP_ACCOUNT_LABEL.toLowerCase())) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (six.test(lines[j])) return lines[j];
      }
    }
  }
  return null;
}
