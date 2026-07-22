// 매일 아침 WMS 모닝 에러 브리핑을 자동 게시하는 스케줄러.
// 오더비 slack_bot/scheduler.py(APScheduler)에 대응하는 node-cron 버전.
//
// 흐름: cron(평일 09:10 KST) → runClaude(브리핑 트리거 프롬프트) → wms-briefing 스킬이
// Grafana 로그 조회 + Datadog 보강 + Notion 비교·저장을 하고 Slack용 요약 JSON을 낸다 →
// 스케줄러가 그 출력을 toSlackMessage로 변환해 채널에 게시한다(멘션 핸들러와 동일 패턴).
import cron from 'node-cron';
import type { App } from '@slack/bolt';
import { runClaude } from './executor.js';
import { toSlackMessage } from './slack-message.js';
import { loadDotEnv } from './grafana/config.js';

// 이 프로젝트는 Slack 토큰 등을 셸 환경변수로 읽는다(dev/start 스크립트에 dotenv 없음).
// 브리핑 설정(BRIEFING_*)은 .env에도 둘 수 있게, 셸에 없는 값만 .env에서 채운다(셸 우선).
function hydrateBriefingEnv(): void {
  const dotenv = loadDotEnv();
  for (const key of ['BRIEFING_CHANNEL', 'BRIEFING_NOTION_DB', 'BRIEFING_CRON', 'BRIEFING_TIMEOUT_MS']) {
    if (process.env[key] === undefined && dotenv[key] !== undefined) process.env[key] = dotenv[key];
  }
}

// 평일(월~금) 09:10 KST. 바꾸려면 .env의 BRIEFING_CRON.
const DEFAULT_CRON = '10 9 * * 1-5';
const TIMEZONE = 'Asia/Seoul';

// 브리핑은 로그 조회 + 여러 MCP 호출이 이어져 오래 걸린다. 멘션(기본 5분)보다 넉넉히 준다.
// 항목별 Grafana·Datadog 링크를 Notion에 자식 블록으로 붙이며 patch 호출이 많고, Notion 서버가
// 느린 날엔 더 걸린다. 그래서 25분으로 잡는다. hydrate 이후 읽어야 .env 값이 반영되므로 실행 시점 계산.
const briefingTimeoutMs = () => Number(process.env.BRIEFING_TIMEOUT_MS ?? '1500000'); // 25분

/**
 * 브리핑 스킬을 트리거하는 프롬프트. "어제 WMS 에러 브리핑"이라는 의도만 주면
 * wms-briefing 스킬이 대상 서비스·LogQL·Datadog 보강·Notion 저장 절차를 안다.
 * Notion 부모 DB id는 스킬이 프롬프트에서 받도록 여기서 명시한다.
 */
function buildBriefingPrompt(notionDb: string): string {
  const notionLine = notionDb
    ? `Notion 저장·비교에 쓸 부모 DB(block) id는 ${notionDb} 이다.`
    : 'Notion 부모 DB id가 설정되지 않았으니(BRIEFING_NOTION_DB 없음) Notion 저장·비교는 건너뛰고 Slack 요약만 만들어라.';
  return [
    '어제 하루(KST) WMS 프로덕션 에러 모닝 브리핑을 만들어라. wms-briefing 스킬 절차를 따른다.',
    notionLine,
    '최종 출력은 Slack에 게시할 요약이다.',
  ].join('\n');
}

/**
 * 브리핑을 1회 실행해 채널에 게시한다. cron 콜백과 run-once가 공유한다.
 * 실패해도 예외를 던지지 않는다(스케줄러/봇이 죽으면 안 됨) — 실패 사실을 채널에 남긴다.
 */
async function runBriefingOnce(client: App['client'], channel: string, notionDb: string): Promise<void> {
  console.log(`[briefing] 시작 — channel=${channel}`);
  const result = await runClaude(buildBriefingPrompt(notionDb), { timeoutMs: briefingTimeoutMs() });

  if (!result.ok) {
    console.error(`[briefing] 실패: ${result.error}`);
    await client.chat
      .postMessage({ channel, text: `모닝 브리핑 생성에 실패했어요.\n\`\`\`${result.error}\`\`\`` })
      .catch((e) => console.error('[briefing] 실패 알림 게시도 실패:', e));
    return;
  }

  const msg = toSlackMessage(result.output);
  await client.chat
    .postMessage({ channel, text: msg.text, blocks: msg.blocks })
    .catch((e) => console.error('[briefing] 게시 실패:', e));
  console.log('[briefing] 게시 완료');
}

/**
 * 스케줄러를 기동한다. BRIEFING_CHANNEL이 없으면 조용히 비활성(경고 로그만) —
 * 채널을 아직 안 정한 상태에서도 봇 자체는 정상 동작해야 하므로.
 */
export function startScheduler(client: App['client']): void {
  hydrateBriefingEnv();
  const channel = process.env.BRIEFING_CHANNEL;
  if (!channel) {
    console.warn('[scheduler] BRIEFING_CHANNEL 미설정 — 모닝 브리핑 스케줄러 비활성.');
    return;
  }
  const notionDb = process.env.BRIEFING_NOTION_DB ?? '';
  const expression = process.env.BRIEFING_CRON ?? DEFAULT_CRON;

  cron.schedule(expression, () => void runBriefingOnce(client, channel, notionDb), {
    timezone: TIMEZONE,
    name: 'wms-morning-briefing',
    noOverlap: true, // 이전 브리핑이 안 끝났으면 겹쳐 돌지 않는다
  });
  console.log(`[scheduler] 모닝 브리핑 등록 — cron="${expression}" (${TIMEZONE}), channel=${channel}`);
}

/** 즉시 1회 실행(스케줄 대기 없이 검증용). CLI: `npm run briefing`. */
export { runBriefingOnce, hydrateBriefingEnv };
