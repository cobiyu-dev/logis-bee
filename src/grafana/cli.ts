// Grafana Loki 조회 CLI. Claude 스킬(grafana-logs)이 이 CLI를 호출한다.
//
// 사용법:
//   npm run grafana -- check [prod|alpha]
//   npm run grafana -- login [prod|alpha]
//   npm run grafana -- query [prod|alpha] '<LogQL>' [from] [to] [maxLines]
//   npm run grafana -- link  [prod|alpha] '<LogQL>' [from] [to]
//
// 예:
//   npm run grafana -- query prod '{app="wms", loglevel="ERROR"}' now-1h now 5000
//   npm run grafana -- link  prod '{app="wms"} |= `"log_level":"ERROR"`' 2026-07-19T15:00:00Z 2026-07-20T15:00:00Z
// (배포 버전 파악은 Grafana가 아니라 Datadog MCP를 쓴다 — 스킬 Step 1.5 참조)
import { GrafanaEnv, LOKI_DATASOURCE_UID, resolveConfig } from './config.js';
import { checkAuth } from './session.js';
import { ensureAuth } from './auth.js';
import { extractLines, queryLoki } from './loki.js';

function parseEnv(arg: string | undefined): GrafanaEnv {
  return arg === 'alpha' ? 'alpha' : 'prod';
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<number> {
  const [cmd, envArg, ...rest] = process.argv.slice(2);
  const cfg = resolveConfig(parseEnv(envArg));

  switch (cmd) {
    case 'check': {
      const c = await checkAuth(cfg);
      out(c);
      return c.valid ? 0 : 1;
    }
    case 'login': {
      const r = await ensureAuth(cfg, { forceRefresh: true });
      out(r);
      return r.ok ? 0 : 1;
    }
    case 'query': {
      const [expr, from, to, maxLines] = rest;
      if (!expr) {
        out({ error: "LogQL 식이 필요합니다. 예: query prod '{app=\"wms\", loglevel=\"ERROR\"}'" });
        return 1;
      }
      try {
        const result = await queryLoki(cfg, {
          expr,
          from,
          to,
          maxLines: maxLines ? Number(maxLines) : undefined,
        });
        const lines = extractLines(result);
        out({ env: cfg.env, count: lines.length, lines });
        return 0;
      } catch (e) {
        out({ error: 'query_failed', message: (e as Error).message });
        return 2;
      }
    }
    case 'link': {
      // 로그로 바로 가는 Grafana Explore deep link를 만든다. 조회 없이 URL만 조립하므로 인증 불필요.
      const [expr, from, to] = rest;
      if (!expr) {
        out({ error: "LogQL 식이 필요합니다. 예: link prod '{app=\"wms\"} |= `\"log_level\":\"ERROR\"`'" });
        return 1;
      }
      // ISO8601 등 파싱 가능한 시각은 ms epoch로 바꾼다(explore가 선호). now-1h 같은 상대시간은 그대로 둔다.
      const toRange = (v: string | undefined, fallback: string): string => {
        if (!v) return fallback;
        const t = Date.parse(v);
        return Number.isNaN(t) ? v : String(t);
      };
      const left = {
        datasource: LOKI_DATASOURCE_UID,
        queries: [{ refId: 'A', expr, datasource: { type: 'loki', uid: LOKI_DATASOURCE_UID } }],
        range: { from: toRange(from, 'now-24h'), to: toRange(to, 'now') },
      };
      const url = `${cfg.grafanaUrl}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
      out({ url });
      return 0;
    }
    default:
      out({
        error: 'unknown_command',
        usage: [
          'check [env]',
          'login [env]',
          "query [env] '<LogQL>' [from] [to] [maxLines]",
          "link [env] '<LogQL>' [from] [to]",
        ],
      });
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    out({ error: 'fatal', message: (e as Error).message });
    process.exit(1);
  },
);
