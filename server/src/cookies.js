'use strict';

// server/(Express)와 worker/(Cloudflare Worker) 양쪽에서 그대로 쓰는 쿠키 파싱/직렬화.
// 둘 다 표준 HTTP Cookie/Set-Cookie 헤더 문자열만 다루므로 런타임 의존 없이 공용으로 쓸 수 있다.

function parseCookies(cookieHeader) {
  const out = {};
  (cookieHeader || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch (e) {
      out[key] = value;
    }
  });
  return out;
}

// maxAgeSeconds: 0을 넘기면 즉시 만료(쿠키 삭제)로 씀.
function serializeCookie(name, value, opts) {
  opts = opts || {};
  let str = `${name}=${encodeURIComponent(value)}`;
  str += `; Path=${opts.path || '/'}`;
  if (opts.maxAgeSeconds != null) str += `; Max-Age=${opts.maxAgeSeconds}`;
  if (opts.httpOnly !== false) str += '; HttpOnly';
  str += `; SameSite=${opts.sameSite || 'Lax'}`;
  // 로컬 개발(http://localhost)에서는 Secure 쿠키가 브라우저에서 아예 저장되지 않으므로,
  // https로 서빙될 때만(Cloudflare Worker 등) Secure를 붙인다.
  if (opts.secure) str += '; Secure';
  return str;
}

module.exports = { parseCookies, serializeCookie };
