// 인증 오케스트레이터: 저장 쿠키 → 브라우저 자동 로그인 순으로 확보.
// 세션 재취득 후 실검증하고, 실패 시 1회 재시도한다.
import { GrafanaConfig } from './config.js';
import { acquireViaBrowser } from './browser-login.js';
import { AuthCheck, checkAuth, checkCookie, loadSession, rotateSession, saveSession } from './session.js';

const MAX_ACQUIRE_ATTEMPTS = 2;

export type EnsureResult =
  | { ok: true; auth: 'cookie'; session: string }
  | { ok: false; reason: string };

/**
 * 유효한 인증을 확보한다. forceRefresh=true면 저장된 쿠키를 건너뛰고 브라우저 재취득.
 * OTP rollover race로 미인증 쿠키가 나올 수 있어, 취득 후 실검증하고 실패 시 1회 더 시도한다.
 */
export async function ensureAuth(
  cfg: GrafanaConfig,
  opts: { forceRefresh?: boolean } = {},
): Promise<EnsureResult> {
  if (!opts.forceRefresh) {
    const c: AuthCheck = await checkAuth(cfg);
    if (c.valid) return { ok: true, auth: 'cookie', session: c.session };

    // 저장 세션이 만료됐으면, 무거운 Chrome 재로그인 전에 rotate로 가벼운 복구를 먼저 시도한다.
    // 대부분의 만료는 여기서 HTTP 한 번으로 조용히 풀린다(Chrome이 안 뜬다).
    const saved = loadSession(cfg);
    if (saved) {
      const rotated = await rotateSession(cfg, saved.grafana_session).catch(() => null);
      if (rotated) {
        saveSession(cfg, rotated);
        return { ok: true, auth: 'cookie', session: rotated.grafana_session };
      }
    }
  }

  // rotate 실패(또는 forceRefresh) → 최종 폴백: Chrome으로 Keycloak+OTP 재로그인
  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const acquired = await acquireViaBrowser(cfg).catch(() => null);
    if (acquired && (await checkCookie(cfg, acquired.grafana_session))) {
      saveSession(cfg, acquired);
      return { ok: true, auth: 'cookie', session: acquired.grafana_session };
    }
  }

  return {
    ok: false,
    reason:
      'Grafana 세션 취득 실패. Chrome 전용 프로필에 Keycloak SSO 로그인·Authenticator 확장이 설정됐는지, ' +
      '.env의 KEYCLOAK_USERNAME/PASSWORD가 올바른지 확인하세요.',
  };
}
