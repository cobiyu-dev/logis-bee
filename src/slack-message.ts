import type { types as slackTypes } from '@slack/bolt';

type KnownBlock = slackTypes.KnownBlock;

/**
 * claude 출력에서 Slack 메시지를 뽑아낸다.
 * slack-format 스킬이 동작하면 {text, blocks} JSON이 오고, 아니면 그냥 텍스트가 온다.
 *
 * claude가 JSON 앞에 설명 문장을 붙이거나 ```json 코드펜스로 감싸는 경우가 잦다.
 * 그래서 맨 앞 글자만 보지 않고, 출력에서 가장 바깥 {...} 덩어리를 찾아 파싱을 시도한다.
 * 그래도 유효한 blocks JSON이 아니면 원문을 통째로 text로 쓴다 (안전한 폴백 — 빈 응답 방지).
 */
export function toSlackMessage(raw: string): { text: string; blocks?: KnownBlock[] } {
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
