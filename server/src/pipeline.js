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
    // chip: 현재 위치 근처(반경 제한) 카테고리 탐색. locate: 이름/주소로 특정 장소를
    // 정확히 찾기(거리 제한 없음, 정확도순) — 캘린더 일정 위치 확인 등에 사용.
    skipLLM: body.inputType === 'chip' || body.inputType === 'locate',
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
      intent: {
        type: 'string',
        enum: ['search', 'navigate_favorite', 'ambiguous'],
        description:
          "즐겨찾기 별칭 자체가 목적지면(예: '집으로 가자') navigate_favorite. " +
          "즐겨찾기 별칭이 검색 기준 위치로만 쓰이면(예: '집 근처 편의점') search (originHint에만 반영, destinationFavoriteName은 비움).",
      },
      query: {
        type: 'string',
        description:
          "카카오 키워드 검색(장소명/업종명 매칭)에 쓸 짧고 구체적인 검색어. 실제 상호명/업종에 들어갈 법한 단어만 넣으세요 (예: '강남 카페', '이자카야', '고기집'). " +
          "'아이랑 갈만한', '분위기 좋은', '데이트하기 좋은' 같은 동반자/분위기/목적 수식어는 query에 넣지 말고 filters에만 넣으세요 — " +
          "그런 수식어를 query에 그대로 넣으면 카카오 검색에서 매칭되는 장소가 없어 결과가 0건이 됩니다. " +
          "구체적인 상호/메뉴가 없으면 categoryGroupCode만으로 찾도록 query는 해당 업종의 일반명사(예: '음식점', '카페')로 짧게 두세요.",
      },
      categoryGroupCode: {
        type: 'string',
        enum: ['', 'FD6', 'CE7', 'CS2', 'PM9', 'SW8', 'PK6', 'BK9', 'OL7', 'HP8', 'MT1'],
        description:
          '요청이 아래 업종 중 하나에 해당하면 query에 구체적인 상호/메뉴가 있어도 항상 같이 채우세요 ' +
          '(카카오 키워드 검색이 0건일 때 이 값으로 업종 기준 재검색하는 안전망으로도 쓰입니다): ' +
          "FD6=음식점/맛집/밥집/식당, CE7=카페, CS2=편의점, PM9=약국, SW8=지하철역, PK6=주차장, " +
          'BK9=은행, OL7=주유소/충전소, HP8=병원, MT1=대형마트. 해당 없으면 빈 문자열.',
      },
      transportMode: {
        type: 'string',
        enum: ['transit', 'car'],
        description:
          "발화에 이동수단이 명시되면(예: '대중교통으로', '차 타고', '걸어서') 그 값을 반영. " +
          "명시되지 않았으면 컨텍스트의 '이동수단 기본' 값을 그대로 사용 (임의로 바꾸지 말 것).",
      },
      originHint: { type: 'string', description: "'현재위치' 또는 즐겨찾기 별칭" },
      destinationFavoriteName: {
        type: 'string',
        description: 'intent가 navigate_favorite일 때만 채움. search일 때는 항상 빈 문자열.',
      },
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
  // 언어 지시가 한국어 프롬프트 문장들 사이에 한 줄 묻혀 있으면 LLM이 잘 안 지킴 —
  // 목표 언어로 된 강한 지시문을 맨 앞/맨 뒤에 반복해서 넣어줌.
  const langDirective =
    ctx.lang === 'en'
      ? 'IMPORTANT: The user\'s UI language is English. Write ALL free-text output fields (spoken, clarification) in English only, even though the instructions below are in Korean. '
      : '중요: 사용자 UI 언어는 한국어입니다. spoken, clarification 등 모든 자유 텍스트 출력 필드를 한국어로 작성하세요. ';
  const systemPrompt =
    langDirective +
    '당신은 한국 길찾기 앱의 의도 분석 어시스턴트입니다. 사용자의 자연어 발화에서 카카오 로컬 검색에 쓸 쿼리/카테고리/필터를 추출하세요. ' +
    "즐겨찾기 별칭(집, 회사 등)이 발화에서 목적지 자체로 쓰이면(예: '집으로 가자', '회사 가는 길') intent='navigate_favorite'이고 destinationFavoriteName에 그 별칭을 넣으세요. " +
    "즐겨찾기 별칭이 검색 기준 위치로만 쓰이면(예: '집 근처 편의점', '회사 주변 카페') intent='search'이고 originHint에만 넣으세요 (destinationFavoriteName은 비움). " +
    "originHint/destinationFavoriteName에 즐겨찾기를 넣을 때는 '# 즐겨찾기' 목록에 있는 alias 값을 토씨 하나 안 틀리고 그대로 복사해서 넣으세요 (예: 목록에 alias:'집'이면 '집근처'/'우리집'이 아니라 정확히 '집'만). " +
    "이동수단(transportMode)은 발화에 명시적으로 언급된 경우에만(예: '대중교통으로', '차 타고') 그 값으로 바꾸고, 언급이 없으면 컨텍스트의 '이동수단 기본' 값을 절대 임의로 바꾸지 말고 그대로 유지하세요. " +
    "query는 실제 상호명/업종에 매칭될 짧은 검색어만 넣고, '아이랑 갈만한' 같은 동반자/분위기/목적 수식어는 query에서 빼서 filters에 넣으세요 (query에 그대로 넣으면 검색결과 0건이 됩니다). " +
    "모호하면 clarification에 짧은 질문을 넣고 intent='ambiguous'. " +
    langDirective;
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

// 키워드 검색이 0건일 때(예: query에 '아이랑 갈만한' 같은 수식어가 섞여 상호명과 매칭이 안 되는 경우)의
// 안전망. category_group_code만으로 업종 기준 장소를 찾는 카카오 카테고리 검색 API.
function buildKakaoCategoryUrl(params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://dapi.kakao.com/v2/local/search/category.json?${qs}`;
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

  const langDirective =
    lang === 'en'
      ? "IMPORTANT: The user's UI language is English. Write ALL free-text output fields (spoken, topPickReason) in English only. "
      : '중요: 사용자 UI 언어는 한국어입니다. spoken, topPickReason 등 모든 자유 텍스트 출력 필드를 한국어로 작성하세요. ';
  const systemPrompt =
    langDirective +
    '당신은 검색 결과 큐레이터입니다. 사용자의 필터/분위기/의도와 후보들의 카테고리/거리를 종합해 가장 맞는 곳을 추천하세요. ' +
    langDirective;
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
  const clean = String(name || '').trim();
  if (!clean) return null;
  // LLM이 별칭을 정확히 그대로("집") 돌려주지 않고 조사가 붙거나("집근처", "집 근처")
  // 앞뒤에 다른 말이 붙어서 올 때가 있어, 완전일치가 안 되면 별칭이 접두어로 포함된
  // 경우까지 허용한다. originHint/destinationFavoriteName은 이미 LLM이 "즐겨찾기 별칭
  // 또는 현재위치"로 좁혀서 뽑은 값이라 임의 문장이 섞여 들어올 일이 없어, 부분일치를
  // 써도 클라이언트 쪽 발화 전체 매칭 때처럼 무관한 단어(예: '맛집')와 충돌하지 않는다.
  return (favorites || []).find(
    (f) =>
      (f.alias && (f.alias === clean || clean.startsWith(f.alias))) ||
      (f.name && (f.name === clean || clean.startsWith(f.name)))
  );
}

// LLM이 categoryGroupCode를 비워서 반환했을 때를 대비한 보조 추론(키워드 기반).
// 카테고리 코드가 있어야 "키워드 검색 0건 -> 카테고리 검색 폴백"이 동작하므로,
// LLM 판단을 신뢰하되 흔한 업종 단어가 원문에 있으면 최소한의 안전망으로 채워준다.
const CATEGORY_KEYWORDS = [
  ['FD6', ['맛집', '밥집', '식당', '고깃집', '고기집', '국밥', '냉면', '분식', '돈까스', '파스타', '이자카야', '포차', '중국집', '일식집', '백반', '뷔페']],
  ['CE7', ['카페', '커피', '디저트', '베이커리', '빵집']],
  ['CS2', ['편의점']],
  ['PM9', ['약국']],
  ['SW8', ['지하철역', '전철역']],
  ['PK6', ['주차장']],
  ['BK9', ['은행', 'atm', '현금인출기']],
  ['OL7', ['주유소', '충전소']],
  ['HP8', ['병원', '의원', '치과', '한의원']],
  ['MT1', ['대형마트', '이마트', '홈플러스', '롯데마트']],
];
function inferCategoryFromText(text) {
  const found = CATEGORY_KEYWORDS.find(([, keywords]) => keywords.some((kw) => text.includes(kw)));
  return found ? found[0] : '';
}

async function runMockPipeline(body) {
  const ctx = prepareContext(body);

  if (ctx.skipLLM) {
    const isLocate = ctx.inputType === 'locate';
    const q = ctx.text.replace(/근처\s*/g, '').trim() || ctx.text;
    const kakaoUrl = buildKakaoUrl({
      query: q,
      x: ctx.userLng,
      y: ctx.userLat,
      size: '10',
      radius: isLocate ? null : String(ctx.userChipRadius),
      sort: isLocate ? 'accuracy' : 'distance',
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
  if (!intent.categoryGroupCode) {
    const inferred = inferCategoryFromText(ctx.text);
    if (inferred) intent.categoryGroupCode = inferred;
  }
  console.log(
    `[search] "${ctx.text}" -> intent=${intent.intent} query="${intent.query}" category=${intent.categoryGroupCode || '(none)'} ` +
      `transportMode=${intent.transportMode} originHint=${intent.originHint} dest=${intent.destinationFavoriteName || '(none)'}` +
      (intent._llmError ? ` llmError=${intent._llmError}` : '')
  );

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
      console.log(`[search] 기준 위치 = 즐겨찾기 "${intent.originHint}" -> (${origin.lat}, ${origin.lng})`);
    } else {
      console.log(
        `[search] 기준 위치 = 즐겨찾기 "${intent.originHint}" (매칭 실패, 현재 GPS로 대체) ` +
          `보유 즐겨찾기: ${JSON.stringify((ctx.favorites || []).map((f) => f.alias || f.name))}`
      );
    }
  }

  const query = intent.query || ctx.text;
  // 정확도순 검색이라도 반경은 걸어둠 — 안 그러면 이름만 비슷한 수백km 밖 결과가 섞여 들어옴.
  // 자동차는 카카오 로컬 API의 radius 파라미터 최대값(20km)까지 허용, 그 외(대중교통/도보)는
  // 사용자가 설정한 칩 검색 반경을 그대로 씀.
  const CAR_SEARCH_RADIUS_M = 20000;
  const searchRadius = intent.transportMode === 'car' ? CAR_SEARCH_RADIUS_M : ctx.userChipRadius;
  const kakaoUrl = buildKakaoUrl({
    query,
    x: searchLng,
    y: searchLat,
    size: '10',
    radius: String(searchRadius),
    sort: 'accuracy',
    category_group_code: intent.categoryGroupCode,
  });
  const raw = await kakaoSearch(kakaoUrl);
  let candidates = normalizeKakaoResults(raw);
  console.log(`[search] 카카오 검색 "${query}" (반경 ${searchRadius}m) -> ${candidates.length}건`);

  if (candidates.length === 0 && intent.categoryGroupCode) {
    const categoryUrl = buildKakaoCategoryUrl({
      category_group_code: intent.categoryGroupCode,
      x: searchLng,
      y: searchLat,
      size: '10',
      radius: String(searchRadius),
      sort: 'distance',
    });
    const rawByCategory = await kakaoSearch(categoryUrl);
    candidates = normalizeKakaoResults(rawByCategory);
    console.log(`[search] 키워드 0건 -> 카테고리(${intent.categoryGroupCode}) 검색 폴백 -> ${candidates.length}건`);
  }

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
