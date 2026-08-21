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
nginx/     선택 사항: 리버스 프록시 예시 설정
```
