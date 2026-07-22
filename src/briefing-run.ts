// 모닝 브리핑을 스케줄 대기 없이 즉시 1회 실행한다(검증·수동 실행용).
// 봇 이벤트 루프(Socket Mode)는 띄우지 않고, 게시에 필요한 Slack Web client만 만든다.
// 사용: `npm run briefing`  (BRIEFING_CHANNEL/BRIEFING_NOTION_DB는 .env에서 읽음)
import { WebClient } from '@slack/web-api';
import { runBriefingOnce, hydrateBriefingEnv } from './scheduler.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name}이(가) 없습니다. .env를 확인하세요.`);
  return v;
}

hydrateBriefingEnv(); // .env의 BRIEFING_* 를 process.env에 채운다(셸 우선)
const channel = required('BRIEFING_CHANNEL');
const notionDb = process.env.BRIEFING_NOTION_DB ?? '';
const client = new WebClient(required('SLACK_BOT_TOKEN'));

await runBriefingOnce(client, channel, notionDb);
console.log('브리핑 1회 실행 완료.');
