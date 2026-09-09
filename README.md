# egeneSalesNavigator

음성으로 목적지를 말하면 AI가 장소를 검색하고 길찾기로 연결해주는 웹 앱입니다. 연결할
내비게이션 앱(네이버 지도/티맵)은 설정에서 고를 수 있습니다.
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
   │ 음성/텍스트 입력, 현재 위치, 캘린더 연동
   │ POST http://localhost:4000/api/search  (+ /api/auth/google/*)
   ▼
로컬 브릿지 서버 (server/)
   │
   ├─ /api/search: body.inputType으로 4개 플로우 중 하나를 고른다 (pickFlowKey)
   │   ├─ BACKEND_MODE=actionflow → 해당 ActionFlow 플로우의 API Trigger 호출
   │   │                             (server/src/actionflowClient.js)
   │   └─ BACKEND_MODE=mock       → ActionFlow 없이 이 서버가 직접 처리
   │                                 (server/src/pipeline.js, 기존 n8n-workflow.json과 동일 로직)
   │
   └─ /api/auth/google/*: BACKEND_MODE와 무관하게 항상 이 서버가 직접 처리
                            (server/src/googleAuth.js — Google 표준 OAuth라 ActionFlow로 옮기지 않음)
   ▼
브라우저: 후보 카드/브리핑/일정 등록 결과 렌더링
```

`mock` 모드는 ActionFlow 플로우를 아직 사내 도구에 구성하기 전에도 프론트엔드를 바로 테스트할 수
있게 해줍니다(해커톤 데모 최소 안전망). `BACKEND_MODE=actionflow`로 바꾸면 프론트엔드 코드 수정
없이 전환되는데, 지금은 요청 종류(inputType)별로 플로우가 4개로 나뉘어 있습니다 — 각 플로우가
정확히 어떤 요청을 받고 어떤 JSON을 돌려줘야 하는지는 바로 아래 "ActionFlow 플로우 계약"을
참고하세요. Google Calendar 연동(OAuth)은 ActionFlow로 옮기는 대상이 아닙니다 — 사내 도구가
아니라 Google 표준 프로토콜이라 이 서버가 직접 처리합니다.

## ActionFlow 플로우 계약

`BACKEND_MODE=actionflow`일 때 `server/`가 호출하는 소형 플로우들입니다. 각 플로우는 ActionFlow의
API Trigger 노드(POST + JSON body)로 만들고, 마지막 노드(Json Result)에서 아래 "응답" 형태의
JSON을 그대로 돌려주면 됩니다(n8n의 Webhook + Respond to Webhook과 동일한 동기 방식). 요청
바디는 서버가 보낸 것 그대로 전달되므로, 필드 이름은 아래 표와 정확히 일치해야 합니다.

**장소 검색은 `inputType`에 따라 두 갈래로 나뉩니다.** `chip`/`locate`는 즐겨찾기 매칭이나
LLM 없이 카카오 검색만 하면 되므로 원래대로 `ACTIONFLOW_SEARCH_URL` 플로우 하나가 통째로
처리합니다(Switch(inputType)/Plugin-API/Condition/Variable을 실제로 쓰는, 지금까지 만든 것 중
가장 "ActionFlow다운" 플로우 — [`docs/actionflow-notes.md` 11번 항목](docs/actionflow-notes.md#11-variable--switch--condition으로-분기-결과-합류시키기) 참고).
반면 `text`는 즐겨찾기 매칭·원점/지명 해석·카카오 폴백(키워드→카테고리→전국→주소) 같은 분기
로직이 훨씬 복잡해서 `server/src/pipeline.js`의 `runSearchPipeline()`이 **mock 모드와 완전히
동일한 코드**로 직접 처리하고(카카오는 사내 거버넌스 대상이 아닌 공개 REST API라 이 서버가
`KAKAO_REST_API_KEY`로 직접 호출), ActionFlow는 그중 LLM이 꼭 필요한 두 지점만 작은 Agent
플로우로 담당합니다(`server/src/actionflowSearch.js`). 처음엔 `text`도 카카오 폴백/조건 분기까지
전부 ActionFlow 노드로 옮기려 했으나, Condition이 단일 비교만 가능하고 Agent가 tool use를
지원하지 않는 제약 때문에 노드 30개가 넘는 유지보수 어려운 플로우가 됐던 시행착오 끝에 이
구조로 정리했습니다(자세한 경위는 [`docs/actionflow-notes.md` 13번 항목](docs/actionflow-notes.md#13-text-자연어-검색--actionflow는-llm-두-곳만-담당) 참고).

### 1. 장소 검색 — `ACTIONFLOW_SEARCH_URL` (inputType: `chip` / `locate` 전용)

기존 로직: `server/src/pipeline.js`의 `runSearchPipeline()` 중 `skipLLM`(`chip`/`locate`) 분기 —
카카오 키워드 검색만(`locate`는 반경 무제한+정확도순, 0건이면 주소검색 폴백; `chip`은 반경
제한+거리순).

- **요청**: `{ text, lat, lng, landmark, transportMode, categoryGroupCode, inputType, chipRadius, lang, favorites[], recentSearches[], userId }` (프론트엔드가 `/api/search`로 보낸 바디 그대로)
- **응답**: `{ candidates: Candidate[], destination, transportMode, spoken: '', topPick: null, clarification: '' }`
  - `Candidate`: `{ index, name, address, category, lat, lng, distanceM, distanceLabel, phone, placeUrl }`

### 1a. 의도분석 — `ACTIONFLOW_INTENT_URL` (inputType: `text` 전용, Agent 노드 1개)

기존 로직: `resolveIntent()`의 System/User 프롬프트와 동일한 내용을, Agent 노드(tool use 없음)가
순수 JSON으로 출력하도록 프롬프트에서 강제. 발화 하나에서 검색 의도 전체를 뽑아낸다.

- **요청**: `{ text, lat, lng, landmark, transportMode, categoryGroupCode, inputType, chipRadius, lang, favorites[], recentSearches[], userId, llmProvider?, llmApiKey? }` (프론트엔드가 `/api/search`로 보낸 바디 그대로)
- **응답**: `{ intent, query, categoryGroupCode, transportMode, originHint, locationHint, destinationFavoriteName, filters[], spoken, clarification }`
  (필드 의미는 `pipeline.js`의 `INTENT_TOOL_SCHEMA` 참고. `navigate_favorite`인데 `destinationFavoriteName`이 없거나 `ambiguous`인데 `clarification`이 없으면 `intent`를 `'search'`로 되돌려서 반환 — 플로우 안 Code 노드가 처리)

### 1b. 큐레이션 — `ACTIONFLOW_CURATE_URL` (inputType: `text` 전용, 후보가 있을 때만 호출, Agent 노드 1개)

기존 로직: `curateResults()`와 동일한 System/User 프롬프트. 후보 목록 중 사용자 의도에 가장 잘
맞는 곳을 추천/정렬한다(후보 0건이면 이 서버가 호출 자체를 생략함).

- **요청**: `{ candidates: Candidate[], text, filters[], lang }`
- **응답**: `{ candidates: Candidate[] (추천순 재정렬, index 1부터 재부여), spoken, topPick: {index, reason} }`
  - `Candidate`: `{ index, name, address, category, lat, lng, distanceM, distanceLabel, phone, placeUrl }`

### 2. 오늘 일정 브리핑 — `ACTIONFLOW_BRIEFING_URL` (inputType: `briefing`)

기존 로직: `generateBriefing()` — LLM 하나만 호출, 외부 API 없음. `greeting`은 프론트(`web/index.html`의
`computeGreeting()`)가 로컬 시각으로 미리 확정한 인사말이다 — 이 요청엔 현재 시각 자체가
없어서(`scheduleFacts`는 일정 사실만 있음) LLM에 시간 판단을 맡기면 항상 같은 인사말(예:
"좋은 아침이에요")을 반복하는 문제가 있었다. Agent는 이 값을 **그대로** `briefingText` 맨
앞에 써야 하고, 시간을 스스로 판단해 다른 인사말을 지어내면 안 된다.

- **요청**: `{ inputType: 'briefing', lang, greeting, scheduleFacts: { events: [...], tightGapWarnings: [...] }, llmProvider?, llmApiKey? }`
- **응답**: `{ briefingText }`

### 3. 음성 → 일정 생성 — `ACTIONFLOW_CREATE_EVENT_URL` (inputType: `create-event`, Agent 노드 1개)

기존 로직: `parseEventFromText()` — LLM 하나만 호출, 외부 API 없음. 실제 캘린더 등록(POST)은
ActionFlow가 아니라 프론트엔드가 이 응답을 받은 뒤 Google Calendar API로 직접 한다 — 이 플로우는
"발화 해석"만 담당.

- **요청**: `{ inputType: 'create-event', text, lang, todayDate, todayWeekday, nowTime, llmProvider?, llmApiKey? }`
- **응답**: `{ understood: boolean, title, date, startTime, durationMinutes, location, clarification }`
  - `understood:false`면 나머지 필드는 프론트엔드가 쓰지 않으니 `clarification`(왜 이해 못 했는지)만 채워도 됨.

### 4. 실시간 자동차 이동시간 — `ACTIONFLOW_TRAVEL_TIME_URL` (inputType: `travel-time`)

기존 로직: `fetchNaverDrivingMinutes()` — LLM 없음, Naver Directions 5 API 호출만.

- **요청**: `{ inputType: 'travel-time', originLat, originLng, destLat, destLng }`
- **응답**: `{ travelMinutes: number, distanceM: number, real: true }` 성공 시. 실패 시
  `{ travelMinutes: null, distanceM: null, real: false, error }`
  (프론트엔드가 `real:false`면 자동으로 직선거리 추정치로 대체하므로, 실패를 에러로 던지지 말고
  이 형태로 응답해야 함). `distanceM`은 Naver Directions 응답의 `route.summary.distance`(미터)를
  그대로 반올림한 값.

ActionFlow에서 플로우를 실제로 만들 때 겪는 UI 사용법/함정(파라미터 바인딩, 한글 인코딩,
Code 노드, Result JSON 따옴표 규칙 등)은 [`docs/actionflow-notes.md`](docs/actionflow-notes.md)에
정리해뒀습니다.

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
- `BACKEND_MODE=actionflow`: 사내 ActionFlow 연동. `KAKAO_REST_API_KEY`는 `text` 검색(카카오
  폴백을 이 서버가 직접 호출)에 여전히 필요합니다 — `chip`/`locate`는 `ACTIONFLOW_SEARCH_URL`
  플로우가 자체 카카오 연동으로 처리하므로 이 키를 안 씁니다(위 "ActionFlow 플로우 계약" 참고).
  위 계약대로 만든 플로우들의 API Trigger URI를 각각 `ACTIONFLOW_SEARCH_URL` /
  `ACTIONFLOW_INTENT_URL` / `ACTIONFLOW_CURATE_URL` / `ACTIONFLOW_BRIEFING_URL` /
  `ACTIONFLOW_CREATE_EVENT_URL` / `ACTIONFLOW_TRAVEL_TIME_URL`에 넣으면 됩니다(인증이 있다면
  `ACTIONFLOW_API_KEY`도, 전체 공통으로 적용됨).
- **`GOOGLE_CLIENT_SECRET`**: `BACKEND_MODE`와 무관하게 Google Calendar 연동(오늘 일정 브리핑,
  음성 일정 등록)을 쓰려면 항상 필요합니다. Google Cloud Console의 OAuth 클라이언트에서
  "승인된 리디렉션 URI"로 `http://localhost:4000/api/auth/google/callback`을 등록해두세요
  (포트를 바꿨다면 그 포트로).

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

1. Worker → **Settings → Variables and Secrets**에 아래 5개를 **"Runtime variables and
   secrets"**(⚠️ "Build Variables and secrets"가 아님 — 그쪽은 빌드 스크립트 전용이라
   Worker가 요청 처리할 때 못 읽음) 아래, **Type: Secret**으로 등록:
   `OPENAI_API_KEY`, `KAKAO_REST_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`
   (Type을 "Text"로 등록하면 다음 Git 연동 재배포 때 사라지는 걸로 확인됨 — `wrangler.toml`에
   `[vars]`로 선언 안 된 plain variable은 초기화되는 것으로 보임. `LLM_PROVIDER`처럼 민감하지
   않은 값은 아예 `wrangler.toml`의 `[vars]`에 코드로 박아뒀으니 대시보드에 따로 등록할 필요 없음)
2. 레포에 push하면(Workers Builds가 Git 연동돼 있으므로) 자동으로 `wrangler deploy`가 돌아 배포됩니다.
3. Worker의 배포 도메인(`https://<이름>.<계정>.workers.dev` 또는 커스텀 도메인)으로 접속해서 확인.

로컬 개발(`server/`)에는 영향 없습니다 — 두 배포본이 같은 `server/src/pipeline.js`를 공유할 뿐,
서로 독립적으로 동작합니다.

### Google Calendar 연동 (서버사이드 refresh token)

예전엔 Google Identity Services 팝업(implicit flow)으로 액세스 토큰(수명 ~1시간)만 받아서
브라우저 localStorage에 저장했다가, 만료되면 매번 재연결해야 했습니다. Cloudflare Worker가
생긴 뒤로는 Authorization Code 방식으로 바꿔서, Worker가 `refresh_token`을 HttpOnly 쿠키(브라우저
JS로는 절대 못 읽음)로만 들고 있고 필요할 때마다 새 액세스 토큰을 대신 발급해줍니다 — 그래서
재연결 없이 계속 유지됩니다 (`server/src/googleAuth.js` + `server/src/cookies.js`를 공유 모듈로 써서,
`server/src/index.js`와 `worker/src/index.js` 양쪽에 동일한 `/api/auth/google/*` 라우트가 있습니다 —
로컬도 Cloudflare Worker와 동일하게 서버사이드 refresh token 방식으로 동작합니다).

- **Google Cloud Console**에서 미리 해야 하는 것: OAuth 클라이언트의 "승인된 리디렉션 URI"에
  `https://<Worker 도메인>/api/auth/google/callback`과 `http://localhost:4000/api/auth/google/callback`
  둘 다 추가, "클라이언트 보안 비밀"을 Cloudflare Worker의 `GOOGLE_CLIENT_SECRET` 시크릿과
  로컬 `server/.env`의 `GOOGLE_CLIENT_SECRET`에 각각 등록.
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
