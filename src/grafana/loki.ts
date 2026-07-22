// Loki 로그 조회. Grafana /api/ds/query 경유 (grafana_session 쿠키).
// 401 시 세션을 재취득해 1회 재시도한다.
import { GrafanaConfig, LOKI_DATASOURCE_UID } from './config.js';
import { ensureAuth } from './auth.js';

export interface LokiQueryOpts {
  expr: string;
  from?: string; // now-5m 등
  to?: string;
  maxLines?: number;
}

interface AuthState {
  header: Record<string, string>;
}

async function buildAuthHeaders(cfg: GrafanaConfig, forceRefresh = false): Promise<AuthState> {
  const res = await ensureAuth(cfg, { forceRefresh });
  if (!res.ok) throw new Error(res.reason);
  return { header: { Cookie: `grafana_session=${res.session}` } };
}

function payload(opts: LokiQueryOpts) {
  return JSON.stringify({
    queries: [
      {
        refId: 'A',
        datasource: { type: 'loki', uid: LOKI_DATASOURCE_UID },
        expr: opts.expr,
        queryType: 'range',
        maxLines: opts.maxLines ?? 5000,
      },
    ],
    from: opts.from ?? 'now-5m',
    to: opts.to ?? 'now',
  });
}

async function doQuery(cfg: GrafanaConfig, auth: AuthState, body: string) {
  return fetch(`${cfg.grafanaUrl}/api/ds/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.header },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
}

/** LogQL 쿼리 실행. 401/403이면 세션을 재취득해 1회 재시도한다. */
export async function queryLoki(cfg: GrafanaConfig, opts: LokiQueryOpts): Promise<any> {
  const body = payload(opts);
  let auth = await buildAuthHeaders(cfg);
  let res = await doQuery(cfg, auth, body);

  if (res.status === 401 || res.status === 403) {
    // 만료 감지 → 브라우저 재로그인으로 세션 강제 재취득 후 1회 재시도
    auth = await buildAuthHeaders(cfg, true);
    res = await doQuery(cfg, auth, body);
  }

  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new Error(`Loki query failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** 응답 JSON에서 로그 라인만 평평하게 추출 */
export function extractLines(result: any): string[] {
  const frames = result?.results?.A?.frames ?? [];
  const out: string[] = [];
  for (const f of frames) {
    const values = f?.data?.values ?? [];
    // Loki range frame: values[2]가 로그 라인 배열인 경우가 일반적
    const lineCol = values[2] ?? values[1] ?? [];
    for (const line of lineCol) out.push(String(line));
  }
  return out;
}

