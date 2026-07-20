---
name: slack-format
description: 최종 답변을 Slack에 보기 좋게 보내기 위해 Slack Block Kit JSON으로 변환한다. 이 프로젝트의 봇은 답변을 Slack 메시지로 전송하므로, 사용자에게 내보내는 마지막 답변을 만들 때 사용한다. Use when 답을 Slack으로 보낼 때, Slack 메시지, 슬랙 응답, 가독성 좋은 답변, Block Kit, 로그 조회 결과를 슬랙에 정리해 보여줄 때.
---

# Slack 응답 포맷 변환

## 이 스킬을 언제 쓰는가

이 프로젝트는 Slack 봇이다. `--print` 모드로 실행된 네 최종 출력(stdout)이 그대로 Slack 메시지로 전송된다.
따라서 **사용자에게 내보내는 마지막 답변**은 일반 마크다운이 아니라 Slack이 이해하는 형식이어야 한다.

로그 조회, 에러 분석 등 다른 스킬로 작업을 끝낸 뒤, 그 결과를 사용자에게 보여줄 때 이 규칙을 따라 최종 출력을 만든다.

## 출력 형식 (가장 중요)

네 stdout은 사람이 읽는 글이 아니라, 봇이 슬랙에 그려 넣을 데이터다. 봇은 stdout에서 아래 형태의 JSON을 찾아 그 `blocks`만 슬랙에 렌더링한다.

```json
{
  "text": "알림·검색·접근성용 한 줄 요약 (Slack 알림에 뜨는 폴백 텍스트)",
  "blocks": [ ... Block Kit 블록 배열 ... ]
}
```

- `text`: Slack 푸시 알림에 뜨는 대체 텍스트다. 블록이 렌더링 안 될 때만 화면에 보인다. 한 줄 요약으로 채운다. 반드시 넣는다.
- `blocks`: 실제로 화면에 렌더링되는 배열이다. 최대 50개.

답이 아주 짧아 블록이 과하면 `blocks`를 빼고 `{"text": "..."}`만 내도 된다.

### 분석·설명은 JSON 밖이 아니라 blocks 안에 담아라

너는 "먼저 무엇을 찾았는지 서술하고 그다음 결론"이라는 순서로 말하고 싶을 것이다. 그 서술은 가치가 있다. 다만 **JSON 바깥에 쓴 글자는 사용자에게 보이지 않고 버려진다.** 봇은 blocks만 슬랙에 그리기 때문이다. 그러니 하고 싶은 설명이 있으면 JSON 밖에 쓰지 말고, `section` 블록으로 만들어 blocks 안에 넣어라. 그래야 사용자가 실제로 읽는다.

- JSON 앞에 "32건을 확인했습니다. 분류하면…" 같은 서술을 붙이지 마라. 그 내용은 `section` 블록으로 옮겨라.
- "이제 Slack 형식으로 출력합니다" 같은 메타 문장은 아무 값이 없으니 쓰지 마라.
- 코드펜스(```)로 JSON을 감싸지 않아도 된다. 감싸든 안 감싸든 봇은 JSON을 찾아내지만, 안 감싼 순수 JSON이 가장 깔끔하다.

정리하면: **하고 싶은 말은 전부 blocks 안에서 하고, JSON 하나로 답을 끝내라.** 이상적인 출력은 첫 글자가 `{`이고 마지막 글자가 `}`인, 설명 없는 JSON 하나다.

## Slack mrkdwn 문법 (일반 마크다운과 다르다 — 반드시 지킬 것)

`section` 블록의 `text.type`가 `mrkdwn`일 때 아래 문법을 쓴다. **일반 마크다운을 그대로 쓰면 깨진다.**

| 하려는 것 | 일반 마크다운 (쓰지 마라) | Slack mrkdwn (이렇게) |
|---|---|---|
| 굵게 | `**볼드**` | `*볼드*` (별표 하나) |
| 기울임 | `*이탤릭*` | `_이탤릭_` |
| 취소선 | `~~취소~~` | `~취소~` (물결 하나) |
| 링크 | `[텍스트](url)` | `<url|텍스트>` |
| 인라인 코드 | `` `코드` `` | `` `코드` `` (동일) |
| 코드블록 | ` ```코드``` ` | ` ```코드``` ` (동일, 언어명은 무시됨) |
| 인용 | `> 인용` | `> 인용` (동일) |
| 목록 | `- 항목` | `- 항목` 또는 `• 항목` (전용 문법 없음, 줄바꿈으로 나열) |

**지원하지 않는 것 (쓰면 깨진다):**
- **표(table)를 절대 쓰지 마라.** 표로 보여주고 싶으면 각 행을 `section` 블록이나 코드블록의 정렬된 텍스트로 표현한다.
- `#`, `##` 같은 제목 문법 → 제목은 `header` 블록으로 표현한다.
- 중첩 마크다운(굵게 안에 링크 등)은 불안정하니 피한다.

## 자주 쓰는 블록

**header** — 제목. `plain_text`만 되고 마크다운/이모지 문법 안 됨. 최대 150자.
```json
{ "type": "header", "text": { "type": "plain_text", "text": "에러 로그 3건", "emoji": true } }
```

**section** — 본문. `mrkdwn` 최대 3000자.
```json
{ "type": "section", "text": { "type": "mrkdwn", "text": "*10:03* `NullPointerException`\n주문 생성 중 발생" } }
```

**section + fields** — 2열 표처럼 보이는 요약. 각 필드 최대 2000자, 최대 10개.
```json
{ "type": "section", "fields": [
  { "type": "mrkdwn", "text": "*서비스*\norder-api" },
  { "type": "mrkdwn", "text": "*건수*\n42" }
] }
```

**divider** — 구분선.
```json
{ "type": "divider" }
```

**context** — 작고 흐린 회색 글씨. 출처, 시각, 쿼리 조건, 로거 이름처럼 **곁다리 메타정보에만** 쓴다.
```json
{ "type": "context", "elements": [ { "type": "mrkdwn", "text": "조회 범위: 최근 1시간 · env=prod" } ] }
```

**context를 남용하지 마라.** 사용자가 실제로 읽고 행동해야 하는 내용은 절대 context에 넣지 않는다.
구체적으로 아래 것들은 context가 아니라 `section`으로 내고, 앞에 `*권장 확인*` 같은 볼드 소제목을 붙인다.
- 권장 조치, 다음 할 일, 확인 요청 (예: "권장 확인: ...")
- 결론, 요약, 원인 판단
- 사용자가 눈여겨봐야 할 핵심 정보

context는 "있으면 참고, 없어도 그만"인 정보에만 쓴다. 조치 항목을 흐린 글씨로 내면 본문과 서식이 어긋나 어색해 보인다.

## 길이·개수 한도 (넘으면 Slack이 거부한다)

- 블록: 메시지당 최대 50개
- section `mrkdwn` 텍스트: 3000자
- header `plain_text`: 150자
- 로그가 아주 많으면 전부 나열하지 말고 대표 몇 건 + "외 N건" 으로 요약한다.

## 완성 예시

로그 조회 결과를 정리한 최종 출력의 예:

```json
{
  "text": "order-api 에러 로그 3건 (최근 1시간)",
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "🚨 에러 로그 3건", "emoji": true } },
    { "type": "context", "elements": [ { "type": "mrkdwn", "text": "service=order-api · env=prod · 최근 1시간" } ] },
    { "type": "divider" },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*10:03:12* `NullPointerException`\n주문 생성 중 사용자 주소가 null" } },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*10:07:45* `TimeoutException`\n결제 API 응답 5초 초과" } },
    { "type": "divider" },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*권장 확인*\n(1) 사용자 주소 null 허용 케이스 검토 (2) 결제 API 응답 지연 원인 확인" } },
    { "type": "context", "elements": [ { "type": "mrkdwn", "text": "logger: OrderService · 표시 안 된 로그 외 1건" } ] }
  ]
}
```

위 예시에서 *권장 확인*은 사용자가 읽고 행동할 내용이라 `section` + 볼드 소제목으로 냈고,
맨 아래 로거 이름과 "외 1건" 같은 곁다리만 `context`(흐린 글씨)로 뒀다. 이 구분을 지켜라.
