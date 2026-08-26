// Cloudflare Worker 진입점 — server/src/index.js(Express)와 같은 역할을 한다.
// 실제 검색/브리핑/이동시간 로직은 여기서 새로 짜지 않고 server/src/pipeline.js를
// 그대로 가져다 쓴다(로컬 서버와 배포본이 다른 로직을 갖게 되는 걸 막기 위함).
// pipeline.js는 CommonJS(module.exports)라 default import로 받아서 구조분해한다.
import pipelineModule from '../../server/src/pipeline.js';
const { runMockPipeline } = pipelineModule;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env, ctx) {
    // pipeline.js는 process.env.OPENAI_API_KEY 등을 그대로 참조하는 코드다.
    // nodejs_compat 플래그가 process 전역 자체는 만들어주지만 Worker 시크릿/환경변수를
    // process.env에 자동으로 채워주지는 않으므로, 요청마다 이 Worker의 env(=대시보드에
    // 등록한 시크릿/변수)를 process.env에 직접 연결해준다.
    process.env = env;

    const url = new URL(request.url);

    // 이 fetch 핸들러는 web/ 안의 실제 파일과 경로가 일치하지 않을 때만 호출된다
    // (정적 자산 우선 라우팅 — wrangler.toml의 [assets] 참고). 그래서 여기 도달하는
    // 경로는 사실상 전부 /api/*.
    if (url.pathname === '/api/health') {
      return json({ ok: true, mode: 'cloudflare-worker' });
    }

    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const body = await request.json();
        const result = await runMockPipeline(body);
        return json(result);
      } catch (err) {
        console.error('[search] failed:', err);
        return json({ error: (err && err.message) || 'search failed' }, 500);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
