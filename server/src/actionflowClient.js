'use strict';

// 사내 ActionFlow API Trigger 브릿지.
// API Trigger 노드(POST, JSON body)로 플로우를 호출하면 실행이 끝날 때까지 기다렸다가
// 마지막 노드(Json Result)에서 구성한 JSON을 그대로 HTTP 응답으로 돌려주는 동기 방식임을
// 확인했습니다 (n8n의 Webhook + Respond to Webhook과 동일한 모양). 그래서 트리거만 하면
// 끝 - 별도 폴링이 필요 없습니다.

function buildAuthHeaders() {
  const apiKey = process.env.ACTIONFLOW_API_KEY || '';
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

class ActionFlowError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ActionFlowError';
    if (cause) this.cause = cause;
  }
}

// payload: doSearch()에서 전달하는 요청 바디 (text, lat, lng, transportMode, ...)
// 반환값: 프론트엔드가 기대하는 { candidates, destination, transportMode, spoken, topPick, clarification }
async function runActionFlow(payload) {
  const url = process.env.ACTIONFLOW_API_URL;
  if (!url) {
    throw new ActionFlowError('ACTIONFLOW_API_URL이 설정되지 않았습니다. server/.env를 확인하세요.');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new ActionFlowError(`ActionFlow 호출 실패: HTTP ${res.status}`);
  }
  return res.json();
}

module.exports = { runActionFlow, ActionFlowError };
