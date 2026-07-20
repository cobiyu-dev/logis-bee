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
