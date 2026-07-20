// Grafana Loki 조회 CLI. Claude 스킬(grafana-logs)이 이 CLI를 호출한다.
//
// 사용법:
//   npm run grafana -- check [prod|alpha]
//   npm run grafana -- login [prod|alpha]
//   npm run grafana -- query [prod|alpha] '<LogQL>' [from] [to] [maxLines]
//
// 예:
//   npm run grafana -- query prod '{app="wms", loglevel="ERROR"}' now-1h now 5000
import { GrafanaEnv, resolveConfig } from './config.js';
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
    default:
      out({
        error: 'unknown_command',
        usage: ['check [env]', 'login [env]', "query [env] '<LogQL>' [from] [to] [maxLines]"],
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
