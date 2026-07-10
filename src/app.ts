import { App, LogLevel } from '@slack/bolt';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}이(가) 없습니다. .env를 확인하세요.`);
  return v;
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

// 1) 멘션: @로지스비 ...
app.event('app_mention', async ({ event, client, logger }) => {
  const text = event.text.replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '').trim(); // <@U123> / <@U123|name> 모두 제거
  const threadTs = event.thread_ts ?? event.ts;
  logger.info(`[mention] user=${event.user} ch=${event.channel} text=${text}`);
  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: `받았어요 👀 (echo)\n> ${text}`,
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
