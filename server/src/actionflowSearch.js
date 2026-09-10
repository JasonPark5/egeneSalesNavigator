'use strict';

// BACKEND_MODE=actionflow일 때 inputType==='text' 요청을 처리한다(index.js가 chip/locate는
// 이 파일을 거치지 않고 그대로 runActionFlow('search', ...)로 보낸다 — chip/locate는 즐겨찾기
// 매칭/원점 해석 없이 카카오 검색만 하면 돼서, 원래 있던 그 플로우를 그대로 쓴다).
//
// text는 즐겨찾기 매칭 + 원점/지명 해석 + 카카오 폴백 4단계 + LLM 의도분석/큐레이션까지 훨씬
// 복잡하다 — 이걸 전부 ActionFlow 캔버스 하나에 노드 30여 개로 옮기려고 했는데, Condition이
// 단일 비교만 가능하고 Agent가 tool use를 지원하지 않는 등 제약 때문에 유지보수가 어려운
// 초대형 플로우가 됐다.
//
// 대신: 분기/카카오 검색 로직은 pipeline.js의 runSearchPipeline()을 그대로 재사용한다
// (mock 모드와 100% 동일한 코드). ActionFlow는 정말 LLM이 필요한 두 지점, 딱 그만큼만 담당한다:
//   1. 의도분석 — 발화 -> 검색 의도 JSON (Agent 노드 1개짜리 소형 플로우)
//   2. 큐레이션 — 후보 목록 -> 추천/정렬 (Agent 노드 1개짜리 소형 플로우)
// 카카오 검색은 이 서버가 KAKAO_REST_API_KEY로 직접 호출한다(mock 모드와 동일) — 카카오는
// 사내 거버넌스 대상이 아니라 개발자 등록만 하면 되는 공개 REST API라 ActionFlow를 거칠
// 이유가 없다.
//
// 각 플로우가 받아야 하는 요청/돌려줘야 하는 응답은 docs/actionflow-notes.md 13번 항목 참고.

const { runSearchPipeline, defaultIntent } = require('./pipeline');
const { runActionFlow } = require('./actionflowClient');

// 트리거 body를 그대로 넘긴다 — web/index.html의 buildSearchPayload()가 보내는 필드
// 그대로(README "ActionFlow 플로우 계약" 참고)라, 이 서버는 리모델링 없이 그대로 전달만 한다.
async function resolveIntentViaActionFlow(ctx, body) {
  try {
    return await runActionFlow('intent', body);
  } catch (err) {
    return { ...defaultIntent(ctx), _llmError: String(err.message || err) };
  }
}

async function curateResultsViaActionFlow({ candidates, originalText, filters, lang, spokenFallback }) {
  const fallback = { candidates, spoken: spokenFallback || '', topPick: { index: 0, reason: '' } };
  if (candidates.length === 0) return fallback; // pipeline.js의 curateResults()와 동일하게 0건이면 LLM 호출 자체를 생략

  try {
    const res = await runActionFlow('curate', { candidates, text: originalText, filters, lang });
    if (!res || !Array.isArray(res.candidates)) return fallback;
    return {
      candidates: res.candidates,
      spoken: res.spoken || spokenFallback || '',
      topPick: res.topPick || { index: 0, reason: '' },
    };
  } catch {
    return fallback;
  }
}

async function runActionFlowSearch(body) {
  return runSearchPipeline(body, {
    resolveIntentFn: resolveIntentViaActionFlow,
    curateResultsFn: curateResultsViaActionFlow,
  });
}

module.exports = { runActionFlowSearch };
