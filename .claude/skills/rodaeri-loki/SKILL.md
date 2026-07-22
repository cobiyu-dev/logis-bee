---
name: rodaeri-loki
description: "Grafana Loki 프로덕션 로그를 조회한다. 인증 만료 시 먼저 rotate로 가볍게 세션을 복구하고, 그마저 실패하면 전용 Chrome을 CDP로 조종해 Keycloak SSO + OTP 자동 로그인으로 grafana_session 쿠키를 취득한다(Windows/Mac 공통). Use when: 로그 조회, 에러 로그, grafana logs, 로그 분석, 프로덕션 로그, ERROR 로그, Loki 쿼리."
allowed-tools: Read, Bash, Glob, Grep
argument-hint: "[prod|alpha] [에러 메시지 | LogQL 쿼리]"
---

# Grafana Loki 로그 조회

Grafana Loki API로 로그를 조회한다. 인증은 CLI가 자동 처리하므로, 이 스킬은 "언제 어떤 CLI 명령을 실행할지"만 지시한다. 브라우저 조작·OTP 읽기 같은 타이밍 민감한 절차는 전부 TypeScript CLI에 결정적으로 구현되어 있다.

> **경로 규칙**: 아래 명령은 이 프로젝트 루트(`local-ai/`)에서 실행한다.

---

## 인증 구조 (3단)

사내 Grafana는 서비스계정 토큰을 지원하지 않으므로, `grafana_session` 쿠키만 쓴다. CLI가 아래 순서로 유효한 인증을 확보한다. 사람 개입은 브라우저 최초 설정 이후 0에 수렴한다.

1. **저장된 `grafana_session` 쿠키** — `~/.logisbi/grafana_session.json`. TTL 약 24시간.
2. **rotate 복구** — 쿠키가 만료면, `/user/auth-tokens/rotate`에 만료 토큰을 들고 요청해 새 토큰과 교환한다. SSO 세션이 살아있는 동안은 이 HTTP 한 번으로 조용히 풀린다(Chrome이 안 뜬다). 만료의 대부분은 여기서 복구된다.
3. **브라우저 자동 로그인** — rotate까지 실패한 최후에만, 전용 프로필 Chrome을 CDP(포트 9223)로 조종해 Keycloak 폼 입력 + Authenticator 확장에서 OTP 자동 입력 후 쿠키 추출. 취득 쿠키는 `/api/org`로 실검증 후에만 저장.

---

## Execution Steps

### Step 1 — 환경 결정

사용자 입력에 "알파"/"alpha"가 있으면 `alpha`, 없으면 `prod`(기본).

| 환경 | Grafana URL | Loki instance 라벨 |
|------|-------------|--------------------|
| prod (기본) | `https://grafana.zigzag.in` | `prod-order` 등 (app 라벨로 구분) |
| alpha | `https://grafana.alpha.zigzag.in` | `order-alpha` 등 |

### Step 2 — 바로 조회 (인증은 CLI가 알아서 복구)

세션이 만료됐는지 미리 확인하지 말고 **곧장 `query`를 실행한다.** `query`는 내부적으로 아래 순서로 유효한 세션을 확보하므로, 만료돼 있어도 사람이 개입할 필요가 없다.

1. 저장된 `grafana_session` 쿠키가 유효하면 그대로 사용.
2. 만료면 `/user/auth-tokens/rotate`로 **가벼운 HTTP 복구**를 먼저 시도한다. 대부분의 만료는 여기서 Chrome을 띄우지 않고 조용히 풀린다.
3. rotate까지 실패한 진짜 최후에만 전용 Chrome을 띄워 Keycloak+OTP로 재로그인한다.

> 만료 확인용으로 `check`를, 강제 재로그인용으로 `login`을 따로 부르지 마라. `check`는 rotate를 시도하지 않고, `login`은 rotate를 건너뛰고 곧장 Chrome을 띄운다. 둘 중 하나로 시작하면 rotate 복구 기회를 놓쳐 매번 Chrome이 뜬다. 평소 조회는 `query` 하나로 충분하다.

`login`은 자격 증명·프로필을 새로 태워야 하는 **최초 설정**이나, `query`가 인증 실패로 끝났을 때의 수동 복구에만 쓴다. 그 경우 실패 메시지가 나오면 사용자에게 **최초 1회 설정**을 확인 요청한다:

1. `.env`에 `KEYCLOAK_USERNAME` / `KEYCLOAK_PASSWORD` (Keycloak SSO 계정)
2. 전용 Chrome 프로필(`~/.logisbi/chrome-profile`)에 Authenticator 확장 설치 + kakaostyle 계정 등록, Keycloak SSO 1회 로그인
3. 자세한 절차는 `docs/grafana-setup.md` 안내

### Step 3 — LogQL 조회

```bash
npm run grafana -- query prod '{app="wms", loglevel="ERROR"}' now-1h now 5000
```

출력은 `{"env","count","lines":[...]}` JSON이다. 401/403이 나면 CLI가 자동으로 세션을 재취득해 1회 재시도한다.

LogQL 구성 참고 (값은 대문자 레벨):

| 사용자 입력 | LogQL |
|------------|-------|
| 에러 로그 | `{app="<app>", loglevel="ERROR"}` |
| 특정 메시지 | `{app="<app>"} \|= \`메시지\`` |
| access 로그 | `{app="<app>", logType="access"}` |
| LogQL 직접 입력 | 그대로 사용 |

### Step 4 — 결과 분석

`lines` 배열을 파싱해 에러 TOP N, 엔드포인트 분포 등으로 정리하고, 조회 조건(환경·시간범위·LogQL·건수)을 먼저 표로 보여준다.

**로그 시각은 한국시간(KST)으로 변환해 표기한다.** 서버 로그는 대개 UTC로 시각을 남기므로, 사용자에게 보여줄 때는 UTC에 9시간을 더해 KST로 바꾼다. UTC 원문을 그대로 옮기면 사용자가 한국시간으로 다시 계산해야 해서 불편하다. 예: 로그 본문의 `09:27:01 UTC` → `18:27:01 KST`로 표기한다. 혼동을 막기 위해 시각 뒤에 `KST`를 명시한다.

---

## 트러블슈팅

| 문제 | 해결 |
|------|------|
| `login`이 계속 실패 | `.env` 자격 증명·전용 프로필의 SSO·확장 설치 확인 (`docs/grafana-setup.md`) |
| `Chrome 실행 파일을 찾지 못함` | `GRAFANA_CHROME_PATH` 환경변수로 경로 지정 |
| OTP를 못 읽음 | 확장 ID(`GRAFANA_OTP_EXTENSION_ID`)·계정 라벨(`GRAFANA_OTP_ACCOUNT`) 확인 |
| 포트 충돌 | `GRAFANA_CDP_PORT`로 9223 외 포트 지정 |
| 결과 0건 | 시간 범위 확대, `app` 라벨·`loglevel` 값(대문자) 확인 |
