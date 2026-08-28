'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { runMockPipeline } = require('./pipeline');
const { runActionFlow, pickFlowKey, ActionFlowError } = require('./actionflowClient');
const { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, revokeToken } = require('./googleAuth');
const { parseCookies, serializeCookie } = require('./cookies');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 4000;
const BACKEND_MODE = process.env.BACKEND_MODE || 'mock';

// GOOGLE_CLIENT_ID는 비밀값이 아니라(프론트엔드에도 그대로 노출되는 값) 여기 하드코딩해서
// 씀 — worker/src/index.js와 동일한 값. GOOGLE_CLIENT_SECRET만 .env에 비밀로 둔다.
const GOOGLE_CLIENT_ID = '713919915373-2qd7kduon7u1gestp2tfoqulfupqaiku.apps.googleusercontent.com';
const OAUTH_STATE_COOKIE = 'g_oauth_state';
const REFRESH_TOKEN_COOKIE = 'g_rt';
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 180; // 180일

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'web')));

app.post('/api/search', async (req, res) => {
  try {
    const result =
      BACKEND_MODE === 'actionflow'
        ? await runActionFlow(pickFlowKey(req.body), req.body)
        : await runMockPipeline(req.body);
    res.json(result);
  } catch (err) {
    const status = err instanceof ActionFlowError ? 502 : 500;
    console.error('[search] failed:', err);
    res.status(status).json({ error: err.message || 'search failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: BACKEND_MODE, googleAuthAvailable: true });
});

// ─── Google Calendar OAuth (Authorization Code + refresh token) ───────────
// worker/src/index.js와 동일한 로직(같은 googleAuth.js/cookies.js 공용 모듈)을 Express
// req/res로 옮긴 것. 팝업(implicit flow) 대신 리디렉션 방식을 쓴다: /start가 Google 동의
// 화면으로 보내고, Google이 /callback으로 code를 돌려주면 refresh_token을 HttpOnly
// 쿠키에만 저장한다(브라우저 JS는 절대 못 읽음). 프론트엔드는 /access-token을 호출해
// 그때그때 짧은 액세스 토큰만 받아서 쓴다 — 재연결 없이 계속 유지되는 이유.
app.get('/api/auth/google/start', (req, res) => {
  const state = crypto.randomUUID();
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const authorizeUrl = buildAuthorizeUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri, state });
  res.setHeader(
    'Set-Cookie',
    serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 300, sameSite: 'Lax', secure: req.secure })
  );
  res.redirect(302, authorizeUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const returnedState = req.query.state;
  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies[OAUTH_STATE_COOKIE];
  const clearStateCookie = serializeCookie(OAUTH_STATE_COOKIE, '', {
    maxAgeSeconds: 0,
    sameSite: 'Lax',
    secure: req.secure,
  });
  const origin = `${req.protocol}://${req.get('host')}`;

  function finish(status, extraSetCookie) {
    const setCookies = extraSetCookie ? [clearStateCookie, extraSetCookie] : [clearStateCookie];
    res.setHeader('Set-Cookie', setCookies);
    res.redirect(302, `${origin}/?calendar=${status}`);
  }

  if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
    console.error('[auth] state 불일치 또는 code 없음 — CSRF 방지로 거부');
    return finish('error');
  }

  try {
    const redirectUri = `${origin}/api/auth/google/callback`;
    const tokens = await exchangeCodeForTokens({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
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
      secure: req.secure,
    });
    return finish('connected', rtCookie);
  } catch (err) {
    console.error('[auth] Google 토큰 교환 실패: ' + ((err && err.message) || String(err)));
    return finish('error');
  }
});

app.get('/api/auth/google/access-token', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const refreshToken = cookies[REFRESH_TOKEN_COOKIE];
  if (!refreshToken) return res.json({ connected: false });
  try {
    const tokens = await refreshAccessToken({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken,
    });
    res.json({ connected: true, accessToken: tokens.access_token, expiresIn: tokens.expires_in });
  } catch (err) {
    console.error('[auth] Google 액세스 토큰 갱신 실패: ' + ((err && err.message) || String(err)));
    res.json({ connected: false });
  }
});

app.post('/api/auth/google/disconnect', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const refreshToken = cookies[REFRESH_TOKEN_COOKIE];
  if (refreshToken) await revokeToken(refreshToken);
  res.setHeader(
    'Set-Cookie',
    serializeCookie(REFRESH_TOKEN_COOKIE, '', { maxAgeSeconds: 0, sameSite: 'Lax', secure: req.secure })
  );
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`ActionFlow bridge server listening on http://localhost:${PORT} (mode=${BACKEND_MODE})`);
});
