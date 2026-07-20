import { App, LogLevel } from '@slack/bolt';
import type { types as slackTypes } from '@slack/bolt';
import { runClaude } from './executor.js';

type KnownBlock = slackTypes.KnownBlock;

/**
 * claude 출력에서 Slack 메시지를 뽑아낸다.
 * slack-format 스킬이 동작하면 {text, blocks} JSON이 오고, 아니면 그냥 텍스트가 온다.
 *
 * claude가 JSON 앞에 설명 문장을 붙이거나 ```json 코드펜스로 감싸는 경우가 잦다.
 * 그래서 맨 앞 글자만 보지 않고, 출력에서 가장 바깥 {...} 덩어리를 찾아 파싱을 시도한다.
 * 그래도 유효한 blocks JSON이 아니면 원문을 통째로 text로 쓴다 (안전한 폴백 — 빈 응답 방지).
 */
function toSlackMessage(raw: string): { text: string; blocks?: KnownBlock[] } {
  const trimmed = raw.trim();
  const parsed = extractBlocksJson(trimmed);
  if (parsed) {
    const blocks = Array.isArray(parsed.blocks) && parsed.blocks.length > 0
      ? (parsed.blocks as KnownBlock[])
      : undefined;
    const text = typeof parsed.text === 'string' && parsed.text ? parsed.text : '응답';
    return { text, blocks };
  }
  return { text: trimmed || '(응답이 비어 있어요)' }; // JSON을 못 찾으면 원문 그대로
}

/**
 * 문자열에서 {text, blocks} 형태의 JSON 객체를 뽑아낸다. 못 찾으면 null.
 * 첫 '{'부터 마지막 '}'까지 잘라 파싱을 시도한다(가장 바깥 객체). 이러면 앞뒤 잡담·코드펜스를 걷어낸다.
 */
function extractBlocksJson(s: string): { text?: unknown; blocks?: unknown } | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as { text?: unknown; blocks?: unknown };
    // text나 blocks 중 하나라도 있어야 slack-format 응답으로 인정 (엉뚱한 JSON 방어)
    if (typeof obj !== 'object' || obj === null) return null;
    if (!('text' in obj) && !('blocks' in obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}이(가) 없습니다. .env를 확인하세요.`);
  return v;
}

/**
 * 스레드의 이전 대화를 읽어 claude에게 넘길 맥락 문자열로 만든다.
 * "좀 더 자세하게" 같은 후속 멘션은 앞 대화를 알아야 뜻이 통하므로, 스레드 전체를 시간순으로 넘긴다.
 *
 * - `excludeTs`(이번 멘션, 방금 단 placeholder)는 중복·잡음이라 뺀다.
 * - 봇 메시지(`bot_id` 있음)는 "로지스비", 사람은 "사용자"로 라벨링해 누가 무슨 말을 했는지 구분한다.
 * - 봇이 이전에 보낸 blocks JSON/텍스트도 원문 그대로 넣어, claude가 자기가 뭘 답했는지 알고 이어가게 한다.
 * 이전 메시지가 없으면(첫 멘션) 빈 문자열 → 호출부에서 맥락 없이 이번 요청만 넘긴다.
 */
async function buildThreadContext(
  client: App['client'],
  channel: string,
  threadTs: string,
  excludeTs: string[],
): Promise<string> {
  const res = await client.conversations.replies({ channel, ts: threadTs, limit: 100 });
  const messages = res.messages ?? [];
  const skip = new Set(excludeTs);

  const lines: string[] = [];
  for (const m of messages) {
    if (m.ts && skip.has(m.ts)) continue;
    const body = (m.text ?? '').trim();
    if (!body) continue;
    const who = m.bot_id ? '로지스비(너의 이전 답변)' : '사용자';
    lines.push(`[${who}]\n${body}`);
  }
  return lines.join('\n\n');
}

// 이모지 트리거(👀). 오더비 등 다른 봇과 겹치지 않게. 바꾸려면 이 줄만 수정.
const TRIGGER_EMOJI = 'eyes';

const app = new App({
  token: required('SLACK_BOT_TOKEN'), // xoxb-
  appToken: required('SLACK_APP_TOKEN'), // xapp-
  socketMode: true, // Socket Mode = PC가 Slack으로 아웃바운드 WebSocket을 연다
  logLevel: LogLevel.DEBUG, // 테스트 단계라 상세 로그
});

// 전역 에러 핸들러 — 핸들러/소켓 에러를 콘솔에서 확인
app.error(async (err) => {
  console.error('[app.error]', err);
});

// 1) 멘션: @로지스비 ... → claude CLI에 위임해 스킬(grafana-logs 등)로 답변
app.event('app_mention', async ({ event, client, logger }) => {
  const text = event.text.replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '').trim(); // <@U123> / <@U123|name> 모두 제거
  const threadTs = event.thread_ts ?? event.ts;
  logger.info(`[mention] user=${event.user} ch=${event.channel} text=${text}`);

  if (!text) {
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '무엇을 도와드릴까요?' });
    return;
  }

  // 처리에 수십 초 걸리므로, 먼저 임시 메시지를 달고 완료 시 그 메시지를 교체한다.
  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: '확인 중이에요 👀',
  });

  // 스레드 안 멘션이면 이전 대화를 읽어 맥락으로 넘긴다("좀 더 자세하게" 같은 후속 요청 이해).
  // 이번 멘션과 방금 단 placeholder는 맥락에서 제외한다.
  let context = '';
  try {
    context = await buildThreadContext(client, event.channel, threadTs, [event.ts, placeholder.ts as string]);
  } catch (e) {
    logger.warn(`[mention] 스레드 맥락 읽기 실패(맥락 없이 진행): ${e instanceof Error ? e.message : e}`);
  }

  // 이전 대화가 있으면 프롬프트 앞에 붙인다. 없으면(첫 멘션) 이번 요청만 넘겨 기존과 동일하게 동작.
  const prompt = context
    ? `아래는 이 슬랙 스레드의 이전 대화다. 사용자의 새 요청은 이 맥락을 이어받은 것이니 참고해서 답해라.\n\n<이전 대화>\n${context}\n</이전 대화>\n\n<새 요청>\n${text}\n</새 요청>`
    : text;

  const result = await runClaude(prompt);

  if (!result.ok) {
    await client.chat.update({
      channel: event.channel,
      ts: placeholder.ts as string,
      text: `처리 중 오류가 발생했어요.\n\`\`\`${result.error}\`\`\``,
    });
    return;
  }

  // claude가 slack-format 스킬로 blocks JSON을 냈으면 blocks로, 아니면 text로 전송.
  const msg = toSlackMessage(result.output);
  await client.chat.update({
    channel: event.channel,
    ts: placeholder.ts as string,
    text: msg.text, // blocks가 있어도 알림용 폴백으로 항상 필요
    blocks: msg.blocks,
  });
});

// 2) 이모지 리액션: TRIGGER_EMOJI 하나에만 반응
app.event('reaction_added', async ({ event, client, logger }) => {
  if (event.reaction !== TRIGGER_EMOJI) return; // 다른 이모지·다른 봇 트리거에 끼어들지 않음
  logger.info(`[reaction] user=${event.user} emoji=${event.reaction} item_ts=${event.item.ts}`);
  if (event.item.type === 'message') {
    // file 리액션 등 방어
    await client.chat.postMessage({
      channel: event.item.channel,
      thread_ts: event.item.ts,
      text: `:${event.reaction}: 리액션 감지 (echo)`,
    });
  }
});

// 3) 메시지/DM
app.event('message', async ({ event, client, logger }) => {
  if (event.subtype) return; // bot_message 등 → 자기 echo 루프 차단(Bolt ignoreSelf와 이중 방어)
  // 여기서 event는 GenericMessageEvent로 좁혀짐. text는 optional이라 undefined 가능 → ?? '' 처리
  const text = event.text ?? '';
  logger.info(`[message] ch=${event.channel} type=${event.channel_type} text=${text}`);
  if (event.channel_type === 'im') {
    // DM만 echo (채널 일반 메시지는 로그만)
    await client.chat.postMessage({
      channel: event.channel,
      text: `DM 받았어요 (echo): ${text}`,
    });
  }
});

await app.start(); // top-level await (ESM) — WebSocket 연결 수립
console.log('⚡️ Slack 이벤트 수신 대기 중 (Socket Mode)');
