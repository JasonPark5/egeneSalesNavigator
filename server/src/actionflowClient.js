'use strict';

// 사내 ActionFlow REST API 브릿지.
// ActionFlow는 (n8n의 webhook trigger + 즉시 응답 방식과 달리) "실행 시작 -> 폴링으로
// 완료 확인" 방식으로 연동한다고 가정합니다. 실제 엔드포인트/필드명은 회사마다 다를 수
// 있으므로 .env의 ACTIONFLOW_* 값으로 조정하고, 인증 방식이 Bearer 토큰이 아니라면
// buildAuthHeaders()만 사내 스펙에 맞게 고치면 됩니다.

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function buildAuthHeaders() {
  const apiKey = process.env.ACTIONFLOW_API_KEY || '';
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

function resolvePath(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key] ?? ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const baseUrl = process.env.ACTIONFLOW_BASE_URL;
  const flowId = process.env.ACTIONFLOW_FLOW_ID;
  if (!baseUrl || !flowId) {
    throw new ActionFlowError(
      'ACTIONFLOW_BASE_URL / ACTIONFLOW_FLOW_ID가 설정되지 않았습니다. server/.env를 확인하세요.'
    );
  }

  const triggerPath = resolvePath(process.env.ACTIONFLOW_TRIGGER_PATH || '/api/v1/flows/{flowId}/runs', {
    flowId,
  });

  // 1) 실행 트리거
  const triggerRes = await fetch(baseUrl.replace(/\/$/, '') + triggerPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
    body: JSON.stringify({ input: payload }),
  });
  if (!triggerRes.ok) {
    throw new ActionFlowError(`ActionFlow 트리거 실패: HTTP ${triggerRes.status}`);
  }
  const triggerBody = await triggerRes.json();
  const runId = getByPath(triggerBody, process.env.ACTIONFLOW_RUN_ID_FIELD || 'runId');
  if (!runId) {
    throw new ActionFlowError(
      `ActionFlow 응답에서 실행 ID를 찾지 못했습니다 (ACTIONFLOW_RUN_ID_FIELD=${process.env.ACTIONFLOW_RUN_ID_FIELD}). 응답: ${JSON.stringify(
        triggerBody
      ).slice(0, 300)}`
    );
  }

  // 2) 완료될 때까지 폴링
  const statusPathTemplate = process.env.ACTIONFLOW_STATUS_PATH || '/api/v1/runs/{runId}';
  const statusField = process.env.ACTIONFLOW_STATUS_FIELD || 'status';
  const resultField = process.env.ACTIONFLOW_RESULT_FIELD || 'result';
  const doneValues = (process.env.ACTIONFLOW_DONE_VALUES || 'completed,success,done')
    .split(',')
    .map((s) => s.trim().toLowerCase());
  const errorValues = (process.env.ACTIONFLOW_ERROR_VALUES || 'failed,error')
    .split(',')
    .map((s) => s.trim().toLowerCase());
  const pollIntervalMs = parseInt(process.env.ACTIONFLOW_POLL_INTERVAL_MS, 10) || 1500;
  const pollTimeoutMs = parseInt(process.env.ACTIONFLOW_POLL_TIMEOUT_MS, 10) || 30000;
  const statusUrl = baseUrl.replace(/\/$/, '') + resolvePath(statusPathTemplate, { runId });

  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await fetch(statusUrl, { headers: buildAuthHeaders() });
    if (!statusRes.ok) {
      throw new ActionFlowError(`ActionFlow 상태 조회 실패: HTTP ${statusRes.status}`);
    }
    const statusBody = await statusRes.json();
    const status = String(getByPath(statusBody, statusField) || '').toLowerCase();

    if (doneValues.includes(status)) {
      const result = getByPath(statusBody, resultField);
      if (!result) {
        throw new ActionFlowError(`ActionFlow 실행은 완료됐지만 결과(${resultField})가 비어 있습니다.`);
      }
      return result;
    }
    if (errorValues.includes(status)) {
      throw new ActionFlowError(`ActionFlow 실행 실패 (status=${status})`);
    }
    await sleep(pollIntervalMs);
  }

  throw new ActionFlowError(`ActionFlow 실행이 ${pollTimeoutMs}ms 안에 끝나지 않았습니다 (runId=${runId}).`);
}

module.exports = { runActionFlow, ActionFlowError };
