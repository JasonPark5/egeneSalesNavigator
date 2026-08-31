'use strict';

// 사내 ActionFlow API Trigger 브릿지. 요청 종류(inputType)별로 별도 플로우를 호출한다 —
// 검색/브리핑/일정생성/이동시간은 쓰는 외부 API와 LLM 사용 여부가 서로 달라서, 플로우
// 하나에 스위치로 다 몰아넣기보다 나누는 쪽이 ActionFlow에서도 만들고 유지보수하기 쉽다.
// 각 플로우는 API Trigger 노드(POST, JSON body)로 호출하면 실행이 끝날 때까지 기다렸다가
// 마지막 노드(Json Result)에서 구성한 JSON을 그대로 HTTP 응답으로 돌려주는 동기 방식임을
// 확인했습니다 (n8n의 Webhook + Respond to Webhook과 동일한 모양). 그래서 트리거만 하면
// 끝 - 별도 폴링이 필요 없습니다.

// index.js의 pickFlowKey()가 body.inputType을 보고 이 중 하나로 매핑한다.
const FLOW_ENV_KEYS = {
  search: 'ACTIONFLOW_SEARCH_URL', // text/chip/locate 공통 — 장소 검색(Kakao) + (필요시) LLM
  briefing: 'ACTIONFLOW_BRIEFING_URL', // 오늘 일정 사실 -> 음성 브리핑 문장 (LLM만)
  'create-event': 'ACTIONFLOW_CREATE_EVENT_URL', // 발화 -> 일정 제목/날짜/시간/장소 (LLM만)
  'travel-time': 'ACTIONFLOW_TRAVEL_TIME_URL', // 실시간 자동차 이동시간 (Naver Directions만, LLM 없음)
};

function buildAuthHeaders() {
  const apiKey = process.env.ACTIONFLOW_API_KEY || '';
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

// 임시 디버깅용: 앞단 게이트웨이가 브라우저 세션(쿠키/CSRF 토큰 등)이 없는 요청을 막는
// 정황이 있어서, 정확한 헤더 이름을 모르는 채로도 빠르게 실험해볼 수 있게 임의의 헤더를
// JSON으로 넣을 수 있게 했다. 예: ACTIONFLOW_EXTRA_HEADERS={"X-CSRF-Token":"...","Cookie":"..."}
// 주의: CSRF 토큰은 보통 세션에 묶여 있어서 곧 만료되고, 이 값을 .env에 박아두는 건
// 임시 확인용일 뿐 — 진짜 해결책은 ActionFlow/IT 쪽에 서버 대 서버 인증 방법을 물어보는 것.
function buildExtraHeaders() {
  const raw = process.env.ACTIONFLOW_EXTRA_HEADERS || '';
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[actionflowClient] ACTIONFLOW_EXTRA_HEADERS가 올바른 JSON이 아닙니다: ' + ((err && err.message) || String(err)));
    return {};
  }
}

class ActionFlowError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ActionFlowError';
    if (cause) this.cause = cause;
  }
}

// flowKey: FLOW_ENV_KEYS의 키 중 하나 ('search' | 'briefing' | 'create-event' | 'travel-time')
// payload: 프론트엔드가 /api/search로 보낸 요청 바디 그대로
// 반환값: 각 플로우가 만들어야 하는 응답 계약은 README의 "ActionFlow 플로우 계약" 참고
async function runActionFlow(flowKey, payload) {
  const envKey = FLOW_ENV_KEYS[flowKey];
  if (!envKey) {
    throw new ActionFlowError(`알 수 없는 ActionFlow 플로우 키: ${flowKey}`);
  }
  const url = process.env[envKey];
  if (!url) {
    throw new ActionFlowError(`${envKey}가 설정되지 않았습니다. server/.env를 확인하세요.`);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(), ...buildExtraHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // 상태코드만으로는 원인을 알 수 없다(플로우 비활성화, 인증 게이트웨이 차단, ActionFlow
    // 자체 에러 등이 전부 4xx/5xx로 나올 수 있음) — 응답 본문을 최대한 실어서 던진다.
    const detail = await res.text().catch(() => '(응답 본문을 읽을 수 없음)');
    throw new ActionFlowError(
      `ActionFlow 호출 실패(${flowKey}): HTTP ${res.status} — ${detail.slice(0, 500)}`
    );
  }
  return res.json();
}

// body.inputType -> 호출할 플로우 키. text/chip/locate는 전부 하나의 "검색" 플로우로 묶는다
// (pipeline.js의 runMockPipeline()도 내부적으로 이 셋을 같은 함수 안에서 분기하는 것과 동일한 경계).
function pickFlowKey(body) {
  const inputType = (body && body.inputType) || 'text';
  if (inputType === 'briefing') return 'briefing';
  if (inputType === 'create-event') return 'create-event';
  if (inputType === 'travel-time') return 'travel-time';
  return 'search'; // 'text' | 'chip' | 'locate'
}

module.exports = { runActionFlow, pickFlowKey, ActionFlowError };
