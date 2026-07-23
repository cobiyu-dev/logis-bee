// Grafana 인증·조회 모듈의 환경 설정.
// prod/alpha 이원화 + 환경변수 오버라이드.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GrafanaEnv = 'prod' | 'alpha';

/** 프로젝트 루트 (src/grafana/ 기준 두 단계 위). .env를 여기서 찾는다. */
export const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** PC 로컬 상태 디렉토리 — 세션 파일, 전용 Chrome 프로필. PC마다 자기 홈 아래. */
export const STATE_DIR = process.env.LODAERI_STATE_DIR ?? path.join(os.homedir(), '.lodaeri');
export const CHROME_PROFILE_DIR = path.join(STATE_DIR, 'chrome-profile');

/** 전용 CDP 포트. 다른 CDP Chrome(9222 등)과 충돌하지 않게 기본 9223. */
export const CDP_PORT = Number(process.env.GRAFANA_CDP_PORT ?? '9223');

/** OTP를 읽을 Authenticator 확장 (Chrome Web Store 공통 ID) */
export const OTP_EXTENSION_ID =
  process.env.GRAFANA_OTP_EXTENSION_ID ?? 'bhghoamapcdpbohphigoooaddinpkbai';
/** 확장 팝업에서 이 문자열이 포함된 계정 줄 아래의 6자리 코드를 읽는다 */
export const OTP_ACCOUNT_LABEL = process.env.GRAFANA_OTP_ACCOUNT ?? 'kakaostyle';

/** Loki 데이터소스 UID — prod/alpha 동일 UID로 각 grafana 안에서 라우팅됨 */
export const LOKI_DATASOURCE_UID = process.env.GRAFANA_LOKI_UID ?? 'P8E80F9AEF21F6940';

export interface GrafanaConfig {
  env: GrafanaEnv;
  grafanaUrl: string;
  host: string;
  sessionFile: string;
}

export function resolveConfig(env: GrafanaEnv): GrafanaConfig {
  const grafanaUrl =
    env === 'prod'
      ? (process.env.GRAFANA_URL ?? 'https://grafana.zigzag.in')
      : (process.env.GRAFANA_ALPHA_URL ?? 'https://grafana.alpha.zigzag.in');
  const suffix = env === 'prod' ? '' : '_alpha';
  return {
    env,
    grafanaUrl,
    host: grafanaUrl.split('//')[1]?.split('/')[0] ?? grafanaUrl,
    sessionFile:
      (env === 'prod' ? process.env.GRAFANA_SESSION_FILE : process.env.GRAFANA_ALPHA_SESSION_FILE) ??
      path.join(STATE_DIR, `grafana_session${suffix}.json`),
  };
}

/**
 * 프로젝트 루트의 .env 파싱 (dotenv 의존 없이).
 * KEYCLOAK_USERNAME/PASSWORD 등 자격 증명을 여기서 읽는다.
 */
export function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
