// 세션 파일 관리 + 인증 유효성 검증.
// 사내 Grafana는 서비스계정 토큰을 지원하지 않으므로 grafana_session 쿠키만 사용한다.
import fs from 'node:fs';
import path from 'node:path';
import { GrafanaConfig } from './config.js';

export interface SessionData {
  grafana_session: string;
  grafana_session_expiry?: string;
}

export function loadSession(cfg: GrafanaConfig): SessionData | null {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.sessionFile, 'utf8')) as SessionData;
    return data.grafana_session ? data : null;
  } catch {
    return null;
  }
}

export function saveSession(cfg: GrafanaConfig, session: SessionData): void {
  fs.mkdirSync(path.dirname(cfg.sessionFile), { recursive: true });
  fs.writeFileSync(cfg.sessionFile, JSON.stringify(session));
  try {
    fs.chmodSync(cfg.sessionFile, 0o600); // Windows에서는 효과가 제한적이나 무해
  } catch {
    /* noop */
  }
}

/** GET /api/org 200 여부로 인증 수단을 실검증. redirect는 미인증(302)으로 취급. */
async function orgOk(cfg: GrafanaConfig, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.grafanaUrl}/api/org`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export function checkCookie(cfg: GrafanaConfig, session: string): Promise<boolean> {
  return orgOk(cfg, { Cookie: `grafana_session=${session}` });
}

/** Set-Cookie 헤더 배열에서 특정 쿠키의 최신 값을 뽑는다. 못 찾으면 빈 문자열. */
function pickSetCookie(setCookies: string[], name: string): string {
  let value = '';
  for (const sc of setCookies) {
    // 각 Set-Cookie는 "name=value; Path=/; ..." 형태. 이름이 일치하는 마지막 값을 취한다.
    const m = new RegExp(`(?:^|[,\\s])${name}=([^;]*)`).exec(sc);
    if (m) value = m[1];
  }
  return value;
}

/**
 * 만료된(401) grafana_session을 /user/auth-tokens/rotate로 새 토큰과 교환한다.
 *
 * Grafana는 세션 토큰을 주기적으로 회전시키고, idle하게 회전 주기를 넘기면 401로 무효화한다.
 * 하지만 무효화된 토큰도 이 엔드포인트에 들고 요청하면 새 토큰으로 교환된다(SSO 세션이 살아있는 동안).
 * 브라우저가 idle 후에도 안 죽는 이유가 이 rotate 복구다. 이걸 재현해 Chrome 재로그인을 피한다.
 *
 * rotate는 리다이렉트 체인 중간에 Set-Cookie로 새 토큰을 심을 수 있으므로, redirect: 'manual'로
 * 응답을 따라가며 매 홉의 Set-Cookie를 확인한다. 성공(새 토큰이 /api/org 200) 시 SessionData 반환, 실패 시 null.
 */
export async function rotateSession(cfg: GrafanaConfig, deadToken: string): Promise<SessionData | null> {
  let token = deadToken;
  let url = `${cfg.grafanaUrl}/user/auth-tokens/rotate`;
  let newSession = '';
  let newExpiry = '';

  try {
    // 리다이렉트를 수동으로 따라가며(최대 5홉) Set-Cookie에서 새 grafana_session을 수집한다.
    for (let hop = 0; hop < 5; hop++) {
      const res: Response = await fetch(url, {
        method: 'GET',
        headers: { Cookie: `grafana_session=${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });

      const setCookies = res.headers.getSetCookie();
      const gs = pickSetCookie(setCookies, 'grafana_session');
      const exp = pickSetCookie(setCookies, 'grafana_session_expiry');
      if (gs) {
        newSession = gs;
        token = gs; // 다음 홉은 새 토큰으로 따라간다
      }
      if (exp) newExpiry = exp;

      // 리다이렉트가 아니면 체인 종료
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('location');
      if (!loc) break;
      url = new URL(loc, url).toString();
    }
  } catch {
    return null;
  }

  if (newSession && (await checkCookie(cfg, newSession))) {
    return { grafana_session: newSession, grafana_session_expiry: newExpiry || undefined };
  }
  return null;
}

export type AuthCheck =
  | { valid: true; auth: 'cookie'; session: string }
  | { valid: false; reason: string };

/** 저장된 grafana_session 쿠키가 유효한지 확인한다 (브라우저 미개입). */
export async function checkAuth(cfg: GrafanaConfig): Promise<AuthCheck> {
  const saved = loadSession(cfg);
  if (saved && (await checkCookie(cfg, saved.grafana_session))) {
    return { valid: true, auth: 'cookie', session: saved.grafana_session };
  }
  return { valid: false, reason: saved ? 'cookie expired' : 'no session file' };
}
