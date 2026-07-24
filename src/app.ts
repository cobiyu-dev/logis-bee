import { App, LogLevel } from '@slack/bolt';
import { runClaude } from './executor.js';
import { toSlackMessage } from './slack-message.js';
import { startScheduler } from './scheduler.js';
import { buildProjectsContext, loadCodeProjects } from './code-projects.js';
import { syncProjects } from './git-sync.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}이(가) 없습니다. .env를 확인하세요.`);
  return v;
}

/**
 * 스레드의 이전 대화를 읽어 claude에게 넘길 맥락 문자열로 만든다.
 * "좀 더 자세하게" 같은 후속 멘션은 앞 대화를 알아야 뜻이 통하므로, 스레드 전체를 시간순으로 넘긴다.
 *
 * - `excludeTs`(이번 멘션)는 중복·잡음이라 뺀다.
 * - 봇 메시지(`bot_id` 있음)는 "로대리", 사람은 "사용자"로 라벨링해 누가 무슨 말을 했는지 구분한다.
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
    const who = m.bot_id ? '로대리(너의 이전 답변)' : '사용자';
    lines.push(`[${who}]\n${body}`);
  }
  return lines.join('\n\n');
}

/**
 * 멘션한 사람의 직함·표시이름을 읽어, claude가 답변 눈높이를 맞추도록 넘길 한 줄 컨텍스트를 만든다.
 * 사내 프로필의 title/display_name에 소속 파트가 드러난다(예: "배송&물류BE파트 매니저", "물류기획팀 팀장").
 * 개발 직군(BE/FE 등)이면 기술적 깊이를, 물류 기획·운영 직군이면 실무 관점을 우선하라는 판단은 claude에게 맡긴다.
 * 조회 실패나 정보 없음이면 빈 문자열 → 직군 힌트 없이 평소대로 답한다.
 */
async function buildRequesterContext(client: App['client'], userId: string | undefined): Promise<string> {
  if (!userId) return '';
  const res = await client.users.info({ user: userId });
  const p = res.user?.profile;
  const title = p?.title?.trim();
  const display = p?.display_name?.trim();
  if (!title && !display) return '';
  const parts = [display && `표시이름: ${display}`, title && `직함: ${title}`].filter(Boolean);
  return parts.join(', ');
}

// 이모지 트리거(👀). 오더비 등 다른 봇과 겹치지 않게. 바꾸려면 이 줄만 수정.
const TRIGGER_EMOJI = 'eyes';

// 멘션 처리 중임을 태그된 원본 메시지에 표시하는 로딩 이모지. 완료되면 뗀다.
// 워크스페이스에 등록된 커스텀 이모지 이름(콜론 없이).
const LOADING_EMOJI = process.env.LOADING_EMOJI ?? 'loading2';

const app = new App({
  token: required('SLACK_BOT_TOKEN'), // xoxb-
  appToken: required('SLACK_APP_TOKEN'), // xapp-
  socketMode: true, // Socket Mode = PC가 Slack으로 아웃바운드 WebSocket을 연다
  // INFO 기본. WebSocket 원문까지 보려면 SLACK_LOG_LEVEL=debug로 켠다.
  // (DEBUG로 두면 채널의 다른 봇 메시지·재시도까지 원문이 쏟아져 [mention] 로그가 묻힌다.)
  logLevel: process.env.SLACK_LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// 전역 에러 핸들러 — 핸들러/소켓 에러를 콘솔에서 확인
app.error(async (err) => {
  console.error('[app.error]', err);
});

// 1) 멘션: @로대리 ... → claude CLI에 위임해 스킬(rodaeri-loki 등)로 답변
app.event('app_mention', async ({ event, client, logger }) => {
  const text = event.text.replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '').trim(); // <@U123> / <@U123|name> 모두 제거
  const threadTs = event.thread_ts ?? event.ts;
  logger.info(`[mention] user=${event.user} ch=${event.channel} text=${text}`);

  if (!text) {
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: '무엇을 도와드릴까요?' });
    return;
  }

  // 처리에 수십 초 걸린다. 임시 메시지를 보내 교체하는 대신, 태그한 원본 메시지에
  // loading 이모지를 달아 "처리 중"임을 표시하고, 완료되면 답변을 새 메시지로 보낸 뒤
  // 이모지를 뗀다. (이모지가 안 달려도 답변 흐름은 그대로 진행하도록 실패를 삼킨다.)
  await client.reactions
    .add({ channel: event.channel, timestamp: event.ts, name: LOADING_EMOJI })
    .catch((e) => logger.warn(`[mention] 로딩 이모지 부착 실패(무시): ${e instanceof Error ? e.message : e}`));

  // 스레드 안 멘션이면 이전 대화를 읽어 맥락으로 넘긴다("좀 더 자세하게" 같은 후속 요청 이해).
  // 이번 멘션은 맥락에서 제외한다.
  let context = '';
  try {
    context = await buildThreadContext(client, event.channel, threadTs, [event.ts]);
  } catch (e) {
    logger.warn(`[mention] 스레드 맥락 읽기 실패(맥락 없이 진행): ${e instanceof Error ? e.message : e}`);
  }

  // 멘션한 사람의 직군을 읽어 답변 눈높이를 맞추게 한다. 조회 실패는 삼키고 힌트 없이 진행.
  let requester = '';
  try {
    requester = await buildRequesterContext(client, event.user);
  } catch (e) {
    logger.warn(`[mention] 질문자 프로필 읽기 실패(직군 힌트 없이 진행): ${e instanceof Error ? e.message : e}`);
  }

  // 읽을 수 있는 사내 프로젝트 목록. 멘션마다 로드해 파일 수정·경로 존재를 매번 반영한다.
  const projects = loadCodeProjects();
  const projectsContext = buildProjectsContext(projects);

  // 코드를 읽기 전에 각 프로젝트를 remote main 최신으로 맞춘다(CODE_SYNC=1일 때만 동작).
  // 실패해도 답변은 진행 — 최신화 여부·결과는 프롬프트로 claude에 알려 감안하게 한다.
  let syncContext = '';
  try {
    const sync = await syncProjects(projects);
    syncContext = sync.context;
    if (sync.results.length > 0) {
      logger.info(`[mention] 코드 최신화: ${sync.results.map((r) => `${r.name}=${r.status}`).join(', ')}`);
    }
  } catch (e) {
    logger.warn(`[mention] 코드 최신화 실패(그대로 진행): ${e instanceof Error ? e.message : e}`);
  }

  // 프롬프트 조립: 프로젝트 안내 → 최신화 결과 → 직군 힌트 → 이전 대화 → 새 요청 순. 없는 조각은 건너뛴다.
  const sections: string[] = [];
  if (projectsContext) {
    sections.push(projectsContext);
  }
  if (syncContext) {
    sections.push(syncContext);
  }
  if (requester) {
    sections.push(
      `이 질문을 한 사람의 사내 프로필이다. 직함·표시이름의 소속 파트를 보고 아래 세 직군 중 하나로 판단해, 답변 눈높이를 맞춰라.\n` +
        `- 개발자: 소속에 BE, FE, 백엔드, 프론트엔드처럼 개발 세부 직무가 드러난다(예: 배송&물류BE파트, 파트너플랫폼FE팀). 기술적 깊이를 조금 더 섞어 답한다.\n` +
        `- PO: 개발계 조직이지만 BE/FE 같은 세부 개발 표시가 없다(예: 물류시스템팀). 개발 지식과 물류 지식을 모두 어느 정도 갖추고 개발자와 물류 기획 사이에서 정책을 조율하는 직군이다. 기술과 물류 실무를 균형 있게 짚어준다.\n` +
        `- 비개발(물류 기획·운영): 소속에 기획, 운영 등이 드러난다(예: 물류기획팀, 물류운영혁신파트). 물류 실무에 밀접한 관점으로 쉽게 설명한다.\n` +
        `애매하면 PO로 간주한다.\n<질문자>\n${requester}\n</질문자>`,
    );
  }
  if (context) {
    sections.push(
      `아래는 이 슬랙 스레드의 이전 대화다. 사용자의 새 요청은 이 맥락을 이어받은 것이니 참고해서 답해라.\n<이전 대화>\n${context}\n</이전 대화>`,
    );
  }
  sections.push(sections.length > 0 ? `<새 요청>\n${text}\n</새 요청>` : text);
  const prompt = sections.join('\n\n');

  // 등록된 프로젝트 경로를 --add-dir로 열어 claude가 소스를 읽게 한다(유도용 — 물리적 차단은 아님).
  const result = await runClaude(prompt, { extraDirs: projects.map((p) => p.path) });

  if (!result.ok) {
    // 실패 원인을 봇 로그에 남긴다. claude가 stderr 없이 non-zero로 죽는 일이 있어(종료 코드 1 등),
    // 사용자에게 보이는 안내문만으론 사후 추적이 안 된다. 죽기 직전 stdout(output)에 힌트가 찍히는
    // 경우가 많으니 error와 output을 함께 남겨 다음 실패 때 원인을 잡을 수 있게 한다.
    logger.warn(`[mention] claude 실패: error=${result.error}\noutput(마지막 500자)=${result.output.slice(-500)}`);
    // error 문자열은 사용자에게 그대로 보여줄 안내문이다(executor에서 친절히 작성). 코드블록으로
    // 감싸지 않고 일반 텍스트로 보내 여러 줄 안내가 잘 읽히게 한다.
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: result.error,
    });
  } else {
    // claude가 slack-format 스킬로 blocks JSON을 냈으면 blocks로, 아니면 text로 전송.
    const msg = toSlackMessage(result.output);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: msg.text, // blocks가 있어도 알림용 폴백으로 항상 필요
      blocks: msg.blocks,
    });
  }

  // 성공·실패와 무관하게 로딩 이모지를 뗀다.
  await client.reactions
    .remove({ channel: event.channel, timestamp: event.ts, name: LOADING_EMOJI })
    .catch((e) => logger.warn(`[mention] 로딩 이모지 제거 실패(무시): ${e instanceof Error ? e.message : e}`));
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
  // subtype 있는 메시지(bot_message·file_share·message_changed 등)와 봇이 올린 메시지는
  // 조용히 무시한다. 로그도 남기지 않는다 — 채널의 다른 봇/자기 자신이 올린 파일·알림이
  // 여기로 쏟아져 로그를 도배하고 echo 루프를 만들 수 있어서다. 우리가 처리할 건 사람이 보낸
  // 순수 메시지(주로 DM)뿐이다.
  if (event.subtype || 'bot_id' in event) return;
  // 여기서 event는 GenericMessageEvent로 좁혀짐. text는 optional이라 undefined 가능 → ?? '' 처리
  const text = event.text ?? '';
  if (event.channel_type !== 'im') return; // 채널 일반 메시지는 관심 없음(멘션으로만 부른다)
  logger.info(`[message] DM ch=${event.channel} text=${text}`);
  await client.chat.postMessage({ channel: event.channel, text: `DM 받았어요 (echo): ${text}` });
});

await app.start(); // top-level await (ESM) — WebSocket 연결 수립
console.log('⚡️ Slack 이벤트 수신 대기 중 (Socket Mode)');

// 매일 아침 WMS 모닝 에러 브리핑을 자동 게시하는 스케줄러 기동.
// BRIEFING_CHANNEL이 없으면 스케줄러 안에서 조용히 비활성(경고 로그만).
startScheduler(app.client);
