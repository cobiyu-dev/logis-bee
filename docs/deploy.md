# 운영과 개발 분리 · 상시 실행

로대리는 하나의 코드베이스로 **운영 봇**과 **개발 봇**을 돌린다. 둘을 섞으면 사고가 나므로,
Slack 앱을 두 개로 나누고 실행 환경을 구분한다.

## 왜 나눠야 하나

Slack 앱 하나에 대해 **같은 봇 토큰으로 두 프로세스가 뜨면**, Socket Mode 연결이 둘이 되고
Slack이 멘션 이벤트를 두 프로세스에 번갈아 보낸다. 결과:

- 개발 중인(반쯤 고친) 코드가 실제 사용자 멘션에 답해버린다.
- 모닝 브리핑 스케줄러가 양쪽에서 돌아 브리핑이 두 번 게시된다.

그래서 **운영용 Slack 앱과 개발용 Slack 앱을 따로** 두고, 각자 자기 토큰·채널만 쓴다.

## 두 환경 구성

| 구분 | 운영 | 개발 |
|------|------|------|
| Slack 앱 | `로대리` (기존) | `로대리-dev` (신규) |
| 실행 위치 | 전용 PC / 서버 (상시) | 내 PC (개발할 때만) |
| 실행 명령 | `npm start` | `npm run dev` |
| 초대 채널 | 실제 운영 채널 | 개발 테스트 채널 |
| `CODE_SYNC` | `1` (remote main 최신 코드) | 끔 (내 로컬 코드 그대로) |
| `BRIEFING_CHANNEL` | 설정 (스케줄러 켬) | 비움 (스케줄러 끔) |

## 개발용 Slack 앱 만들기 (`로대리-dev`)

운영 앱을 만들 때와 같은 절차다. https://api.slack.com/apps 에서:

1. **Create New App** → From scratch → 이름 `로대리-dev`, 워크스페이스 선택.
2. **Socket Mode** 활성화 → App-Level Token 생성(스코프 `connections:write`) → `xapp-...` 복사.
3. **Event Subscriptions** → **Enable Events를 On**으로 켠다(이걸 빠뜨리면 멘션이 안 온다) →
   *Subscribe to bot events*에 추가: `app_mention`, `message.im`, `reaction_added`.
4. **OAuth & Permissions** → *Bot Token Scopes*: `app_mentions:read`, `reactions:read`,
   `reactions:write`, `im:history`, `chat:write`, `users:read`, `users:read.email`
   (운영 앱과 동일하게. 코드가 쓰는 스코프에 맞춘다).
5. **Install to Workspace** → 설치 → Bot User OAuth Token `xoxb-...` 복사.
6. 개발용 **테스트 채널**에 초대: `/invite @로대리-dev`.

> 이벤트 구독을 바꾸면 **Enable Events On 저장 + 앱 재설치**를 꼭 해야 반영된다.
> (운영 앱에서 멘션이 안 오던 원인이 Enable Events가 Off였던 것.)

## 개발 PC에서 실행

`set-tokens.sh`에 **개발 앱 토큰**을 넣고, `CODE_SYNC`·`BRIEFING_CHANNEL`은 비운 채로 둔다.

```bash
source set-tokens.sh
npm run dev        # 파일 저장 시 자동 재시작
```

이러면 개발 봇은 개발 채널에서만 반응하고, 내 로컬 코드를 그대로 읽으며, 브리핑도 안 돈다.
운영 봇과 완전히 독립적이라 여기서 아무리 껐다 켜도 운영엔 영향이 없다.

## 운영 PC에서 상시 실행 (pm2)

전용 PC에서 봇이 재부팅·크래시 후에도 살아있게 하려면 pm2로 띄운다.
(node-cron 스케줄러는 이 프로세스 안의 메모리 타이머라, 프로세스가 죽으면 브리핑도 멈춘다.
그래서 상시 실행 보장이 중요하다.)

```bash
npm i -g pm2

# 운영 앱 토큰·설정을 셸에 주입한 상태에서 등록한다.
source set-tokens.sh          # 운영 토큰 + CODE_SYNC=1 + BRIEFING_CHANNEL 포함
pm2 start "npm start" --name lodaeri --time

pm2 save                      # 현재 프로세스 목록 저장
pm2 startup                   # 부팅 시 자동 시작 등록(안내되는 명령을 한 번 실행)
```

운영 로그·재시작·상태는 pm2로 관리한다.

```bash
pm2 logs lodaeri     # 로그 보기
pm2 restart lodaeri  # 코드 갱신 후 재시작
pm2 status           # 상태 확인
```

> pm2는 등록 시점의 환경변수를 프로세스에 고정한다. 토큰·설정을 바꾼 뒤에는
> `source set-tokens.sh` 후 `pm2 restart lodaeri --update-env`로 다시 읽힌다.

## 코드 갱신 흐름

- 개발 PC에서 고치고 `alpha`에 커밋·푸시 → 리뷰 후 `main` 병합.
- 운영 PC에서 `git pull`(또는 배포 스크립트) 후 `pm2 restart lodaeri`.
- 운영 봇은 `CODE_SYNC=1`이라, 답변 시 참조하는 **다른 프로젝트 소스**는 자동으로 remote main
  최신을 읽는다. 단 로대리 자신의 코드는 pull + restart로 갱신해야 한다.
