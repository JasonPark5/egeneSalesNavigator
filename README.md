# egeneSalesNavigator

음성으로 목적지를 말하면 AI가 장소를 검색하고 네이버지도 앱 길찾기로 연결해주는 웹 앱입니다.
[n8nMapService](https://github.com/JasonPark5/n8nMapService)를 사내 해커톤용으로 포크하여, 백엔드
자동화를 n8n 대신 사내 **ActionFlow**로 교체하고 GitHub Pages가 아닌 **로컬 실행** 구조로
바꾼 버전입니다.

## n8nMapService와 달라진 점

| 항목 | n8nMapService | 이 레포 |
|---|---|---|
| 자동화 엔진 | n8n (Webhook 노드, 즉시 응답) | 사내 ActionFlow (API Trigger 노드, 즉시 응답) |
| 실행 위치 | GitHub Pages (정적 호스팅) + n8n 클라우드 | 로컬 브릿지 서버(`server/`) + 로컬 정적 서빙 |
| 프론트엔드 → 백엔드 | 브라우저가 n8n Webhook URL로 직접 POST | 브라우저가 로컬 `server/`의 `/api/search`로 POST |
| n8n ↔ ActionFlow 차이 흡수 | - | `server/`가 프론트엔드 계약(`{ candidates, destination, ... }`)을 유지하면서 뒷단만 ActionFlow API Trigger 호출로 교체 |

ActionFlow의 API Trigger 노드는 POST + JSON body를 받고, 플로우 끝에서 만든 JSON을 n8n의
"Respond to Webhook"과 동일하게 **동기 응답**으로 돌려줍니다. 그래서 브릿지 서버(`server/`)는
트리거 한 번 호출하고 응답을 그대로 넘겨주기만 하면 됩니다 (폴링 불필요).

프론트엔드(`web/index.html`)는 UI/음성인식/딥링크 로직을 그대로 유지했고, "Webhook URL" 설정을
"API 서버 URL(ActionFlow 연동)"로만 바꿨습니다.

## 전체 아키텍처

```
브라우저 (web/index.html)
   │ 음성/텍스트 입력, 현재 위치
   │ POST http://localhost:4000/api/search
   ▼
로컬 브릿지 서버 (server/)
   │
   ├─ BACKEND_MODE=actionflow  → 사내 ActionFlow API Trigger 호출 → 응답을 그대로 반환
   │                              (server/src/actionflowClient.js)
   │
   └─ BACKEND_MODE=mock        → ActionFlow 없이 이 서버가 직접
                                   LLM 의도분석 → 카카오 장소검색 → LLM 결과 큐레이션 수행
                                   (server/src/pipeline.js, 기존 n8n-workflow.json과 동일 로직)
   ▼
{ candidates[], destination, transportMode, spoken, topPick, clarification }
   ▼
브라우저: 후보 카드 렌더링 → "길찾기" 클릭 → 네이버지도 앱/웹 딥링크
```

`mock` 모드는 ActionFlow 플로우를 아직 사내 도구에 구성하기 전에도 프론트엔드를 바로 테스트할 수
있게 해줍니다(해커톤 데모 최소 안전망). 원래 `n8nMapService/n8n-workflow.json`의 노드 구성을 그대로
ActionFlow에 옮겨 만든 뒤 `.env`의 `BACKEND_MODE=actionflow`로 바꾸면, 프론트엔드 코드 수정 없이
전환됩니다.

## 로컬 실행

### 필요한 설치

- **Node.js 18+** (권장 20/22) — 이 서버(`server/`)를 실행하는 데 필요합니다.
- **nginx는 필수 아님.** `server/`(Express)가 정적 파일 서빙(`web/`)과 `/api`를 모두 처리하므로,
  기본 로컬 데모는 nginx 없이 `http://localhost:4000` 하나로 끝납니다.
  사내망 고정 포트/도메인으로 묶거나 리버스 프록시가 필요한 경우에만 `nginx/nginx.conf.example`을
  참고해 설치하세요 (`sudo apt-get install -y nginx` / `brew install nginx`).
- Web Speech API(음성 인식)는 크롬 기준이며 `localhost`에서는 HTTP로도 동작합니다.

### 실행

```bash
cd server
cp .env.example .env      # 값 채우기 (아래 "설정" 참고)
npm install
npm start                 # http://localhost:4000
```

브라우저에서 `http://localhost:4000` 접속 → 우상단 설정 → "API 서버 URL"이
`http://localhost:4000/api/search`인지 확인(기본값) → 저장.

### 설정 (`server/.env`)

- `BACKEND_MODE=mock` (기본값): ActionFlow 없이 로컬에서 바로 동작. `LLM_PROVIDER`(gemini/claude),
  해당 API 키, `KAKAO_REST_API_KEY`(developers.kakao.com)가 필요합니다.
- `BACKEND_MODE=actionflow`: 사내 ActionFlow 연동. ActionFlow에서 만든 플로우의 API Trigger URI를
  `ACTIONFLOW_API_URL`에 넣으면 됩니다 (인증이 있다면 `ACTIONFLOW_API_KEY`도).

## 저장소 구조

```
web/       프론트엔드 (단일 파일 SPA, n8nMapService/index.html 기반)
server/    로컬 브릿지 서버 (Express) — ActionFlow 연동 + mock 모드
worker/    Cloudflare Worker 진입점 (server/src/pipeline.js를 그대로 재사용)
nginx/     선택 사항: 리버스 프록시 예시 설정
```

## Cloudflare Worker 배포 (실제 API 그대로 쓰는 배포본)

GitHub Pages 데모(아래)는 브라우저에서 직접 호출 가능한 것만 쓰다 보니 Naver Directions(이동시간)를
못 쓰는 제약이 있었습니다. Cloudflare Worker는 **정적 파일(`web/`)과 API(`/api/*`)를 같은
오리진에서 함께 서빙**하기 때문에 `server/`와 동일하게 모든 API를 서버사이드로 그대로 씁니다
(CORS 문제 없음, 키도 브라우저에 노출 안 됨).

- `wrangler.toml`의 `[assets]`가 `web/`을 정적으로 서빙하고, 그 경로에 없는 요청(`/api/*`)만
  `worker/src/index.js`의 Worker 코드가 처리합니다.
- `worker/src/index.js`는 `server/src/pipeline.js`(mock 모드 로직)를 그대로 import해서 씁니다 —
  로컬 서버와 배포본이 다른 로직을 갖지 않도록, 로직을 복제하지 않고 재사용합니다.
- 프론트엔드(`web/index.html`)의 `CONFIG.webhookUrl` 기본값이 상대경로(`/api/search`)라
  로컬(`server/`)과 Cloudflare Worker 양쪽에서 그대로 동작합니다. `shouldUseClientPipeline()`은
  `*.github.io`일 때만 브라우저-전용 파이프라인(`pipeline-client.js`)을 강제로 씁니다.

**Cloudflare 대시보드에서 해야 하는 것** (Worker 생성 + GitHub 레포 연동은 이미 완료했다는 전제):

1. Worker → **Settings → Variables and Secrets**에 아래 5개 등록 (Production/Preview 모두):
   `OPENAI_API_KEY`, `KAKAO_REST_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`
2. 레포에 push하면(Workers Builds가 Git 연동돼 있으므로) 자동으로 `wrangler deploy`가 돌아 배포됩니다.
3. Worker의 배포 도메인(`https://<이름>.<계정>.workers.dev` 또는 커스텀 도메인)으로 접속해서 확인.

로컬 개발(`server/`)에는 영향 없습니다 — 두 배포본이 같은 `server/src/pipeline.js`를 공유할 뿐,
서로 독립적으로 동작합니다.

### Google Calendar 연동 (서버사이드 refresh token)

예전엔 Google Identity Services 팝업(implicit flow)으로 액세스 토큰(수명 ~1시간)만 받아서
브라우저 localStorage에 저장했다가, 만료되면 매번 재연결해야 했습니다. Cloudflare Worker가
생긴 뒤로는 Authorization Code 방식으로 바꿔서, Worker가 `refresh_token`을 HttpOnly 쿠키(브라우저
JS로는 절대 못 읽음)로만 들고 있고 필요할 때마다 새 액세스 토큰을 대신 발급해줍니다 — 그래서
재연결 없이 계속 유지됩니다 (`server/src/googleAuth.js` + `server/src/cookies.js`, `worker/src/index.js`의
`/api/auth/google/*` 라우트).

- **Google Cloud Console**에서 미리 해야 하는 것: OAuth 클라이언트의 "승인된 리디렉션 URI"에
  `https://<Worker 도메인>/api/auth/google/callback` 추가, "클라이언트 보안 비밀"을 Cloudflare
  Worker의 `GOOGLE_CLIENT_SECRET` 시크릿으로 등록.
- **로컬(`server/`)에는 아직 이 라우트가 없습니다** — `/api/health`의 `googleAuthAvailable`이
  `false`라 프론트엔드가 자동으로 "연동 불가" 안내만 보여주고 mock 일정으로 폴백합니다(3-state UX
  그대로). 로컬에서도 쓰려면 같은 방식으로 `server/src/index.js`에 라우트를 추가하고
  `http://localhost:4000/api/auth/google/callback`을 리디렉션 URI에 추가로 등록해야 합니다.
- ⚠️ **OAuth 동의 화면이 "테스트" 상태면 refresh_token이 7일 후 만료됩니다** (Google 정책). 하커톤
  기간을 넘겨 계속 쓰려면 Google Cloud Console → OAuth 동의 화면에서 "프로덕션으로 게시"가
  필요합니다 (`calendar.readonly`는 민감 범위라 완전한 Google 검수 없이도 게시는 되지만, 사용자가
  로그인할 때 "확인되지 않은 앱" 경고 화면이 한 번 뜹니다 — "고급 > 이동" 클릭하면 계속 진행 가능).

## GitHub Pages 데모 배포 (임시)

`server/`(비밀키를 다루는 백엔드) 없이, 다른 사람에게 링크만으로 검증을 부탁하고 싶을 때를 위한
**정적 배포** 경로입니다. `.github/workflows/deploy-pages.yml`이 `web/`만 GitHub Pages로 배포하고,
`web/pipeline-client.js`가 `server/src/pipeline.js`와 동일한 로직(LLM 의도분석 → 카카오 검색 →
LLM 큐레이션)을 **브라우저에서 직접** 수행합니다.

- 카카오 검색: REST API 키는 브라우저에서 CORS로 막혀 있어, Kakao Maps **JavaScript 키**로 Kakao
  Maps JS SDK(`services.Places`)를 대신 씁니다. Kakao Developers 콘솔의 "Web 플랫폼"에 배포될
  도메인(`https://<owner>.github.io`)을 허용 도메인으로 등록해야 합니다.
- LLM: OpenAI API는 브라우저에서 직접 호출 가능해서 그대로 씁니다.
- 오늘 일정 자동차 이동시간: **NAVER Directions 5 API는 브라우저에서 CORS로 막혀 있어서**(NCP
  포럼에도 동일 리포트 있음, 실제로 `TypeError: Failed to fetch`로 확인됨) 정적 배포에서는 아예
  호출하지 않고, 처음부터 직선거리+평균속도 추정치를 씁니다(타임라인에 "(추정)" 표시). 실제 API
  기반 정확한 이동시간은 `server/`를 로컬로 띄운 경우에만 동작합니다(아래 참고).

**필요한 repo secret** (Settings → Secrets and variables → Actions):

| Secret | 용도 |
|---|---|
| `OPENAI_API_KEY` | 데모 방문자가 자기 키 없이도 AI 추천을 써볼 수 있게 하는 기본 OpenAI 키 |
| `KAKAO_JS_KEY` | Kakao Developers에서 발급받은 **JavaScript** 키 (REST 키와 다름) |

⚠️ **주의**: 이 키들은 배포된 정적 페이지의 소스에 그대로 노출됩니다(누구나 조회 가능). 사내
해커톤 검증용 **임시 배포**로만 쓰고, 실제 서비스는 `server/` + ActionFlow 연동
(`BACKEND_MODE=actionflow`) 방식을 쓰세요.

로컬 개발(`localhost`)에는 영향 없습니다 — `web/index.html`은 `localhost`에서 열리면 지금까지처럼
`server/`의 Node 브릿지를 그대로 씁니다. 설정에서 "API 서버 URL"을 비워두면 로컬에서도 클라이언트
파이프라인을 강제로 테스트해볼 수 있습니다.

### 오늘 일정 자동차 이동시간 (server/ 로컬 실행 시에만 정확)

`server/.env`에 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`(NAVER Cloud Platform Maps → Directions 5,
월 60,000건 무료)을 채우면, 실제 교통상황을 반영한 정확한 이동시간을 씁니다 — 서버-서버 호출이라
CORS 제약이 없습니다. 비워두면(또는 GitHub Pages 정적 배포에서는 항상) 직선거리+평균속도 추정치로
자동 대체되고 타임라인에 "(추정)"으로 표시됩니다.
