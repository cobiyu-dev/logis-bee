# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 프로젝트가 하는 일

"로대리"라는 Slack 봇이다. Socket Mode로 Slack 이벤트를 받아, 사용자의 요청을 **`claude` CLI 서브프로세스에 위임**해 답을 만든다. 봇 자신은 자연어 이해나 로그 분석을 직접 하지 않는다 — 요청을 프롬프트로 감싸 `claude --print`에 넘기고, 그 출력을 Slack 메시지로 변환해 돌려줄 뿐이다. 실제 일(로그 조회, 브리핑 작성, 포맷팅)은 `.claude/skills/`의 스킬들이 한다.

> README.md는 초기 "이벤트 수신 검증" 단계만 서술한다. 프로젝트는 그 뒤로 Claude CLI 위임·스케줄러·Grafana 인증 스택으로 발전했다. 아키텍처는 README가 아니라 이 문서와 코드를 따른다.

## 명령어

토큰은 `.env`가 아니라 **셸 환경변수**로 주입한다 (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`). `set-tokens.sh.example`을 `set-tokens.sh`로 복사해 `source`하면 편하다. `dev`/`start`는 dotenv를 쓰지 않으므로, 이 두 토큰이 셸에 없으면 즉시 죽는다.

```bash
npm run dev        # tsx watch — 봇 실행 + 파일 저장 시 자동 재시작 (개발용)
npm start          # tsx src/app.ts — 봇 실행 (재시작 없음)
npm run typecheck  # tsc --noEmit — 커밋 전 항상 이걸로 확인 (빌드 산출물 없음, noEmit)
npm test           # node --test — src/grafana/*.test.ts 실행
npm run briefing   # 모닝 브리핑을 스케줄 대기 없이 즉시 1회 실행 (검증용)

# Grafana Loki CLI (스킬이 이걸 호출한다. 직접 디버깅에도 씀)
npm run grafana -- query prod '{app="wms"} |= `"log_level":"ERROR"`' now-1h now 5000
npm run grafana -- link  prod '<LogQL>' <from> <to>   # Explore deep link만 생성(인증 불필요)
npm run grafana -- check prod   # 저장 세션 유효성만 확인(rotate 안 함)
npm run grafana -- login prod   # 강제 브라우저 재로그인(rotate 건너뜀 — 최초 설정·수동 복구용)
```

단일 테스트: `node --import tsx --test src/grafana/otp.test.ts` 처럼 파일을 직접 지정한다.

## 아키텍처

### 두 개의 트리거, 하나의 위임 경로

`npm start`(=`tsx src/app.ts`)는 **한 프로세스**에서 두 가지를 동시에 띄운다.

1. **Slack 이벤트 루프** (`src/app.ts`) — 멘션·리액션·DM에 반응. 봇 프로세스가 살아있는 동안만 동작.
2. **node-cron 스케줄러** (`src/scheduler.ts`) — 같은 프로세스 안의 메모리 타이머. 평일 09:10 KST(`BRIEFING_CRON`)에 모닝 브리핑을 트리거. 별도 프로세스가 아니므로 봇이 죽으면 스케줄도 멈춘다.

둘 다 최종적으로 같은 경로로 수렴한다: **프롬프트 → `runClaude()` → `toSlackMessage()` → `chat.postMessage`**.

- `src/executor.ts` `runClaude()` — `claude --print --dangerously-skip-permissions --model <CLAUDE_MODEL>`를 spawn한다. cwd를 프로젝트 루트로 잡아 `.claude/skills/`가 자동 로드되게 한다. 프롬프트 끝에 slack-format 지시 한 줄을 항상 덧붙여, claude가 답을 Block Kit JSON으로 내도록 유도한다. **stdin은 반드시 `'ignore'`** — 안 그러면 claude CLI가 stdin을 기다리다 경고를 출력에 섞어 실패한다.
- `src/slack-message.ts` `toSlackMessage()` — claude 출력에서 가장 바깥 `{...}`를 찾아 `{text, blocks}` JSON을 파싱한다. claude가 코드펜스나 설명 문장을 붙여도 걷어낸다. 유효한 blocks가 없으면 원문을 그대로 text로 쓰는 안전한 폴백이 있다(빈 응답 방지).

### 멘션 처리의 특징 (`src/app.ts`)

- **처리 중 표시**: 임시 메시지를 보내 교체하는 방식이 아니라, 태그된 원본 메시지에 `LOADING_EMOJI`(기본 `loading2`) 리액션을 달고, 완료되면 답변을 새 메시지로 보낸 뒤 이모지를 뗀다.
- **스레드 맥락**: 스레드 안 멘션이면 `conversations.replies`로 이전 대화를 읽어 프롬프트에 넣는다("좀 더 자세하게" 같은 후속 요청 이해).
- **직군 맞춤 답변**: `users.info`로 질문자의 직함·표시이름을 읽어, 개발자/PO/비개발(물류 기획·운영) 중 어디인지 claude가 판단해 답변 눈높이를 맞추게 한다. `users:read` 스코프 필요.
- 이모지·프로필 조회 실패는 모두 삼킨다 — 부가 기능 하나 때문에 답변 자체가 막히지 않게.

### 스킬 (`.claude/skills/`)

claude CLI가 프롬프트를 보고 필요한 스킬을 스스로 골라 실행한다. 봇 코드는 스킬을 직접 부르지 않는다.

- **rodaeri-loki** — Grafana Loki 로그 조회. `src/grafana/`의 CLI(`npm run grafana`)를 호출한다. (이름이 `grafana-logs`인 플러그인 스킬과 겹치지 않게 개명함.)
- **wms-briefing** — 모닝 브리핑. Grafana(운영·ERROR 관점) + Datadog MCP(성능 관점) + Notion MCP(저장·비교)를 엮는다.
- **slack-format** — 최종 답변을 Slack Block Kit JSON으로 변환. 위임 경로의 마지막 단계.

### Grafana 인증 스택 (`src/grafana/`)

사내 Grafana는 서비스계정 토큰을 지원하지 않아 `grafana_session` 쿠키만 쓴다. `ensureAuth()`(`auth.ts`)가 **3단 복구**를 한다. 이 순서가 이 서브시스템의 핵심이다.

1. 저장된 쿠키가 유효하면 그대로 사용 (`session.ts` `checkAuth`).
2. 만료면 `/user/auth-tokens/rotate`로 **가벼운 HTTP 복구**를 먼저 시도 (`session.ts` `rotateSession`). SSO 세션이 살아있는 한 대부분 여기서 Chrome 없이 풀린다.
3. rotate까지 실패한 최후에만 전용 Chrome을 CDP로 조종해 Keycloak+OTP 재로그인 (`browser-login.ts`, `cdp.ts`, `chrome.ts`, `otp.ts`).

**함정**: `queryLoki`/`query`는 `forceRefresh` 없이 `ensureAuth`를 불러 rotate를 먼저 탄다. 하지만 `login` 명령은 `forceRefresh:true`라 **rotate를 건너뛰고 곧장 Chrome을 띄운다**. 그래서 만료 복구는 `login`이 아니라 `query`(또는 rotate 포함 경로)로 시작해야 한다. `login`은 최초 설정·수동 복구 전용이다.

세션 파일·전용 Chrome 프로필은 `~/.logisbi/`(=`LOGISBI_STATE_DIR`)에 둔다.

## 규약과 주의점

- **ESM + `tsx`**: 빌드 단계가 없다. `.ts`를 `tsx`로 직접 실행하고, import는 `.js` 확장자로 쓴다(NodeNext). 산출물이 없으므로 검증은 `npm run typecheck`로 한다.
- **의도적으로 오더비(orderby) 봇을 참고**: `runClaude`, 스케줄러 등은 사내 오더비 봇의 대응 로직을 이식한 것이다. 주석의 오더비 언급은 설계 출처를 가리킨다.
- **`.mcp.json`**: Notion MCP(`kakaostyle-mcp-alpha-notion`)를 등록한다. wms-briefing 스킬이 Datadog·Notion MCP를 쓴다.
- **환경변수로 동작이 갈린다**: `BRIEFING_CHANNEL`이 없으면 스케줄러는 조용히 비활성(봇은 정상). `CLAUDE_MODEL`(기본 sonnet), `CLAUDE_TIMEOUT_MS`(멘션 5분), `BRIEFING_TIMEOUT_MS`(브리핑 25분)로 조정한다. 셸 환경변수가 `.env`보다 우선한다.
