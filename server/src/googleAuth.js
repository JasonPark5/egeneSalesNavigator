'use strict';

// Google Calendar OAuth (Authorization Code + refresh token) — server/(로컬)와 worker/
// (Cloudflare Worker) 양쪽이 그대로 가져다 쓰는 공용 로직. Google과 주고받는 부분만 여기
// 하나로 통일하고, 쿠키 읽기/쓰기나 라우팅은 각 런타임(index.js)에서 얇게 감싼다.
//
// 예전 방식(Google Identity Services 팝업, implicit flow)은 액세스 토큰(수명 ~1시간)만
// 받을 수 있어서 그때그때 브라우저에 재연결을 요구했다. 여기서는 access_type=offline +
// prompt=consent로 refresh_token까지 받아서 서버(HttpOnly 쿠키)에만 보관하고, 필요할 때마다
// 새 액세스 토큰을 조용히 재발급한다.

const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// Google 토큰 엔드포인트는 실패 시 본문에 {"error":"invalid_grant","error_description":"..."}
// 같은 구체적인 이유를 담아 응답한다. HTTP 상태코드만 남기면 원인(잘못된 client_secret인지,
// redirect_uri 불일치인지, 이미 쓴 code인지 등)을 알 수가 없어서 본문을 그대로 에러 메시지에 싣는다.
async function readTokenErrorDetail(res) {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch (e) {
    return '(응답 본문을 읽을 수 없음)';
  }
}

async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const detail = await readTokenErrorDetail(res);
    throw new Error(`Google 토큰 교환 실패: HTTP ${res.status} — ${detail}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const detail = await readTokenErrorDetail(res);
    throw new Error(`Google 액세스 토큰 갱신 실패: HTTP ${res.status} — ${detail}`);
  }
  return res.json(); // { access_token, expires_in, ... } — refresh_token은 보통 재발급되지 않음
}

async function revokeToken(token) {
  // 실패해도(이미 취소된 토큰 등) 로그아웃 자체는 계속 진행하는 게 맞아서 에러를 던지지 않는다.
  try {
    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (err) {
    console.error('[googleAuth] revoke 실패: ' + ((err && err.message) || String(err)));
  }
}

module.exports = { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, revokeToken };
