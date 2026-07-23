---
name: wms-briefing
description: "WMS 모닝 에러 브리핑을 만든다. 전일 프로덕션을 두 관점으로 본다 — 운영 관점은 Grafana Loki의 진짜 ERROR 로그(무슨 에러가, 총 몇 건, 전날 없던 신규 에러가 있나)로, 성능 관점은 Datadog(레이턴시 p95·트래픽·모니터)으로. 전일 대비 비교를 담아 Notion에 기록하고 Slack 요약을 낸다. Use when: 모닝 브리핑, WMS 에러 브리핑, 데일리 에러 리포트, 전일 에러 요약, wms-briefing 스케줄 실행."
allowed-tools: Read, Bash, Glob, Grep, mcp__datadog-mcp__*, mcp__kakaostyle-mcp-alpha-notion__*
---

# WMS 모닝 에러 브리핑

전일(어제 하루) WMS 프로덕션 에러를 조사해 **동료 시니어 백엔드 개발자가 읽는 SRE 브리핑**을 만든다. 이 스킬은 봇 스케줄러가 매일 아침 자동으로 트리거한다. 순서대로 실행하되, 각 단계의 "왜"를 이해하고 데이터에 맞게 판단한다.

## 대상과 원칙

- **대상 서비스 3개**: `wms`, `wms-3pl`, `logistics-auth`. 환경은 프로덕션(`zigzag-production`)만.
- **로그가 먼저, 지표는 보강**: 무슨 에러가 실제로 찍혔는지는 Grafana Loki 로그 본문에서 직접 본다. 규모·추세·성능처럼 로그만으로 안 보이는 것은 Datadog으로 덧댄다.
- **지어내지 않는다**: 조회한 데이터에 있는 것만 쓴다. 근거 없는 원인은 "가설"로 명시한다.
- **시각은 KST**: 로그·지표 시각을 사용자에게 보여줄 때는 한국시간(KST)으로 바꾼다. 서버 로그는 대개 UTC라 9시간을 더한다. 시각 뒤에 `KST`를 붙인다.

---

## Step 1 — 기간 계산 (어제 하루, KST)

"어제"는 KST 기준 어제 00:00:00 ~ 23:59:59다. **반드시 절대 구간으로 계산한다.** `now-33h now` 같은 상대시간은 오늘 로그까지 섞여 어제 하루를 정확히 못 자른다(검증: now-33h로 조회 시 07-21 에러가 섞여 31건, 07-20 절대구간은 18건). 아래로 어제 하루의 UTC 절대 구간을 만든다.

KST 어제 00:00 = UTC로 그제 15:00, KST 어제 24:00 = UTC로 어제 15:00 이다. macOS `date`로 계산한다:

```bash
FROM="$(date -v-2d +%Y-%m-%d)T15:00:00Z"   # 그제 15:00 UTC = 어제 00:00 KST
TO="$(date -v-1d +%Y-%m-%d)T15:00:00Z"      # 어제 15:00 UTC = 오늘 00:00 KST
YESTERDAY="$(date -v-1d +%Y-%m-%d)"          # 브리핑 제목·표기용
echo "$FROM ~ $TO (대상: $YESTERDAY KST)"
```

이 `FROM`/`TO`를 이후 모든 조회에 시간 인자로 그대로 쓴다. 조회 조건(대상 날짜)은 최종 브리핑 맨 위에 KST로 명시한다.

## Step 1.5 — 배포 시점 확인 (Datadog)

에러·성능 변화의 상당수는 배포가 원인이다. 그래서 먼저 어제 각 서비스가 언제 배포됐는지 확인해, 뒤 분석에서 "이 배포 이후 늘었나"를 볼 수 있게 한다. 배포는 Datadog span의 `@version`(예: `2026.0721.1451-f51221-common`, 앞부분이 빌드 시각)이 바뀐 것으로 안다. Datadog MCP로 가볍게 뽑는다(Grafana 로그 조회보다 간단·정확).

**1) 그날 돈 버전 목록** — `aggregate_spans`를 한 번 호출한다:
- query `env:zigzag-production service:{서비스}`, from/to는 `$FROM`/`$TO`, computes는 COUNT, **group_by fields `["@version"]`**. (facet 이름은 반드시 `@version`, 앞의 `@` 필수.)
- 결과로 그날 등장한 모든 버전과 건수가 나온다.

**2) 새 버전 판별** — 그 목록을 **전날 브리핑에 기록해 둔 버전**과 비교한다. Step 4에서 전날 (Loki) 브리핑을 읽을 때 맨 아래 "현재 버전" 기록(아래 참조)에서 서비스별 버전을 뽑아 둔다. 목록 중 전날에 없던 버전 = 그날 새로 배포된 것.

**3) 배포 시각** — 새 버전마다 `aggregate_spans`를 query `env:zigzag-production service:{서비스} @version:{새버전}`, computes COUNT, **group_by interval `300000`(5분 버킷)**로 호출한다. 결과에서 **건수가 처음 잡히는 버킷**이 배포 시각이다. timestamp는 UTC이니 KST로 9시간 더해 `YYYY/MM/DD HH:MM:SS`로 표기한다. **단 5분 버킷이라 초·분은 그 버킷 시작값이다**(실제 배포는 그 5분 이내). 초를 `00`으로 적되, 정밀 시각이 아니라 근사임을 감안한다(브리핑 독자에게는 분 단위면 충분).

- **첫 실행(전날 (Loki) 브리핑이 없을 때)**: 비교할 전날 버전이 없으니 배포 판정을 **건너뛴다.** 대신 1)에서 나온 버전 중 **마지막(가장 늦게 배포된) 것**을 "현재 버전"으로 기록만 해서(아래) 다음날부터 비교가 되게 한다.
- Datadog 접근이 실패하면 배포 판정을 생략하고 "배포 정보 확인 못 함"을 한 줄 남긴다(브리핑은 계속).

이 배포 이력을 기억해 두고, Step 2·3의 에러·레이턴시를 분석할 때 **발생 시각을 배포 시각과 견준다.** 어떤 예외나 지연이 특정 배포 시각 이후부터 나타나거나 급증했다면, 그 배포가 원인일 가능성을 브리핑에 적는다(단정 말고 가설로). 배포 직후 새 예외가 나타났다면 신규 에러이자 회귀 의심이니 심각도를 올린다.

## Step 2 — Grafana Loki 에러 조회 (운영 관점 주력)

Grafana Loki는 **운영 관점**을 맡는다. "어떤 에러가 실제로 찍혔나, 총 몇 건인가, 전날에 없던 새 에러가 나타났나, 정합성·동시성 문제 신호가 있나"를 본다. 성능(레이턴시·부하)은 Step 3 Datadog이 맡으니 여기서 다루지 않는다.

**진짜 ERROR 로그만 본다.** 로그 본문의 `"log_level":"ERROR"` 를 문자열로 통째 매칭한다. 이유가 둘이다:
- `| json | log_level="ERROR"` 방식도 같은 결과지만, 문자열 매칭이 더 빠르고 JSON 파싱 실패 로그도 안 놓친다.
- 절대 `|= "ERROR"` (ERROR 글자만)로 하지 마라. 한진 API 정상 응답처럼 request/response body에 `resultCode=E...` 같은 ERROR 글자가 든 INFO 로그까지 쓸어담아 과다 집계된다(검증됨: 문자열만 매칭 시 7,682건 vs 실제 ERROR 18건). 반드시 `"log_level":"ERROR"` 필드+값을 통째로 매칭한다.

세 서비스 모두 같은 방식이라 라벨 구조 차이를 신경 쓸 필요 없다. Step 1에서 만든 `$FROM`/`$TO`(어제 하루 절대 구간)를 시간 인자로 쓴다. (이 프로젝트 루트에서 실행. 인증은 CLI가 자동 처리.)

```bash
npm run grafana -- query prod '{app="wms"} |= `"log_level":"ERROR"`' "$FROM" "$TO" 5000
npm run grafana -- query prod '{app="wms-3pl"} |= `"log_level":"ERROR"`' "$FROM" "$TO" 5000
npm run grafana -- query prod '{app="logistics-auth"} |= `"log_level":"ERROR"`' "$FROM" "$TO" 5000
```

> WMS는 비즈니스 예외(`WmsUseCaseException` 등 작업자 입력·검증 실패)를 대부분 WARN으로 로깅한다. 그래서 진짜 ERROR 건수는 작다(예: wms 하루 18건). 이건 정상이다. 작업자 실수성 노이즈를 뺀 "코드가 진짜 문제로 판단한 것"만 보는 게 이 브리핑의 목적이다. WARN·Datadog span 에러(수천 건)와 굳이 숫자를 맞추려 하지 마라.

출력은 `{"env","count","lines":[...]}` JSON이다. 인증이 만료면 CLI가 rotate 또는 Chrome 재로그인으로 자동 복구한다. 그래도 실패하면(예: `{"ok":false,...}`) 아래 "실패 처리"를 따른다.

**운영 관점으로 분석할 것:**
- **총 ERROR 건수 + 서비스별 건수.**
- **전일 대비 신규 에러**: 어제 브리핑(Step 4)에 없던 예외 타입이나 operation이 오늘 나타났는지. 신규는 🔴로 표시한다 — 운영에서 가장 중요한 신호다.
- **예외 타입 + operation 분포**: 같은 예외 타입과 operation끼리 묶어 빈도순 정렬.
- **정합성·동시성 신호**: 락 계열(Optimistic/Pessimistic/Lock wait timeout)은 동시성 경합으로 묶어 경합 엔티티를 추정(가설로 명시). DataIntegrityViolation 등 정합성 훼손은 건수가 적어도 심각도를 올린다.

각 `lines` 원소는 JSON 로그다. `message`(operation·로그인 유저·예외 타입), `logger`·`thread`·`stack_trace`(예외 위치), 그리고 **`dd.trace_id`**(Step 3에서 Datadog과 잇는 열쇠)를 뽑는다.

## Step 3 — Datadog 성능 지표

Datadog은 **성능 관점**을 맡는다. Grafana 로그에는 안 남는, 요청이 얼마나 느렸고 부하가 어땠는지를 본다. 에러 건수는 Step 2 Grafana ERROR가 주력이므로, 여기서 span 에러 수를 다시 세어 주인공으로 삼지 않는다(성격이 달라 숫자가 크게 다르다 — 맞추려 하지 마라).

도구는 `mcp__datadog-mcp__*` 이다. datadog-mcp에 스킬 가이드가 있으면(`list_datadog_skills`/`load_datadog_skill`) 먼저 로드해 쿼리 문법을 맞춘다. 쿼리 필터는 `env:zigzag-production service:(wms OR wms-3pl OR logistics-auth)` 기준. 시간은 Grafana와 같은 어제 하루로 맞춘다 — `from`/`to`에 Step 1의 `$FROM`/`$TO`(ISO8601)를 그대로 넘긴다(`now-24h` 같은 상대시간은 Grafana와 구간이 어긋난다).

성능 관점으로 볼 것:
- **레이턴시(p95)**: `aggregate_spans`로 서비스·resource별 p95. 느린 API 상위. 전일 대비 증감. (웜업용 self 호출 `/graphql/{caller}__` 은 caller가 service명과 같으면 제외.)
- **트래픽 추이**: 시계열로 급증/급감. 에러·레이턴시의 배경 설명.
- **Alert 모니터**: `search_datadog_monitors`로 현재 alert 상태인 프로덕션 모니터.

성능 지표 수집이 실패해도(Datadog 접근 불가 등) 브리핑을 중단하지 않는다. Grafana 운영 지표만으로 브리핑을 만들고, "Datadog 성능 지표는 이번엔 확인 못 함"을 한 줄 남긴다.

**Datadog 링크 확보** — 브리핑에 눌러 볼 링크를 달기 위해, Datadog MCP 응답에 들어오는 URL을 챙긴다. `search_datadog_spans`/`aggregate_spans` 응답에는 explorer URL과 base URL이 있고, 개별 trace는 `<base>/apm/trace/<trace_id>` 형식으로 만든다(trace_id는 Grafana 로그 본문의 `dd.trace_id`에서 얻는다). 성능 섹션 대표 링크로는 그 서비스의 APM 페이지(응답의 explorer/서비스 URL)를 쓴다. URL을 지어내지 말고, MCP가 준 것이나 위 trace 형식만 쓴다.

**두 관점을 잇는 다리 — `dd.trace_id`**: Step 2에서 심각한 ERROR 로그를 골랐는데 그 요청이 왜 느렸는지/무슨 span이 실패했는지 더 파고 싶으면, 그 로그의 `dd.trace_id`로 Datadog을 조회한다(`search_datadog_spans`에 `trace_id:<값>`, 또는 trace URL `<base>/apm/trace/<trace_id>`). 반대로 Datadog에서 유난히 느린 trace를 찾으면 그 `trace_id`로 Grafana 로그(`{app="..."} |= \`<trace_id>\``)를 뒤져 무슨 에러였는지 본다. 매번 하지 말고, 운영·성능 어느 한쪽에서 눈에 띄는 사건을 교차 확인할 때만 쓴다.

## Step 4 — 전일 브리핑과 비교 (Notion 읽기)

어제 만든 브리핑을 읽어 오늘과 비교한다. 무엇이 늘었고 줄었는지, 새로 생겼는지, 해소됐는지를 본다. Notion MCP 도구를 쓴다(`mcp__kakaostyle-mcp-alpha-notion__notion-API-*`).

`BRIEFING_NOTION_DB`는 **데이터베이스가 아니라 일반 페이지**다(스케줄러가 프롬프트로 그 페이지 id를 넘겨준다). 그래서 `post-database-query`를 부르면 "is a page, not a database" 오류가 난다. 반드시 아래처럼 자식 페이지를 뒤진다:

1. `notion-API-get-block-children`로 그 부모 페이지의 자식 블록을 받는다. 브리핑은 `type`이 `child_page`인 블록으로 쌓이고, 제목에 날짜가 들어 있다. **제목에 `(Loki)`가 든 것만** 본다 — 그게 이 브리핑이 어제 만든 것이다. `(Loki)`가 없는 페이지는 n8n이 만든 별개 브리핑(Datadog 기준)이니 비교에 쓰지 마라(측정 기준이 달라 수치가 안 맞는다). `(Loki)` 페이지 중 어제 날짜인 것을 고른다. 목록이 많으면 뒤쪽(최근)부터 본다.
2. 고른 자식 페이지 id로 다시 `notion-API-get-block-children`를 호출해 그 본문을 읽고, 어제 수치(서비스별 에러 수, 어제 있던 예외 타입, 주요 이슈)를 확보한다.

전일 브리핑이 없으면(첫 실행) 비교는 생략하고 "전일 브리핑 없음(첫 브리핑)"으로 둔다.

## Step 5 — 브리핑 구성 (두 관점 + 심각도 판정)

수집한 것을 두 축으로 나눠 정리한다. 하나는 운영 관점(Grafana ERROR 로그), 다른 하나는 성능 관점(Datadog)이다. 두 축을 섞지 말고 각각의 소제목 아래 둔다.

**운영 관점 (Grafana ERROR 로그 기반)** — 이게 브리핑의 중심이다:
- 총 ERROR 건수, 서비스별 건수.
- 🔴 **신규 에러**: 전일 브리핑에 없던 예외 타입·operation. 운영에서 가장 중요하니 맨 앞에 둔다.
- 예외 타입 + operation 분포, 정합성·동시성(락) 신호.

**성능 관점 (Datadog 기반)**:
- 레이턴시 p95 상위·전일 대비 증감, 트래픽 급증/급감, Alert 모니터 상태.

**심각도 기준** (두 관점 공통):
- 🔴 **P0/P1**: 신규 에러 발생, 시스템 예외(알 수 없는 Exception), 정합성 영향(DataIntegrityViolation 등)은 빈도가 낮아도 올린다. 레이턴시 급증도 여기.
- 🟡 **P2**: 지속 관찰 대상. 상시 발생하지만 규모가 크거나 늘고 있는 것.
- 🟢 **P3 또는 해소**: 일시적 예외, 그리고 전일 대비 줄거나 해소된 것.

각 항목이 새로 생긴 것(신규)인지 다시 나타난 것(회귀)인지 함께 적는다. 락 계열은 동시성 경합으로 묶어 서술한다.

## Step 6 — Notion에 저장 (시각적 서식 고정)

브리핑을 Notion 부모 페이지(`BRIEFING_NOTION_DB`) 아래 **새 하위 페이지**로 저장한다.
1. `notion-API-post-page`로 제목만 있는 페이지를 만든다(parent는 `{page_id: BRIEFING_NOTION_DB}`). 제목은 `WMS 모닝 에러 브리핑 (Loki) — {어제 날짜} (KST)`, 심각(🔴) 이슈가 있으면 앞에 🔴.
   - 제목에 **`(Loki)`를 반드시 넣는다.** 같은 부모 페이지에 n8n이 만드는 브리핑(`{날짜} WMS 모닝 에러 브리핑`, Datadog 기준)이 함께 쌓이는데, 식별자가 없으면 같은 날짜에 제목이 겹쳐 중복으로 오인된다. `(Loki)`가 이 브리핑이 로대리의 Grafana ERROR 기준임을 표시한다.
2. 만들어진 페이지 id로 `notion-API-patch-block-children`를 호출해 본문 블록을 채운다(한 번에 최대 100블록).

**서식 규칙은 `references/notion-format.md`를 읽고 그대로 따른다.** 이 Notion MCP는 만들 수 있는 블록이 `paragraph`와 `bulleted_list_item` 둘뿐이라(표·callout·heading 불가) 서식을 그 제약에 맞춰 짜야 한다. 그 파일에 서비스별 구획 구조, 구분선 헤더로 섹션 나누는 법, 중첩 불릿으로 세부를 내리는 법, 항목별 Grafana·Datadog 링크 다는 법이 예시와 함께 있다. 표가 안 된다고 줄글로 늘어놓지 말고, 그 규칙대로 한눈에 들어오게 만든다.

특히 자주 어긋나는 두 형식은 반드시 지킨다:
- 서비스 구분선 헤더는 `━━━━  {이모지} {서비스}  —  이슈  ━━━━` 형태다. 건수를 헤더에 넣지 마라("ERROR 31건" 아님, 그냥 "이슈").
- ERROR 예외 부모 불릿은 `[ERROR]`로 시작한다(`[운영]` 아님). 성능 항목은 `[성능]`.

저장에 성공하면 페이지 URL을 확보한다. 실패하면 브리핑을 버리지 말고, Slack 요약에 "Notion 저장 실패"를 한 줄 남긴 뒤 계속 진행한다.

## Step 7 — Slack 요약 출력

**이게 최종 출력이다.** 봇 스케줄러가 네 stdout에서 Slack blocks JSON을 뽑아 채널에 게시한다. 그러니 마지막 출력은 slack-format 스킬 규칙에 따른 `{text, blocks}` JSON이어야 한다.

**Slack은 아주 짧게 간추린다.** 목적은 "오늘 내가 봐야 할 게 있나?"를 몇 초 안에 판단하게 하는 것이다. 자세한 내용은 전부 Notion에 있으니, Slack에는 **심각한 것과 어제와 달라진 것만** 남기고 나머지는 과감히 뺀다. 정상·상시 정보(느린 API 전체 나열, P2·P3 상세, "모니터 모두 OK" 같은 이상 없음 신호)를 Slack에 늘어놓지 마라 — 그게 장황함의 원인이다.

담을 것(이 정도면 충분하다):
- **한 줄 총평**: 심각도 이모지 + 핵심 한 문장. 예: `🟡 어제 WMS 조용한 편, 신규 에러 없음. 락 경합만 지속 관찰.`
- **서비스별 ERROR 건수**: 한 줄로 압축. 예: `ERROR  wms 18 · wms-3pl 0 · logistics-auth 0`
- **배포 (그날 새 배포가 감지됐을 때만 넣는다)**: 새 배포가 하나도 없으면 이 블록을 **통째로 생략한다**(Slack은 간결이 목적이라 "배포 없음"도 안 적는다). 새 배포가 있으면 `*🚀 새 배포*` 제목 아래 배포된 서비스만 계층으로 적는다. Slack mrkdwn은 리스트 전용 문법이 없으니 `•`(서비스)와 공백 4칸 `◦`(배포)로 흉내낸다. **시각은 `YYYY/MM/DD HH:MM:SS` 전체로 쓰고 "신규버전 배포" 설명을 붙인 뒤 버전 태그를 뒤에** 둔다. 그리고 **배포 전후 변화를 한 줄** 덧붙인다(핵심 — 배포가 문제를 만들었는지가 궁금한 거니까). 예:
  ```
  *🚀 새 배포*
  • wms
      ◦ 2026/07/21 12:15:00 신규버전 배포 — 2026.0721.1153-5c1a81-common
      ◦ 2026/07/21 15:30:00 신규버전 배포 — 2026.0721.1451-f51221-common
  배포 후 ERROR 9건 → 22건 증가. 배포 후 신규: WmsUseCaseException(재고 없음).
  ```
  전후 변화가 미미하면 `배포 전후 뚜렷한 변화 없음`으로.
- **🔴 신규 에러**: 있을 때만 넣는다(운영에서 가장 중요). 없으면 총평의 "신규 없음"으로 갈음하고 별도 줄을 만들지 않는다.
- **🔴 P0/P1만**: 즉시 볼 것만. 🟡 P2와 🟢 P3는 Slack에 넣지 않는다(Notion에 있다).
- **성능은 이상이 있을 때만 한 줄**: 레이턴시 급증이나 Alert 발생이 있으면 그것만. 다 정상이면 넣지 않는다.
- **맨 아래 Notion 링크**: `전체 브리핑 보기`.

즉 조용한 날이면 Slack은 3~4줄로 끝난다. 심각한 날만 🔴 항목이 붙어 길어진다. 상세 근거(스택트레이스, 전체 예외 목록, 모든 레이턴시 수치)는 Notion에 두고 Slack엔 절대 넣지 않는다.

---

## 실패 처리 (silent skip 금지)

어느 단계든 실패하면 조용히 넘어가지 않는다. 무엇이 왜 실패했는지 Slack 요약에 한 줄로 남긴다. 운영자가 브리핑을 못 봤는지, 봤는데 조용한 날이었는지 구분되어야 한다.

- **Grafana 인증/조회 실패**: `{"ok":false,...}`나 반복 에러면, 세 서비스 중 되는 것만으로 브리핑하고 실패한 서비스를 명시. 셋 다 실패면 "Grafana 조회 실패 — 브리핑 불가"를 Slack에 낸다.
- **에러 0건**: 정상이다. "어제 프로덕션 에러 없음(조용한 하루)"을 짧게 낸다.
- **Datadog/Notion 실패**: 위 각 단계 설명대로 브리핑은 계속하고 실패 사실만 남긴다.
