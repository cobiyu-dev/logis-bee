# 로대리 — 물류 업무를 돕는 Slack 봇

"로대리"(로지스틱 일을 하는 대리 직급 직원)는 사내 물류 업무를 돕는 Slack 봇이다.
Socket Mode로 Slack 이벤트를 받아, 사용자의 요청을 **`claude` CLI 서브프로세스에 위임**해 답을 만든다.

봇 자신은 자연어 이해나 로그 분석을 직접 하지 않는다. 요청을 프롬프트로 감싸 `claude --print`에 넘기고,
그 출력을 Slack 메시지로 바꿔 돌려줄 뿐이다. 실제 일(로그 조회, 브리핑 작성, 포맷팅)은 `.claude/skills/`의 스킬들이 한다.

> 이 문서는 **봇을 개발·운영하는 사람**을 위한 것이다(아키텍처·명령어·설정).
> 로대리가 답할 때 참고하는 **물류 도메인 지식**은 `CLAUDE.md`에 있다.

## 무엇을 하나

- **멘션에 답한다**: `@로대리 ...`로 물으면, claude가 등록된 사내 프로젝트 소스와 스킬을 활용해 답한다.
- **로그를 조회한다**: Grafana Loki 로그를 물어보면 rodaeri-loki 스킬이 CLI로 조회해 답한다.
- **모닝 브리핑을 보낸다**: 평일 아침, 전날 운영 상황을 요약해 지정 채널에 게시한다(스케줄러).

## 아키텍처

### 두 개의 트리거, 하나의 위임 경로

`npm start`(=`tsx src/app.ts`)는 **한 프로세스**에서 두 가지를 동시에 띄운다.

1. **Slack 이벤트 루프** (`src/app.ts`) — 멘션·리액션·DM에 반응. 봇 프로세스가 살아있는 동안만 동작.
2. **node-cron 스케줄러** (`src/scheduler.ts`) — 같은 프로세스 안의 메모리 타이머. 평일 09:10 KST(`BRIEFING_CRON`)에
   모닝 브리핑을 트리거. 별도 프로세스가 아니므로 봇이 죽으면 스케줄도 멈춘다.

둘 다 최종적으로 같은 경로로 수렴한다: **프롬프트 → `runClaude()` → `toSlackMessage()` → `chat.postMessage`**.

- `src/executor.ts` `runClaude()` — `claude --print --dangerously-skip-permissions --model <CLAUDE_MODEL>`를 spawn한다.
  cwd를 프로젝트 루트로 잡아 `.claude/skills/`와 `CLAUDE.md`가 자동 로드되게 한다. 프롬프트 끝에 slack-format 지시 한 줄을
  항상 덧붙여, claude가 답을 Block Kit JSON으로 내도록 유도한다. **stdin은 반드시 `'ignore'`** — 안 그러면 claude CLI가
  stdin을 기다리다 경고를 출력에 섞어 실패한다.
- `src/slack-message.ts` `toSlackMessage()` — claude 출력에서 `{text, blocks}` JSON을 파싱한다(코드펜스 우선, 없으면 첫 `{`~마지막 `}`).
  claude가 설명 문장이나 코드펜스를 붙여도 걷어낸다. 유효한 blocks가 없으면 원문을 그대로 text로 쓰는 안전한 폴백이 있다.

### 멘션 처리의 특징 (`src/app.ts`)

- **처리 중 표시**: 태그된 원본 메시지에 `LOADING_EMOJI`(기본 `loading2`) 리액션을 달고, 완료되면 답변을 새 메시지로 보낸 뒤 이모지를 뗀다.
- **스레드 맥락**: 스레드 안 멘션이면 `conversations.replies`로 이전 대화를 읽어 프롬프트에 넣는다("좀 더 자세하게" 같은 후속 요청 이해).
- **직군 맞춤 답변**: `users.info`로 질문자의 직함·표시이름을 읽어, 개발자/PO/비개발 중 어디인지 claude가 판단해 답변 눈높이를 맞추게 한다. `users:read` 스코프 필요.
- **프로젝트 소스 참고**: `code-projects.json`에 등록된 사내 프로젝트 경로를 `--add-dir`로 열어, claude가 소스를 읽고 답하게 한다.
- 이모지·프로필 조회 실패는 모두 삼킨다 — 부가 기능 하나 때문에 답변 자체가 막히지 않게.

### 스킬 (`.claude/skills/`)

claude CLI가 프롬프트를 보고 필요한 스킬을 스스로 골라 실행한다. 봇 코드는 스킬을 직접 부르지 않는다.

- **rodaeri-loki** — Grafana Loki 로그 조회. `src/grafana/`의 CLI(`npm run grafana`)를 호출한다.
- **wms-briefing** — 모닝 브리핑. Grafana(운영·ERROR 관점) + Datadog MCP(성능 관점) + Notion MCP(저장·비교)를 엮는다.
- **slack-format** — 최종 답변을 Slack Block Kit JSON으로 변환. 위임 경로의 마지막 단계.

### Grafana 인증 스택 (`src/grafana/`)

사내 Grafana는 서비스계정 토큰을 지원하지 않아 `grafana_session` 쿠키만 쓴다. `ensureAuth()`(`auth.ts`)가 **3단 복구**를 한다.

1. 저장된 쿠키가 유효하면 그대로 사용 (`session.ts` `checkAuth`).
2. 만료면 `/user/auth-tokens/rotate`로 **가벼운 HTTP 복구**를 먼저 시도 (`session.ts` `rotateSession`). SSO 세션이 살아있으면 대부분 여기서 Chrome 없이 풀린다.
3. rotate까지 실패한 최후에만 전용 Chrome을 CDP로 조종해 Keycloak+OTP 재로그인 (`browser-login.ts`, `cdp.ts`, `chrome.ts`, `otp.ts`).

**함정**: `query`는 `forceRefresh` 없이 `ensureAuth`를 불러 rotate를 먼저 탄다. 하지만 `login` 명령은 `forceRefresh:true`라
**rotate를 건너뛰고 곧장 Chrome을 띄운다**. 그래서 만료 복구는 `login`이 아니라 `query`로 시작해야 한다. `login`은 최초 설정·수동 복구 전용이다.

세션 파일·전용 Chrome 프로필은 `~/.logisbi/`(=`LOGISBI_STATE_DIR`)에 둔다.

## Slack 앱 설정

본인 소유의 새 앱을 발급한다. https://api.slack.com/apps →

1. **Create New App** → From scratch → 이름 `로대리`, 워크스페이스 선택.
2. **Socket Mode** → 활성화 → App-Level Token 생성(스코프 `connections:write`) → `xapp-...` 복사.
3. **Event Subscriptions** → **Enable Events를 On**으로 켠다(이걸 빠뜨리면 멘션이 안 온다) →
   *Subscribe to bot events*에 추가: `app_mention`, `message.im`, `reaction_added`.
4. **OAuth & Permissions** → *Bot Token Scopes*: `app_mentions:read`, `reactions:read`, `reactions:write`,
   `im:history`, `chat:write`, `users:read`, `users:read.email`.
5. **Install to Workspace** → 설치 → Bot User OAuth Token `xoxb-...` 복사.
6. 테스트 채널에 초대: `/invite @로대리`.

> 이벤트 구독을 바꾸면 **Enable Events On 저장 + 앱 재설치**를 꼭 해야 반영된다.

운영과 개발을 나누는 법(별도 Slack 앱, pm2 상시 실행)은 `docs/deploy.md`에 있다.

## 토큰 주입 (셸 환경변수)

토큰은 `.env`가 아니라 **셸 환경변수**로 주입한다. 디스크에 평문으로 남지 않게 하기 위함이다.

```bash
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_APP_TOKEN='xapp-...'
```

`set-tokens.sh.example`을 `set-tokens.sh`로 복사해 값을 채우고 `source set-tokens.sh`로 불러오면 편하다
(`set-tokens.sh`는 `.gitignore`가 막는다). `dev`/`start`는 dotenv를 쓰지 않으므로, 이 두 토큰이 셸에 없으면 즉시 죽는다.

> `.zshrc`에 박는 건 권하지 않는다 — 모든 셸 세션과 다른 프로젝트에까지 토큰이 노출된다.

## 명령어

```bash
npm run dev        # tsx watch — 봇 실행 + 파일 저장 시 자동 재시작 (개발용)
npm start          # tsx src/app.ts — 봇 실행 (재시작 없음)
npm run typecheck  # tsc --noEmit — 커밋 전 항상 이걸로 확인 (빌드 산출물 없음)
npm test           # node --test — src/grafana/*.test.ts 실행
npm run briefing   # 모닝 브리핑을 스케줄 대기 없이 즉시 1회 실행 (검증용)

# Grafana Loki CLI (스킬이 이걸 호출한다. 직접 디버깅에도 씀)
npm run grafana -- query prod '{app="wms"} |= `"log_level":"ERROR"`' now-1h now 5000
npm run grafana -- link  prod '<LogQL>' <from> <to>   # Explore deep link만 생성(인증 불필요)
npm run grafana -- check prod   # 저장 세션 유효성만 확인(rotate 안 함)
npm run grafana -- login prod   # 강제 브라우저 재로그인(rotate 건너뜀 — 최초 설정·수동 복구용)
```

단일 테스트: `node --import tsx --test src/grafana/otp.test.ts` 처럼 파일을 직접 지정한다.

## 환경변수

셸 환경변수가 `.env`보다 우선한다. 동작을 가르는 주요 변수:

| 변수 | 효과 |
|------|------|
| `BRIEFING_CHANNEL` | 없으면 스케줄러가 조용히 비활성(봇은 정상). 있으면 그 채널에 브리핑 게시. |
| `CODE_SYNC=1` | 답변 전 등록 프로젝트를 remote main으로 강제 최신화(`reset --hard`). **운영 PC 전용 — 개발 PC에선 로컬 작업이 날아간다.** |
| `CLAUDE_MODEL` | claude 모델(기본 `sonnet`). |
| `CLAUDE_TIMEOUT_MS` | 멘션 처리 타임아웃(기본 10분). |
| `BRIEFING_TIMEOUT_MS` | 브리핑 타임아웃(기본 25분). |
| `LOADING_EMOJI` | 처리 중 표시 이모지(기본 `loading2`). |
| `CODE_PROJECTS_FILE` | 참고할 프로젝트 목록 파일 경로(기본 `code-projects.json`). |

## 규약과 주의점

- **ESM + `tsx`**: 빌드 단계가 없다. `.ts`를 `tsx`로 직접 실행하고, import는 `.js` 확장자로 쓴다(NodeNext). 검증은 `npm run typecheck`로 한다.
- **의도적으로 오더비(orderby) 봇을 참고**: `runClaude`, 스케줄러 등은 사내 오더비 봇의 대응 로직을 이식한 것이다. 주석의 오더비 언급은 설계 출처를 가리킨다.
- **`.mcp.json`**: Notion MCP를 등록한다. wms-briefing 스킬이 Datadog·Notion MCP를 쓴다.
- **운영/개발은 별도 Slack 앱으로 분리**: 같은 봇 토큰으로 두 곳에서 띄우면 Slack이 멘션을 두 프로세스에 번갈아 보내
  개발 코드가 실제 답변을 가로채고 브리핑이 중복된다. 절차는 `docs/deploy.md`.

## 파일 구조

```
src/
├── app.ts            # 진입점 — Slack 이벤트 핸들러 + 프롬프트 조립
├── executor.ts       # runClaude() — claude CLI 위임
├── slack-message.ts  # toSlackMessage() — claude 출력을 Block Kit으로 변환
├── scheduler.ts      # node-cron 모닝 브리핑 스케줄러
├── briefing-run.ts   # npm run briefing 진입점(즉시 1회 실행)
├── code-projects.ts  # 참고 프로젝트 목록 로드 + 프롬프트 컨텍스트 생성
├── git-sync.ts       # CODE_SYNC=1일 때 프로젝트를 remote main으로 동기화
└── grafana/          # Grafana Loki 조회 CLI + 3단 인증 스택
```
