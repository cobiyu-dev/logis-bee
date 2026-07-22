# Grafana 로그 조회 — 최초 설정 (PC마다 1회)

이 CLI는 인증이 만료되면 **전용 Chrome을 CDP로 조종해 Keycloak SSO + OTP 로그인을 자동 수행**하고, 얻은 `grafana_session` 쿠키를 재사용한다. Windows와 macOS를 모두 지원한다.

각 PC에서 아래를 **한 번만** 설정하면, 이후에는 사람 개입 없이 로그를 조회할 수 있다.

---

## 인증 우선순위

사내 Grafana는 서비스계정 토큰을 지원하지 않으므로, `grafana_session` 쿠키만 쓴다.

1. **저장된 쿠키** — 약 24시간 유효.
2. **브라우저 자동 로그인** — 쿠키가 만료됐을 때 발동. Keycloak 계정과 Authenticator 확장이 필요하다.

---

## 1. 자격 증명 (.env)

프로젝트 루트에 `.env`를 만든다 (`.gitignore`에 이미 등록됨).

```dotenv
# Keycloak SSO 계정 (브라우저 자동 로그인용)
# Grafana는 Keycloak으로만 로그인하므로, 이 값은 Grafana 계정이 아니라 Keycloak 계정이다.
KEYCLOAK_USERNAME=본인_keycloak_아이디
KEYCLOAK_PASSWORD=본인_keycloak_비밀번호
```

## 2. 상태 디렉토리

CLI는 `~/.logisbi/` 아래에 세션 파일과 전용 Chrome 프로필을 둔다. 자동 생성되므로 직접 만들 필요는 없다. `LOGISBI_STATE_DIR`로 위치를 바꿀 수 있다.

## 3. 전용 Chrome 프로필 준비

일상용 Chrome을 디버깅 포트로 열지 않기 위해, `~/.logisbi/chrome-profile`이라는 별도 프로필을 쓴다. 최초 1회 이 프로필에 로그인 상태와 확장을 심는다.

```bash
# 전용 프로필로 Chrome을 CDP 모드로 띄운다
npm run grafana -- login prod   # 실패해도 됨 — 브라우저가 뜨는 게 목적
```

브라우저가 뜨면 그 창에서:

1. **Authenticator 확장 설치** — Chrome 웹스토어에서 "Authenticator"(ID `bhghoamapcdpbohphigoooaddinpkbai`) 설치 후, kakaostyle Keycloak 계정의 OTP 시크릿을 등록한다. (다른 확장을 쓰면 `.env`에 `GRAFANA_OTP_EXTENSION_ID`, `GRAFANA_OTP_ACCOUNT`를 맞춰 지정)
2. **Keycloak SSO 1회 로그인** — `https://grafana.zigzag.in/login`에서 Keycloak으로 로그인해 둔다. SSO 세션이 살아있으면 이후 자동 로그인은 폼 입력 없이 통과한다.

## 4. Chrome 경로 (필요 시)

CLI는 표준 위치에서 Chrome을 찾는다. 못 찾으면 `.env`나 환경변수로 지정한다.

```dotenv
# macOS 예
GRAFANA_CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# Windows 예
GRAFANA_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

---

## 사용

```bash
npm run grafana -- check prod                                   # 인증 상태 확인
npm run grafana -- login prod                                   # 세션 강제 취득
npm run grafana -- query prod '{app="wms", loglevel="ERROR"}' now-1h now 5000
```

Claude Code에서는 "wms 에러 로그 조회해줘"처럼 말하면 `rodaeri-loki` 스킬이 위 명령을 대신 실행한다.

---

## 환경변수 레퍼런스

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `KEYCLOAK_USERNAME` / `KEYCLOAK_PASSWORD` | — | Keycloak SSO 계정 |
| `GRAFANA_URL` / `GRAFANA_ALPHA_URL` | zigzag.in / alpha.zigzag.in | Grafana 주소 |
| `GRAFANA_CDP_PORT` | `9223` | 전용 Chrome CDP 포트 |
| `GRAFANA_CHROME_PATH` | OS별 표준 경로 | Chrome 실행 파일 |
| `GRAFANA_OTP_EXTENSION_ID` | `bhghoamapcdpbohphigoooaddinpkbai` | Authenticator 확장 |
| `GRAFANA_OTP_ACCOUNT` | `kakaostyle` | 확장 팝업에서 찾을 계정 라벨 |
| `LOGISBI_STATE_DIR` | `~/.logisbi` | 세션·프로필 저장 위치 |
