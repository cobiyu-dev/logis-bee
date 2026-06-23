import { App, LogLevel } from '@slack/bolt';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}이(가) 없습니다. .env를 확인하세요.`);
  return v;
}

// 이모지 트리거(👀). 오더비 등 다른 봇과 겹치지 않게. 바꾸려면 이 줄만 수정.
const TRIGGER_EMOJI = 'eyes';

// ── 월드컵 대한민국:남아공 승부예측 (일회성 테스트 기능) ──────────────
// 곧 제거 예정. 제거 시: git checkout 4b24f05 -- src/app.ts 로 echo 버전 복원.
type Pred = { home: number; away: number };
const predictions = new Map<string, Pred>(); // userId -> 예측 (인메모리, 재시작 시 초기화)

function parseScore(text: string): Pred | null {
  const m = text.match(/(\d+)\s*:\s*(\d+)/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

function formatBoard(): string {
  if (predictions.size === 0) {
    return '아직 예측이 없어요. "@로지스비 2:1" 형식으로 제출해보세요! (대한민국:남아공)';
  }
  const lines = [...predictions.entries()].map(([uid, p]) => `• <@${uid}> — ${p.home} : ${p.away}`);
  return `⚽️ 대한민국 : 남아공 승부예측 현황 (총 ${predictions.size}명)\n${lines.join('\n')}`;
}
// ──────────────────────────────────────────────────────────────────

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
  const reply = (t: string) =>
    client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: t });

  // "예측" 키워드가 있을 때만 월드컵 승부예측 모드. 그 외 일반 멘션은 echo.
  if (text.includes('예측')) {
    // "예측 결과/목록" → 현황 출력
    if (/결과|목록/.test(text)) {
      await reply(formatBoard());
      return;
    }
    // "예측 2:1" → 접수 (덮어쓰기)
    const score = parseScore(text);
    if (score && event.user) {
      predictions.set(event.user, score);
      await reply(
        `✅ <@${event.user}> 님 예측 접수: 대한민국 ${score.home} : ${score.away} 남아공 (다시 내면 덮어써져요)`,
      );
      return;
    }
    // "예측"은 있는데 형식이 안 맞음 → 사용법 안내
    await reply('예측은 "@로지스비 예측 2:1" 형식으로! (대한민국:남아공)\n현황은 "@로지스비 예측 결과"');
    return;
  }

  // 일반 멘션 → echo
  await reply(`받았어요 👀 (echo)\n> ${text}`);
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
