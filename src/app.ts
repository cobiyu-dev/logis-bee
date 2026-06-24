import { App, LogLevel } from '@slack/bolt';
import { type Pred, parseScore, rankAndFind } from './scoring.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}이(가) 없습니다. .env를 확인하세요.`);
  return v;
}

// 이모지 트리거(👀). 오더비 등 다른 봇과 겹치지 않게. 바꾸려면 이 줄만 수정.
const TRIGGER_EMOJI = 'eyes';

// ── 월드컵 대한민국:남아공 승부예측 (일회성 테스트 기능) ──────────────
// 곧 제거 예정. 제거 시: 이 커밋 git revert, 또는 git checkout 4b24f05 -- src/app.ts + scoring.ts/test 삭제.
// 채점 순수 함수는 src/scoring.ts (테스트 가능하게 분리).
const predictions = new Map<string, Pred>(); // userId -> 예측 (인메모리, 재시작 시 초기화)
let started = false; // 예측 오픈 여부. 예측시작 트리거 전엔 접수 안 받음
let answer: Pred | null = null; // 정답(경기 결과). null이면 미발표 = 예측 접수 가능

// 시작 시 안내하는 전체 규칙
const RULES = [
  '⚽️ *대한민국 : 남아공 승부예측 시작!* 가장 못 맞춘 사람이 커피 ☕️',
  '',
  '*참여 방법*',
  '• 예측 제출: `@로지스비 예측 2:1` (대한민국 : 남아공, 점수 0~49)',
  '• 다시 내면 덮어써져요 (최신 예측만 인정)',
  '• 현황 보기: `@로지스비 예측 결과`',
  '',
  '*채점 규칙* (점수가 낮을수록 잘 맞춘 것)',
  '• 승/무/패 결과부터 맞히는 게 우선 (틀리면 큰 감점)',
  '• 같은 결과끼리는 골 수 차이가 적을수록 우위',
  '• 가장 못 맞춘 사람이 커피 ☕️ (동점이면 공동, 모두 동점이면 패스)',
  '',
  '*예시* — 실제 결과가 `대한민국 2 : 1 남아공`(한국 승)이라면',
  '한국 승리를 맞힌 사람은 안전권. 진짜 승부는 *결과를 틀린 사람들끼리* 갈려요:',
  '• `1:1` (무승부 예측) → 결과는 틀렸지만 골 수는 가장 근접 → 그나마 안전',
  '• `1:2` (남아공 1점차 승) → 결과 틀림 + 골 수도 더 빗나감',
  '• `0:3` (남아공 대승 예측) → 결과 틀림 + 골 수 가장 멀리 빗나감 → ☕️ 커피!',
  '즉 결과(승/무/패)부터 맞히는 게 1순위, 틀렸다면 골 수라도 가깝게!',
].join('\n');

function formatBoard(): string {
  if (predictions.size === 0) {
    return '아직 예측이 없어요. "@로지스비 예측 2:1" 형식으로 제출해보세요! (대한민국:남아공)';
  }
  const lines = [...predictions.entries()].map(([uid, p]) => `• <@${uid}> — ${p.home} : ${p.away}`);
  return `⚽️ 대한민국 : 남아공 승부예측 현황 (총 ${predictions.size}명)\n${lines.join('\n')}`;
}

function formatFinal(ans: Pred): string {
  if (predictions.size === 0) return '예측한 사람이 없어요. 커피는 셀프 ☕️';
  const { ranked, losers, allTie } = rankAndFind([...predictions.entries()], ans);
  const lines = ranked.map((r, i) => {
    const mark = losers.includes(r.uid) ? ' ☕️(커피!)' : '';
    return `${i + 1}. <@${r.uid}> — ${r.p.home}:${r.p.away}${mark}`;
  });
  const out = [`🏁 경기 결과: 대한민국 ${ans.home} : ${ans.away} 남아공`, `\n📊 근접 순위`, lines.join('\n')];
  if (allTie) {
    out.push(`\n🤝 모두 동점이라 꼴찌가 없어요! 커피는 패스`);
  } else {
    const tags = losers.map((u) => `<@${u}>`).join(', ');
    out.push(`\n☕️ 커피 쏘는 사람: ${tags}${losers.length > 1 ? ' (공동 꼴찌)' : ''}`);
  }
  return out.join('\n');
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

  // "예측시작" → 예측 오픈 + 규칙 안내 (반드시 "예측" 분기보다 먼저 체크)
  if (text.includes('예측시작') || text.includes('예측 시작')) {
    if (answer) {
      await reply('이미 경기가 끝났어요 🏁 결과는 "@로지스비 예측 결과"로 확인하세요.');
      return;
    }
    if (started) {
      await reply('이미 예측이 진행 중이에요! 예측은 "@로지스비 예측 2:1" 형식으로 제출하세요.');
      return;
    }
    started = true;
    await reply(RULES);
    return;
  }

  // "정답" → 경기 결과 입력, 결과 발표 + 예측 잠금
  if (text.includes('정답')) {
    if (!started) {
      await reply('아직 예측이 시작 안 됐어요. 먼저 "@로지스비 예측시작"!');
      return;
    }
    const ans = parseScore(text);
    if (!ans) {
      await reply('정답은 "@로지스비 정답 2:1" 형식으로! (대한민국:남아공, 점수 0~49)');
      return;
    }
    answer = ans; // 마감 + 잠금
    await reply(formatFinal(ans));
    return;
  }

  // "예측" 키워드가 있을 때만 월드컵 승부예측 모드. 그 외 일반 멘션은 echo.
  if (text.includes('예측')) {
    // "예측 결과/목록" → 현황 출력 (정답 나왔으면 최종 결과)
    if (/결과|목록/.test(text)) {
      await reply(answer ? formatFinal(answer) : formatBoard());
      return;
    }
    // 정답 발표 후엔 예측 접수 잠금
    if (answer) {
      await reply('이미 경기가 끝났어요 🏁 결과는 "@로지스비 예측 결과"로 확인하세요.');
      return;
    }
    // 시작 전엔 접수 안 받음
    if (!started) {
      await reply('아직 예측이 시작 안 됐어요. 먼저 "@로지스비 예측시작"!');
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
    await reply('예측은 "@로지스비 예측 2:1" 형식으로! (대한민국:남아공, 점수 0~49)\n현황은 "@로지스비 예측 결과"');
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
