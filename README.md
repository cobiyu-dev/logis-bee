# 로지스비 — Slack 이벤트 수신 테스트

Slack 봇(로지스비)을 멘션/이모지/DM으로 트리거하면, 내 PC가 **Socket Mode WebSocket**으로 그 이벤트를 받아 콘솔에 찍고 스레드에 echo 답글을 다는 최소 테스트 프로젝트다.

목적은 단 하나 — **"PC가 Slack 이벤트를 실제로 받을 수 있는지" 검증**. Claude 연동, 분석, 워커 풀 등은 다음 단계로 미룬다.

> 봇 이름 "로지스비"는 언제든 바꿔도 된다. 코드는 봇 이름에 의존하지 않는다(멘션은 앱 고유 user ID로 들어옴).

## 동작 원리

PC가 Slack으로 **나가는** WebSocket 연결을 연다(Socket Mode). 공개 IP나 웹훅 URL이 필요 없어 방화벽 안 개발자 PC에 그대로 맞는다. 연결이 열려 있으면 Slack이 이벤트를 그 연결로 실시간 푸시한다(폴링 아님).

받는 이벤트 3종:

- `app_mention` — `@로지스비 ...` 멘션
- `reaction_added` — 메시지에 👀(`eyes`) 리액션 (트리거 이모지는 `src/app.ts`의 `TRIGGER_EMOJI` 상수)
- `message` — DM 및 채널 메시지

## Slack 앱 설정

본인 소유의 새 앱을 발급한다.

1. https://api.slack.com/apps → **Create New App** → From scratch → 이름 `로지스비`, 워크스페이스 선택
2. **Socket Mode** (좌측 메뉴) → 활성화 → App-Level Token 생성(스코프 `connections:write`) → 토큰 `xapp-...` 복사
3. **Event Subscriptions** → Enable → *Subscribe to bot events*에 추가:
   - `app_mention`
   - `reaction_added`
   - `message.im`
   - `message.channels`
4. **OAuth & Permissions** → *Bot Token Scopes*에 추가:
   - `app_mentions:read`
   - `reactions:read`
   - `channels:history`
   - `im:history`
   - `chat:write`
5. **Install to Workspace** → 설치 → Bot User OAuth Token `xoxb-...` 복사
6. 테스트 채널에서 봇 초대: `/invite @로지스비`

> 충돌 주의: 같은 워크스페이스에 다른 봇(오더비 등)이 있으면, `src/app.ts`의 `TRIGGER_EMOJI`를 그 봇들이 쓰지 않는 이모지로 둔다(기본 `eyes`). 멘션은 앱마다 user ID가 달라 자동으로 구분된다.

## 토큰 주입 (셸 환경변수)

토큰은 파일에 저장하지 않고 **셸 환경변수**로 주입한다. 디스크에 평문으로 남지 않게 하기 위함이다. 봇을 띄울 터미널에서 실행한다:

```bash
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_APP_TOKEN='xapp-...'
```

매번 입력하기 번거로우면, `set-tokens.sh`(이미 `.gitignore`에 등록)에 위 두 줄을 적어두고 `source set-tokens.sh`로 불러온다. 단 이 파일도 평문이므로 git에 올리지 않도록 주의(`.gitignore`가 막아줌).

> `.zshrc`에 박는 건 권하지 않는다 — 모든 셸 세션과 다른 프로젝트에까지 토큰이 노출된다. 봇 띄우는 터미널에서만 export하는 게 노출 범위가 가장 좁다.

## 실행

같은 터미널(토큰을 export한 그 세션)에서:

```bash
npm install
npm run dev      # tsx watch — 파일 저장 시 자동 재시작
```

코드는 `process.env`에서 토큰을 직접 읽는다(`--env-file` 안 씀). 콘솔에 Socket Mode 연결 로그와 `⚡️ Slack 이벤트 수신 대기 중`이 뜨면 연결 성공. 토큰 export를 안 했으면 "환경변수 SLACK_BOT_TOKEN이(가) 없습니다" 에러로 즉시 멈춘다.

## 검증 체크리스트

| # | 동작 | 기대 결과 |
|---|------|-----------|
| 1 | `npm run dev` | 콘솔에 "Now connected to Slack" + "⚡️ ... 대기 중" |
| 2 | `@로지스비 안녕` 멘션 | 콘솔 `[mention] ... text=안녕` + 스레드에 echo 답글 |
| 3 | 채널에 일반 메시지(멘션 X) | 콘솔 `[message] ...` 로그 (echo는 없음) |
| 4 | 메시지에 👀 리액션 | 콘솔 `[reaction] ... emoji=eyes` + echo |
| 5 | 👀가 아닌 다른 이모지 리액션 | `[reaction]` 로그 안 찍힘 (트리거 필터 동작) |
| 6 | 봇에게 DM | 콘솔 `[message]` + DM echo |
| 7 | DM echo 직후 | echo 때문에 `[message]`가 또 찍히지 않음 (루프 없음) |

전부 통과하면 이벤트 수신 검증 완료. 다음 단계(Claude 연동)로 진행한다.

## 파일 구조

```
.
├── package.json           # @slack/bolt, tsx + dev 스크립트
├── tsconfig.json          # NodeNext ESM, strict
├── set-tokens.sh.example  # 토큰 export 템플릿 (복사해서 set-tokens.sh로 사용)
├── .gitignore             # .env, set-tokens.sh 차단
├── README.md
└── src/app.ts             # 진입점 + 3개 이벤트 핸들러
```

의존성은 `@slack/bolt`(런타임)와 `tsx`(실행기) 둘뿐이다. 토큰은 셸 환경변수로 주입하므로 dotenv도 `.env` 파일도 쓰지 않는다. TypeScript는 `tsx`로 빌드 없이 직접 실행한다.
