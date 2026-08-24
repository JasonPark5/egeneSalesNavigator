'use strict';

// mock 모드: ActionFlow 플로우가 아직 없을 때, 원래 n8n 워크플로우(n8n-workflow.json)와
// 동일한 로직을 이 서버가 직접 수행합니다. ActionFlow 쪽에 같은 단계를 그대로 구성하면
// BACKEND_MODE=actionflow로 전환했을 때 프론트엔드는 코드 변경 없이 동작합니다.

function prepareContext(body) {
  return {
    text: (body.text || '').trim(),
    userLat: parseFloat(body.lat) || 37.5665,
    userLng: parseFloat(body.lng) || 126.978,
    landmark: (body.landmark || '').trim(),
    userTransportMode: body.transportMode || 'transit',
    categoryGroupCode: (body.categoryGroupCode || '').trim(),
    inputType: (body.inputType || 'text').trim(),
    userChipRadius: parseInt(body.chipRadius, 10) || 5000,
    lang: (body.lang || 'ko').trim(),
    favorites: Array.isArray(body.favorites) ? body.favorites : [],
    recentSearches: Array.isArray(body.recentSearches) ? body.recentSearches : [],
    userId: body.userId || 'anonymous',
    skipLLM: (body.inputType || '') === 'chip',
    // 개인 구독 LLM (설정 > 내 연동 설정에서 입력한 경우만). 없으면 서버 기본값(.env) 사용.
    llmOverride: body.llmProvider ? { provider: body.llmProvider, apiKey: body.llmApiKey } : null,
  };
}

const INTENT_TOOL_SCHEMA = {
  name: 'resolve_intent',
  description: '사용자 발화에서 검색 의도를 추출합니다.',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['search', 'navigate_favorite', 'ambiguous'] },
      query: { type: 'string', description: "카카오 키워드 검색에 쓸 정제된 쿼리. 예: '강남 카페'" },
      categoryGroupCode: {
        type: 'string',
        enum: ['', 'FD6', 'CE7', 'CS2', 'PM9', 'SW8', 'PK6', 'BK9', 'OL7', 'HP8', 'MT1'],
      },
      transportMode: { type: 'string', enum: ['transit', 'car'] },
      originHint: { type: 'string', description: "'현재위치' 또는 즐겨찾기 별칭" },
      destinationFavoriteName: { type: 'string' },
      filters: { type: 'array', items: { type: 'string' } },
      spoken: { type: 'string' },
      clarification: { type: 'string' },
    },
    required: ['intent', 'query', 'transportMode', 'originHint', 'filters', 'spoken', 'clarification'],
  },
};

function defaultIntent(ctx) {
  return {
    intent: 'search',
    query: ctx.text,
    categoryGroupCode: ctx.categoryGroupCode || '',
    transportMode: ctx.userTransportMode,
    originHint: '현재위치',
    destinationFavoriteName: '',
    filters: [],
    spoken: '',
    clarification: '',
  };
}

async function callLLMTool({ systemPrompt, userMessage, toolSchema, toolChoiceName, override }) {
  const provider = (override && override.provider) || process.env.LLM_PROVIDER || 'gemini';
  const overrideKey = override && override.provider === provider ? override.apiKey : null;

  if (provider === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const apiKey = overrideKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        tools: [{ function_declarations: [toolSchema] }],
        tool_config: { function_calling_config: { mode: 'ANY', allowed_function_names: [toolChoiceName] } },
        generationConfig: { maxOutputTokens: 800, temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API 오류: HTTP ${res.status}`);
    const data = await res.json();
    const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.functionCall);
    return part?.functionCall?.args || null;
  }

  if (provider === 'claude') {
    const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    const apiKey = overrideKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        system: systemPrompt,
        tools: [{ name: toolSchema.name, description: toolSchema.description, input_schema: toolSchema.parameters }],
        tool_choice: { type: 'tool', name: toolChoiceName },
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API 오류: HTTP ${res.status}`);
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === 'tool_use');
    return block?.input || null;
  }

  if (provider === 'openai') {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const apiKey = overrideKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY가 설정되지 않았습니다.');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        tools: [
          { type: 'function', function: { name: toolSchema.name, description: toolSchema.description, parameters: toolSchema.parameters } },
        ],
        tool_choice: { type: 'function', function: { name: toolChoiceName } },
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API 오류: HTTP ${res.status}`);
    const data = await res.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    return toolCall ? JSON.parse(toolCall.function.arguments) : null;
  }

  throw new Error(`알 수 없는 LLM_PROVIDER: ${provider}`);
}

async function resolveIntent(ctx) {
  const systemPrompt =
    '당신은 한국 길찾기 앱의 의도 분석 어시스턴트입니다. 사용자의 자연어 발화에서 카카오 로컬 검색에 쓸 쿼리/카테고리/필터를 추출하세요. ' +
    "즐겨찾기 별칭(집, 회사 등)이 발화에 등장하면 originHint에 그 별칭을 넣으세요. 응답 언어는 lang 필드(ko/en)에 맞추세요. " +
    "모호하면 clarification에 짧은 질문을 넣고 intent='ambiguous'.";
  const userMessage = [
    `# 사용자 발화\n"${ctx.text}"`,
    `# 컨텍스트\n- 위치: (${ctx.userLat}, ${ctx.userLng})${ctx.landmark ? ', ' + ctx.landmark + ' 근처' : ''}\n- 이동수단 기본: ${ctx.userTransportMode}\n- 입력 방식: ${ctx.inputType}\n- 언어: ${ctx.lang}`,
    `# 즐겨찾기\n${JSON.stringify(ctx.favorites)}`,
    `# 최근 검색\n${JSON.stringify(ctx.recentSearches)}`,
  ].join('\n\n');

  try {
    const args = await callLLMTool({
      systemPrompt,
      userMessage,
      toolSchema: INTENT_TOOL_SCHEMA,
      toolChoiceName: 'resolve_intent',
      override: ctx.llmOverride,
    });
    return args ? { ...defaultIntent(ctx), ...args } : defaultIntent(ctx);
  } catch (err) {
    return { ...defaultIntent(ctx), _llmError: String(err.message || err) };
  }
}

function buildKakaoUrl(params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://dapi.kakao.com/v2/local/search/keyword.json?${qs}`;
}

async function kakaoSearch(url) {
  const apiKey = process.env.KAKAO_REST_API_KEY;
  if (!apiKey) throw new Error('KAKAO_REST_API_KEY가 설정되지 않았습니다.');
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${apiKey}` } });
  if (!res.ok) throw new Error(`카카오 검색 API 오류: HTTP ${res.status}`);
  return res.json();
}

function normalizeKakaoResults(data) {
  const docs = data?.documents || [];
  return docs.map((d, i) => {
    const dm = parseInt(d.distance, 10) || 0;
    return {
      index: i + 1,
      name: d.place_name,
      address: d.road_address_name || d.address_name || '',
      category: d.category_group_name || (d.category_name || '').split(' > ').pop() || '',
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      distanceM: dm,
      distanceLabel: dm < 1000 ? `${dm}m` : `${(dm / 1000).toFixed(1)}km`,
      phone: d.phone || '',
      placeUrl: d.place_url || '',
    };
  });
}

const CURATE_TOOL_SCHEMA = {
  name: 'curate_results',
  description: '검색 결과 후보 중 사용자 의도에 가장 잘 맞는 곳을 추천합니다.',
  parameters: {
    type: 'object',
    properties: {
      rankedIndices: { type: 'array', items: { type: 'integer' } },
      topPickIndex: { type: 'integer' },
      topPickReason: { type: 'string' },
      spoken: { type: 'string' },
    },
    required: ['rankedIndices', 'topPickIndex', 'topPickReason', 'spoken'],
  },
};

async function curateResults({ candidates, originalText, filters, lang, spokenFallback, override }) {
  const fallback = {
    candidates,
    spoken: spokenFallback || '',
    topPick: { index: 0, reason: '' },
  };
  if (candidates.length === 0) return fallback;

  const systemPrompt =
    '당신은 검색 결과 큐레이터입니다. 사용자의 필터/분위기/의도와 후보들의 카테고리/거리를 종합해 가장 맞는 곳을 추천하세요. 응답 언어는 ko/en에 맞춥니다.';
  const userMessage = [
    `# 원본 발화\n"${originalText}"`,
    `# 의도 필터\n${JSON.stringify(filters)}`,
    `# 언어: ${lang}`,
    `# 후보 (0-based)\n${JSON.stringify(
      candidates.map((c, i) => ({ i, name: c.name, category: c.category, address: c.address, distance: c.distanceLabel }))
    )}`,
  ].join('\n\n');

  try {
    const args = await callLLMTool({
      systemPrompt,
      userMessage,
      toolSchema: CURATE_TOOL_SCHEMA,
      toolChoiceName: 'curate_results',
      override,
    });
    if (!args) return fallback;
    const ordered = (args.rankedIndices || [])
      .map((i) => candidates[i])
      .filter(Boolean)
      .map((c, newI) => ({ ...c, index: newI + 1 }));
    const newTopIdx = (args.rankedIndices || []).indexOf(args.topPickIndex);
    return {
      candidates: ordered.length ? ordered : candidates,
      spoken: args.spoken || spokenFallback || '',
      topPick: { index: newTopIdx >= 0 ? newTopIdx : 0, reason: args.topPickReason || '' },
    };
  } catch {
    return fallback;
  }
}

function findFavorite(favorites, name) {
  return (favorites || []).find((f) => f.alias === name || f.name === name);
}

async function runMockPipeline(body) {
  const ctx = prepareContext(body);

  if (ctx.skipLLM) {
    const q = ctx.text.replace(/근처\s*/g, '').trim() || ctx.text;
    const kakaoUrl = buildKakaoUrl({
      query: q,
      x: ctx.userLng,
      y: ctx.userLat,
      size: '10',
      radius: String(ctx.userChipRadius),
      sort: 'distance',
      category_group_code: ctx.categoryGroupCode,
    });
    const raw = await kakaoSearch(kakaoUrl);
    const candidates = normalizeKakaoResults(raw);
    return {
      candidates,
      destination: q,
      transportMode: ctx.userTransportMode,
      spoken: '',
      topPick: null,
      clarification: '',
    };
  }

  const intent = await resolveIntent(ctx);

  if (intent.intent === 'navigate_favorite' && intent.destinationFavoriteName) {
    const dest = findFavorite(ctx.favorites, intent.destinationFavoriteName);
    if (dest) {
      return {
        candidates: [
          {
            index: 1,
            name: dest.name,
            address: '',
            category: '',
            lat: dest.lat,
            lng: dest.lng,
            distanceM: 0,
            distanceLabel: '',
            phone: '',
            placeUrl: '',
          },
        ],
        destination: dest.alias || dest.name,
        transportMode: intent.transportMode,
        spoken: intent.spoken || '',
        topPick: { index: 0, reason: '' },
        clarification: '',
      };
    }
  }

  if (intent.intent === 'ambiguous' && intent.clarification) {
    return {
      candidates: [],
      destination: '',
      transportMode: intent.transportMode,
      spoken: intent.spoken || intent.clarification,
      topPick: null,
      clarification: intent.clarification,
    };
  }

  let searchLat = ctx.userLat;
  let searchLng = ctx.userLng;
  if (intent.originHint && intent.originHint !== '현재위치') {
    const origin = findFavorite(ctx.favorites, intent.originHint);
    if (origin) {
      searchLat = origin.lat;
      searchLng = origin.lng;
    }
  }

  const query = intent.query || ctx.text;
  const kakaoUrl = buildKakaoUrl({
    query,
    x: searchLng,
    y: searchLat,
    size: '10',
    sort: 'accuracy',
    category_group_code: intent.categoryGroupCode,
  });
  const raw = await kakaoSearch(kakaoUrl);
  const candidates = normalizeKakaoResults(raw);

  const curated = await curateResults({
    candidates,
    originalText: ctx.text,
    filters: intent.filters || [],
    lang: ctx.lang,
    spokenFallback: intent.spoken,
    override: ctx.llmOverride,
  });

  return {
    candidates: curated.candidates,
    destination: query,
    transportMode: intent.transportMode,
    spoken: curated.spoken,
    topPick: curated.topPick,
    clarification: '',
  };
}

module.exports = { runMockPipeline };
