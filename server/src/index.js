'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { runMockPipeline } = require('./pipeline');
const { runActionFlow, ActionFlowError } = require('./actionflowClient');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 4000;
const BACKEND_MODE = process.env.BACKEND_MODE || 'mock';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'web')));

app.post('/api/search', async (req, res) => {
  try {
    const result =
      BACKEND_MODE === 'actionflow' ? await runActionFlow(req.body) : await runMockPipeline(req.body);
    res.json(result);
  } catch (err) {
    const status = err instanceof ActionFlowError ? 502 : 500;
    console.error('[search] failed:', err);
    res.status(status).json({ error: err.message || 'search failed' });
  }
});

app.get('/api/health', (req, res) => {
  // Google Calendar OAuth(리디렉션 + refresh token)는 아직 이 로컬 서버가 아니라
  // Cloudflare Worker(worker/)에만 구현되어 있음 — 프론트엔드가 이 값으로 "연동하기"
  // 버튼 클릭 시 실제 라우트가 있는지 미리 판단한다.
  res.json({ ok: true, mode: BACKEND_MODE, googleAuthAvailable: false });
});

app.listen(PORT, () => {
  console.log(`ActionFlow bridge server listening on http://localhost:${PORT} (mode=${BACKEND_MODE})`);
});
