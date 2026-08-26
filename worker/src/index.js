// Cloudflare Worker 진입점 — server/src/index.js(Express)와 같은 역할을 한다.
// 실제 검색/브리핑/이동시간/캘린더 인증 로직은 여기서 새로 짜지 않고 server/src/의
// 공용 모듈을 그대로 가져다 쓴다(로컬 서버와 배포본이 다른 로직을 갖게 되는 걸 막기 위함).
// 전부 CommonJS(module.exports)라 default import로 받아서 구조분해한다.
import pipelineModule from '../../server/src/pipeline.js';
import googleAuthModule from '../../server/src/googleAuth.js';
import cookiesModule from '../../server/src/cookies.js';

const { runMockPipeline } = pipelineModule;
const { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, revokeToken } = googleAuthModule;
const { parseCookies, serializeCookie } = cookiesModule;

// GOOGLE_CLIENT_ID는 비밀값이 아니라(프론트엔드에도 그대로 노출되는 값) 여기 하드코딩해서
// 씀 — GOOGLE_CLIENT_SECRET만 Worker 시크릿(env)에 등록되어 있으면 된다.
const GOOGLE_CLIENT_ID = '713919915373-2qd7kduon7u1gestp2tfoqulfupqaiku.apps.googleusercontent.com';
const OAUTH_STATE_COOKIE = 'g_oauth_state';
const REFRESH_TOKEN_COOKIE = 'g_rt';
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 180; // 180일

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: JSON_HEADERS });
}

function redirect(location, status) {
  return new Response(null, { status: status || 302, headers: { Location: location } });
}

export default {
  async fetch(request, env, ctx) {
    // pipeline.js는 process.env.OPENAI_API_KEY 등을 그대로 참조하는 코드다.
    // nodejs_compat 플래그가 process 전역 자체는 만들어주지만 Worker 시크릿/환경변수를
    // process.env에 자동으로 채워주지는 않으므로, 요청마다 이 Worker의 env(=대시보드에
    // 등록한 시크릿/변수)를 process.env에 직접 연결해준다. process.env 자체를 통째로
    // 재할당하면 실제 workerd 런타임에서 재할당이 막혀 있을 가능성이 있어, 기존 객체를
    // 그대로 두고 속성만 덮어쓰는 Object.assign을 쓴다(더 안전한 방식).
    Object.assign(process.env, env);

    const url = new URL(request.url);
    const isHttps = url.protocol === 'https:';

    // 이 fetch 핸들러는 web/ 안의 실제 파일과 경로가 일치하지 않을 때만 호출된다
    // (정적 자산 우선 라우팅 — wrangler.toml의 [assets] 참고). 그래서 여기 도달하는
    // 경로는 사실상 전부 /api/*.
    if (url.pathname === '/api/health') {
      return json({ ok: true, mode: 'cloudflare-worker', googleAuthAvailable: true });
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

    // ─── Google Calendar OAuth (Authorization Code + refresh token) ───
    // 팝업(implicit flow) 대신 리디렉션 방식을 쓴다: /start가 Google 동의 화면으로 보내고,
    // Google이 /callback으로 code를 돌려주면 refresh_token을 HttpOnly 쿠키에만 저장한다
    // (브라우저 JS는 절대 못 읽음). 프론트엔드는 /access-token을 호출해 그때그때 짧은
    // 액세스 토큰만 받아서 쓴다 — 재연결 없이 계속 유지되는 이유.
    if (url.pathname === '/api/auth/google/start') {
      const state = crypto.randomUUID();
      const redirectUri = url.origin + '/api/auth/google/callback';
      const authorizeUrl = buildAuthorizeUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri, state });
      const headers = new Headers({ Location: authorizeUrl });
      headers.append(
        'Set-Cookie',
        serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 300, sameSite: 'Lax', secure: isHttps })
      );
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/api/auth/google/callback') {
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const cookies = parseCookies(request.headers.get('Cookie'));
      const expectedState = cookies[OAUTH_STATE_COOKIE];
      const clearStateCookie = serializeCookie(OAUTH_STATE_COOKIE, '', {
        maxAgeSeconds: 0,
        sameSite: 'Lax',
        secure: isHttps,
      });

      function finish(status, extraSetCookie) {
        const headers = new Headers({ Location: url.origin + '/?calendar=' + status });
        headers.append('Set-Cookie', clearStateCookie);
        if (extraSetCookie) headers.append('Set-Cookie', extraSetCookie);
        return new Response(null, { status: 302, headers });
      }

      if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
        console.error('[auth] state 불일치 또는 code 없음 — CSRF 방지로 거부');
        return finish('error');
      }

      try {
        const redirectUri = url.origin + '/api/auth/google/callback';
        const tokens = await exchangeCodeForTokens({
          clientId: GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          code,
          redirectUri,
        });
        if (!tokens.refresh_token) {
          // access_type=offline + prompt=consent를 항상 붙이므로 정상적으론 안 일어나지만
          // 방어적으로 처리(예: 이미 이 앱에 동의한 상태에서 Google이 refresh_token을 생략하는 경우).
          console.error('[auth] Google 응답에 refresh_token이 없음');
          return finish('error');
        }
        const rtCookie = serializeCookie(REFRESH_TOKEN_COOKIE, tokens.refresh_token, {
          maxAgeSeconds: REFRESH_TOKEN_MAX_AGE,
          sameSite: 'Lax',
          secure: isHttps,
        });
        return finish('connected', rtCookie);
      } catch (err) {
        console.error('[auth] Google 토큰 교환 실패:', err);
        return finish('error');
      }
    }

    if (url.pathname === '/api/auth/google/access-token') {
      const cookies = parseCookies(request.headers.get('Cookie'));
      const refreshToken = cookies[REFRESH_TOKEN_COOKIE];
      if (!refreshToken) return json({ connected: false });
      try {
        const tokens = await refreshAccessToken({
          clientId: GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          refreshToken,
        });
        return json({ connected: true, accessToken: tokens.access_token, expiresIn: tokens.expires_in });
      } catch (err) {
        console.error('[auth] Google 액세스 토큰 갱신 실패:', err);
        return json({ connected: false });
      }
    }

    if (url.pathname === '/api/auth/google/disconnect' && request.method === 'POST') {
      const cookies = parseCookies(request.headers.get('Cookie'));
      const refreshToken = cookies[REFRESH_TOKEN_COOKIE];
      if (refreshToken) await revokeToken(refreshToken);
      const headers = new Headers(JSON_HEADERS);
      headers.append(
        'Set-Cookie',
        serializeCookie(REFRESH_TOKEN_COOKIE, '', { maxAgeSeconds: 0, sameSite: 'Lax', secure: isHttps })
      );
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
