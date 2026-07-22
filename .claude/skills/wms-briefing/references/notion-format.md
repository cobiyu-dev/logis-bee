# Notion 브리핑 서식 규칙

이 Notion MCP(`kakaostyle-mcp-alpha-notion`)의 블록 생성에는 제약이 크다. 아래 규칙을 지켜야 한눈에 들어오는 페이지가 나온다.

## 쓸 수 있는 블록은 두 가지뿐

`patch-block-children`은 **`paragraph`와 `bulleted_list_item` 두 타입만** 받는다. `table`·`callout`·`heading`·`toggle`·`divider`는 만들 수 없다(도구 스키마 제약, 검증됨). 표를 쓰려 하지 말고, 그 두 블록만으로 아래처럼 구성한다.

- **섹션 헤더**: heading이 없으므로 `paragraph`에 구분선 문자를 넣어 대신한다. 예: `━━━━━━━━━━  🖥 wms  —  이슈  ━━━━━━━━━━`
- **섹션 사이 여백**: `rich_text`가 빈 `paragraph`(빈 줄)를 하나 넣어 띄운다. 붙어 있으면 답답하다.
- **중첩 나열(핵심)**: 한 항목에 여러 세부를 쉼표로 욱여넣지 마라. 부모 `bulleted_list_item`을 만든 뒤, 그 블록 id로 다시 `patch-block-children`를 호출해 자식 `bulleted_list_item`을 붙이면 중첩 리스트가 된다(검증됨). 부모엔 "이름·제목"만, 자식에 세부(수치·원인·operation)를 내린다.

## patch 호출을 최소화한다 (타임아웃 방지)

`patch-block-children`는 한 번에 **여러 블록을 배열로** 받는다. 블록 하나에 한 번씩 호출하지 말고, 같은 부모에 들어갈 블록은 **모아서 한 번에** 넣는다. 호출 수가 많으면 Notion이 느린 날 전체가 타임아웃으로 실패한다(실제 발생함). 원칙:

- **최상위 블록은 한 번에**: 총평·조회구간·빈줄·모든 서비스 구분선 헤더·모든 예외 부모 불릿·성능 부모 불릿·종합 판정까지, 페이지 최상위에 놓일 블록을 한 배열로 만들어 페이지 id에 **1회** patch한다(최대 100블록이라 대개 한 번에 들어간다).
- **자식도 부모당 한 번에**: 각 예외 부모의 자식(operation 불릿들 + Grafana 링크 + Datadog 링크)을 한 배열로 모아 그 부모 id에 **1회**만 patch한다. operation마다, 링크마다 따로 호출하지 마라.
- 결과적으로 patch 횟수는 대략 "1(최상위) + 자식 있는 부모 수" 로 줄어든다.

중첩 나열 예:

```
- ObjectOptimisticLockingFailureException 5건 — 동시 갱신 경합(가설)
    - AssignFcWorkerPackingTote
    - CreateWorkflowMultiShippingCompanyList ×2
    - AssignOrderAssortingWorkTote
- CreateWorkflowMultiShippingCompanyList
    - p95 11.1초 (전일 21.1초 → 개선)
- OrderStockProvider.allocateOrderStock
    - p95 15.3초 (전일 38.4초 → 개선, 여전히 느림, 관찰)
```

부모 블록 텍스트는 나중에 수정하기 번거롭다(이 MCP는 블록 텍스트를 그 자리에서 수정하는 게 잘 안 된다). 그러니 부모 불릿은 처음 만들 때 완성된 문장으로 만든다.

## 링크 다는 법

`bulleted_list_item`이나 `paragraph`의 `rich_text` 원소에 `text.link.url`을 넣으면 그 글자가 하이퍼링크가 된다. 예:

```json
{"type":"bulleted_list_item","bulleted_list_item":{"rich_text":[
  {"type":"text","text":{"content":"🔗 Grafana 로그 열기","link":{"url":"https://grafana.zigzag.in/explore?left=..."}}}
]}}
```

Grafana URL은 반드시 `npm run grafana -- link ...`가 출력한 것을 그대로 쓴다(직접 인코딩하지 마라). Datadog URL은 MCP 응답의 것이나 `<base>/apm/trace/<trace_id>` 형식만 쓴다. **URL을 지어내지 마라** — 없으면 링크를 생략한다.

링크는 **그 항목(예외·resource) 부모 불릿의 자식 불릿**으로 붙인다. 부모 불릿 id로 `patch-block-children`를 호출해 링크 자식을 넣으면 된다(수치 자식과 같은 레벨). 여백용 빈 문단의 자식으로 붙이지 마라 — 엉뚱한 곳에 들여쓰기된다. 링크 텍스트는 오타 없이 정확히: `🔗 이 에러 로그 보기`, `🔗 이 API Datadog에서 보기`.

## 본문 구조 — 서비스별로 나눈다

전체를 서비스별 구획으로 나눈다. 순서와 형태:

1. **총평 paragraph** 1개 — 맨 앞에 그날 최고 심각도 이모지(🔴 또는 🟡 또는 🟢)를 붙이고 한 줄 총평. 어제 배포가 있었고 그 뒤 에러·성능이 늘었다면 총평에 한 마디 넣는다(예: "16시 배포 후 반품 API 락 경합 급증").
2. **조회 구간 paragraph** — `조회 구간: {어제} 00:00~24:00 KST · env=zigzag-production`.
3. **배포 섹션** — 구분선 헤더 `━━━━  🚀 배포  ━━━━` 아래에 서비스별로 부모 불릿을 만들고, 그 자식으로 배포를 적는다. **배포 일시를 앞에(`YYYY/MM/DD HH:MM:SS`), 그 뒤에 설명, 맨 뒤에 버전 태그** 순으로. 형식:
   - 서비스 부모 불릿(`{서비스}`) 아래 자식:
     - 직전 버전: `{배포일 YYYY/MM/DD} 직전 배포 — {version}` — 전날 브리핑 "현재 버전"에서 가져온 값(시각까지는 모르면 날짜만).
     - 그날 새 배포가 있으면 각 새 버전을 `{YYYY/MM/DD HH:MM:SS} 신규버전 배포 — {version}` 로 추가.
   - 예:
     ```
     🚀 배포
     • wms
         ◦ 2026/07/19 직전 배포 — 2026.0719.1153-5c1a81-common
         ◦ 2026/07/21 12:15:00 신규버전 배포 — 2026.0721.1153-5c1a81-common
         ◦ 2026/07/21 15:30:00 신규버전 배포 — 2026.0721.1451-f51221-common
     • logistics-auth
         ◦ 2026/07/19 직전 배포 — 2026.0719.1153-5c1a81-common (변동 없음)
     ```
   그날 어느 서비스에도 새 배포가 없으면 이 섹션은 각 서비스의 직전 버전만 나열한다(신규버전 배포 줄 없음).
4. 빈 줄.
5. **서비스별 블록** (wms, wms-3pl, logistics-auth 순. 데이터가 없어도 순서는 유지):
   - 구분선 헤더 paragraph: `━━━━  {이모지} {서비스}  —  이슈  ━━━━`
   - **그 서비스에 그날 새 배포가 있었으면**, 첫 부모 불릿으로 `[배포 전후]`를 넣고 자식에 배포 시각을 경계로 나눈 변화를 적는다. 배포가 여러 번이면 **마지막 배포 시각**을 경계로, 전 구간(`$FROM`~경계)과 후 구간(경계~`$TO`)으로 나눈다.
     - **반드시 CLI count로 정확히 센다. 표본(lines)을 눈대중하지 마라** — 5000줄 표본은 실행마다 흔들려 "전후 지속"과 "배포 후 급증"이 뒤바뀐다(실제 겪음). 각 예외 타입마다 두 구간을 `query`로 세되, 세 번째 인자(maxLines)를 크게(예: 30000) 줘 잘림을 막고 `count`만 읽는다:
       ```bash
       # 배포 전
       npm run grafana -- query prod '{app="{서비스}"} |= `"log_level":"ERROR"` |= `{예외타입}`' "$FROM" "{경계시각}" 30000
       # 배포 후
       npm run grafana -- query prod '{app="{서비스}"} |= `"log_level":"ERROR"` |= `{예외타입}`' "{경계시각}" "$TO" 30000
       ```
       주요 예외 타입별로 `{예외}: 배포 전 N건 → 후 M건`을 적는다. 전체 ERROR도 예외 필터 없이 같은 방식으로 `ERROR 합계: 전 N → 후 M`.
     - `레이턴시(주요 API): 배포 전 p95 → 후 p95` (Step 3 Datadog aggregate를 두 구간으로.)
     - **배포 후 건수가 배포 전보다 뚜렷이 늘거나(예: 1→10), 배포 후에만 나타난 예외**가 있으면 `🔴 배포 후 급증/신규: {예외}` 로 짚고 회귀 의심으로 심각도를 올린다.
     - 전후 차이가 미미하면 `배포 전후 뚜렷한 변화 없음` 한 줄로.
   - 새 배포가 없는 서비스는 이 `[배포 전후]` 블록을 넣지 않는다.
   - `[ERROR]` **예외 타입마다 하나씩** 부모 불릿으로 넣는다. 서로 다른 예외 타입을 한 부모로 묶지 마라 — 예외 타입별로 링크가 달라지기 때문이다(예: ObjectOptimisticLockingFailureException과 Lock wait timeout은 별도 부모, 각자 링크). 부모 앞에 심각도 이모지, 부모 텍스트에 예외 타입·건수·원인 가설. 신규 에러는 맨 위에 `🔴 신규`로. operation 자식 불릿을 먼저 나열한 뒤, **그 부모의 자식 불릿으로 Grafana 링크와 Datadog trace 링크를 둘 다 단다**(항목마다 자기 링크 한 쌍):
     - **Grafana 링크** — `npm run grafana -- link prod '{app="{서비스}"} |= \`"log_level":"ERROR"\` |= \`{예외타입}\`' "$FROM" "$TO"`로 URL을 받는다. 예외 타입 문자열을 `|=` 필터로 하나 더 넣는 게 핵심 — 그래야 눌렀을 때 그 예외 로그만 보인다. 링크 텍스트는 `🔗 Grafana 로그 보기`.
     - **Datadog trace 링크** — 그 예외의 실제 trace로 간다. `search_datadog_spans`를 `env:zigzag-production operation_name:servlet.request service:{서비스} @span.kind:server @graphql.error.type:{예외타입}` 쿼리로 호출하고, **응답에 오는 `traces_explorer_url`을 그대로** 링크로 쓴다(URL을 손으로 만들지 마라). 링크 텍스트는 `🔗 Datadog trace 보기`. `@graphql.error.type` 값은 패키지 뺀 짧은 예외명(예: `ObjectOptimisticLockingFailureException`). 그 쿼리로 결과가 0건이면 Datadog trace 링크는 생략한다(예: graphql 경로가 아닌 예외).
   - `[성능]` **느린 resource 항목마다 하나씩** 부모 불릿으로 넣는다(부모=resource명, 자식 불릿=p95·전일 대비). 여러 resource를 한 불릿에 묶지 마라 — 각 resource가 자기 부모 불릿을 갖는다. **각 부모의 자식 불릿으로 그 resource의 "느린 요청"으로 바로 가는 Datadog 링크를 단다**(항목마다 자기 링크, 하나로 뭉치지 마라):
     - 그냥 `resource_name:{resource}`만 건 링크는 그 API의 모든 요청을 보여줄 뿐, 브리핑이 그 항목을 짚은 이유(느리다)와 안 맞는다. **지연시간 필터를 반드시 건다.** `search_datadog_spans`를 `service:{서비스} env:zigzag-production resource_name:{resource} @duration:>{임계값}` 쿼리에 `sort:-@duration`로 호출하면(임계값은 그 resource p95의 절반~p95 근처, 예: p95 15초면 `@duration:>10s`), **응답에 오는 `traces_explorer_url`을 그대로 링크로 쓴다.** 그러면 눌렀을 때 느린 요청만 지연 내림차순으로 보인다. 링크 텍스트는 `🔗 느린 요청 Datadog에서 보기`.
     - 특정 사건을 더 파야 하면 개별 trace 링크(`<base>/apm/trace/<trace_id>`, trace_id는 로그의 dd.trace_id 또는 위 span의 traceid)를 자식으로 추가한다.
   - 에러도 성능 이슈도 없으면(0건) 그 서비스는 `[ERROR] 어제 ERROR 없음` 한 줄로 끝낸다(링크 불필요).
   - 서비스 블록 끝에 빈 줄.
6. **종합 판정**: 구분선 헤더 + P0~P3 불릿(각 줄 앞에 🔴 또는 🟡 또는 🟢, 신규·회귀·해소 여부 병기) + Alert 모니터 상태 한 줄.
7. **현재 버전 기록** (맨 아래, 다음날 배포 비교용): 구분선 헤더 `━━━━  현재 버전  ━━━━` 아래에 서비스별로 그날 마지막(가장 늦게 배포된) 버전을 한 줄씩 적는다. 예: `wms: 2026.0721.1451-f51221-common`. 내일 브리핑 Step 1.5가 이 값을 읽어 "그날 Datadog @version 목록 중 이 버전에 없던 것 = 새 배포"로 판정한다. 배포가 없던 서비스는 전날 것 그대로 이어 적는다(현재 버전이 안 바뀐 것이니).

이 본문은 내일 브리핑의 비교 기준이 된다(어제 어떤 예외 타입이 몇 건이었나, 그리고 어제 마지막 버전이 무엇이었나). 그러니 예외 타입·operation·수치, 그리고 맨 아래 현재 버전을 명확히 남긴다.
