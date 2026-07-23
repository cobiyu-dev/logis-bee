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
 *
 * 후보를 두 가지 방식으로 만들어 순서대로 파싱을 시도한다:
 *  1) ```json ... ``` (또는 그냥 ``` ... ```) 코드펜스 안의 내용. claude가 답을 펜스로 감싸는 일이
 *     잦은데, 펜스는 JSON의 경계가 명확해 가장 믿을 만하다.
 *  2) 첫 '{'부터 마지막 '}'까지. 펜스가 없을 때의 폴백.
 *
 * 예전엔 2)만 썼는데, JSON 앞뒤 설명 문장에 '{'나 '}'가 하나라도 있으면(예: SQL의 {col})
 * 자르는 범위가 어긋나 파싱이 깨졌다. 그래서 펜스 우선으로 바꿨다.
 */
function extractBlocksJson(s: string): { text?: unknown; blocks?: unknown } | null {
  const candidates: string[] = [];

  // 1) 코드펜스 내부(언어 태그 json/JSON 유무 무관). 여러 펜스가 있으면 전부 후보에 넣는다.
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(s)) !== null) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }

  // 2) 첫 '{' ~ 마지막 '}' (펜스가 없거나 펜스 파싱이 다 실패했을 때의 폴백)
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(s.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as { text?: unknown; blocks?: unknown };
      // text나 blocks 중 하나라도 있어야 slack-format 응답으로 인정 (엉뚱한 JSON 방어)
      if (typeof obj === 'object' && obj !== null && ('text' in obj || 'blocks' in obj)) {
        return obj;
      }
    } catch {
      // 이 후보는 유효한 JSON이 아님 — 다음 후보로
    }
  }
  return null;
}
