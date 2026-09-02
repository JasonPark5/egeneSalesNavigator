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
          "locationHint에 넣은 지역/랜드마크명(예: '미사역', '홍대')도 query에서 반드시 빼세요 — " +
          "'미사역 주변 맛집'이면 query='맛집'(또는 구체 상호가 없으면 비워두고 categoryGroupCode만), locationHint='미사역'로 나눠 담으세요. " +
          "구체적인 상호/메뉴가 없으면 categoryGroupCode만으로 찾도록 query는 해당 업종의 일반명사(예: '음식점', '카페')로 짧게 두세요.",
      },
      categoryGroupCode: {
        type: 'string',
        enum: ['', 'FD6', 'CE7', 'CS2', 'PM9', 'SW8', 'PK6', 'BK9', 'OL7', 'HP8', 'MT1', 'AD5', 'AT4', 'CT1', 'PO3', 'AC5', 'SC4', 'PS3', 'AG2'],
        description:
          '요청이 아래 업종 중 하나에 해당하면 query에 구체적인 상호/메뉴가 있어도 항상 같이 채우세요 ' +
          '(카카오 키워드 검색이 0건일 때 이 값으로 업종 기준 재검색하는 안전망으로도 쓰입니다): ' +
          "FD6=음식점/맛집/밥집/식당, CE7=카페, CS2=편의점, PM9=약국, SW8=지하철역, PK6=주차장, " +
          'BK9=은행, OL7=주유소/충전소, HP8=병원, MT1=대형마트, AD5=숙박(호텔/모텔/펜션/게스트하우스), ' +
          'AT4=관광명소, CT1=문화시설(영화관/미술관/박물관/공연장), PO3=공공기관(주민센터/구청/우체국/경찰서), ' +
          'AC5=학원, SC4=학교, PS3=어린이집/유치원, AG2=부동산/중개업소. 해당 없으면 빈 문자열.',
      },
      transportMode: {
        type: 'string',
        enum: ['transit', 'car'],
        description:
          "발화에 이동수단이 명시되면(예: '대중교통으로', '차 타고', '걸어서') 그 값을 반영. " +
          "명시되지 않았으면 컨텍스트의 '이동수단 기본' 값을 그대로 사용 (임의로 바꾸지 말 것).",
      },
      originHint: { type: 'string', description: "'현재위치' 또는 즐겨찾기 별칭 (locationHint와 동시에 채우지 말 것)" },
      locationHint: {
        type: 'string',
        description:
          "발화에 특정 지역/역/동네/랜드마크명이 검색 기준 위치로 언급되면(예: '미사역', '홍대', '강남역', '판교') 그 이름만 넣으세요 — " +
          "'~주변', '~근처', '~에서'처럼 다른 걸 찾기 위한 기준 위치로 쓰인 경우입니다. " +
          "즐겨찾기 별칭(집/회사 등)은 여기 넣지 말고 originHint에 넣으세요 — locationHint는 즐겨찾기에 없는 임의의 지명 전용입니다. " +
          "명시적인 지역 언급이 없으면(예: '카페 찾아줘') 빈 문자열로 두세요.",
      },
      destinationFavoriteName: {
        type: 'string',
        description: 'intent가 navigate_favorite일 때만 채움. search일 때는 항상 빈 문자열.',
      },
      filters: { type: 'array', items: { type: 'string' } },
      spoken: { type: 'string' },
      clarification: { type: 'string' },
    },
    required: ['intent', 'query', 'transportMode', 'originHint', 'locationHint', 'filters', 'spoken', 'clarification'],
  },
};

function defaultIntent(ctx) {
  return {
    intent: 'search',
    query: ctx.text,
    categoryGroupCode: ctx.categoryGroupCode || '',
    transportMode: ctx.userTransportMode,
    originHint: '현재위치',
    locationHint: '',
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
    "즐겨찾기가 아닌 임의의 지역/역/동네/랜드마크명이 검색 기준 위치로 쓰이면(예: '미사역 주변 맛집', '홍대에서 혼술', '판교역 근처 카페') " +
    "locationHint에 그 지명만 넣으세요(originHint는 '현재위치'로 둠). 이때 query에는 그 지명을 절대 포함하지 마세요 — " +
    "예: '미사역 주변 맛집'은 locationHint='미사역', query='맛집'(또는 categoryGroupCode=FD6만 채우고 query는 비움)으로 분리하세요. " +
    "지명 없이 그냥 '카페 찾아줘'처럼 현재 위치 기준이면 locationHint는 비워두세요. " +
    "발화가 지역/역/동네/랜드마크명 단독으로만 이루어져 있으면(예: '미사역', '강남역', '홍대') 그 이름 자체가 검색 대상입니다 — " +
    "query에 그 이름을 그대로 넣고 categoryGroupCode와 locationHint는 반드시 빈 문자열로 두세요(다른 걸 찾는 기준 위치가 아니라 그 자체가 목적지이므로). " +
    "'# 최근 검색'은 '거기', '그 근처', '아까 거기서' 처럼 지금 발화만으로는 뜻이 불완전할 때만 참고하고, " +
    "지금 발화가 그 자체로 완결된 지명/요청이면 최근 검색이 다른 업종이었더라도 그 이력으로 categoryGroupCode를 끌어오지 마세요. " +
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

// 키워드검색(상호명 검색에 최적화)은 "OO로60길 17 6층" 같은 도로명주소를 잘 못 찾는다 —
// 이럴 때를 위한 카카오 주소검색 API. 위치 확인(inputType==='locate')에서 키워드검색이
// 0건일 때만 폴백으로 쓴다.
function buildKakaoAddressUrl(params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://dapi.kakao.com/v2/local/search/address.json?${qs}`;
}

function normalizeKakaoAddressResults(data) {
  const docs = data?.documents || [];
  return docs.map((d, i) => {
    const road = d.road_address;
    const addressName = (road && road.address_name) || d.address_name || '';
    return {
      index: i + 1,
      name: (road && road.building_name) || addressName,
      address: addressName,
      category: '',
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      distanceM: 0,
      distanceLabel: '',
      phone: '',
      placeUrl: '',
    };
  });
}

// 도로명주소 뒤에 붙는 "6층", "502호", "B1", "101동" 같은 건물 내부 상세정보는
// 주소검색 API와 잘 안 맞아서(주소 자체가 아니므로) 떼어내고 도로명+번지까지만 남긴다.
function stripBuildingDetail(address) {
  let s = String(address || '').trim();
  const suffixPatterns = [
    /\s*(지하)?\d+\s*층$/,
    /\s*\d+\s*호$/,
    /\s*B\d+$/i,
    /\s*\d+\s*동$/,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of suffixPatterns) {
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return s;
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
      topPickReason: {
        type: 'string',
        description:
          '반드시 후보 데이터에 실제로 있는 정보(이름, 카테고리, 주소, 거리)와 사용자 발화/필터만 근거로 삼으세요. ' +
          "카카오 장소 데이터에는 평점·가격대·시설·서비스 품질 정보가 전혀 없습니다. " +
          "'고급스러운 시설', '평점이 높은', '가성비 좋은', '분위기 좋은' 처럼 확인할 수 없는 사실을 지어내지 마세요 — " +
          "실제로는 이름만 보고 추측한 걸 단정적으로 말하는 것이라 사용자를 오도합니다. " +
          "대신 카테고리/거리/이름이 발화·필터와 얼마나 맞는지에 근거해 말하세요 (예: '요청하신 카페 카테고리와 가장 가까운 곳입니다').",
      },
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
    '후보 데이터에는 이름/카테고리/주소/거리만 있고 평점·가격대·시설·서비스 품질 정보는 없습니다. ' +
    "topPickReason/spoken에서 '고급스러운', '평점 높은', '분위기 좋은'처럼 확인 불가능한 사실을 지어내지 말고, " +
    '실제로 아는 정보(카테고리 일치, 거리, 이름)에만 근거해 이유를 말하세요. ' +
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
  ['AD5', ['호텔', '모텔', '펜션', '게스트하우스', '리조트', '숙소']],
  ['AT4', ['관광지', '관광명소', '전망대', '유적지']],
  ['CT1', ['영화관', '극장', '미술관', '박물관', '공연장', '전시관']],
  ['PO3', ['주민센터', '구청', '시청', '동사무소', '우체국', '경찰서', '소방서']],
  ['AC5', ['학원']],
  ['SC4', ['학교', '초등학교', '중학교', '고등학교', '대학교']],
  ['PS3', ['어린이집', '유치원']],
  ['AG2', ['부동산', '공인중개사']],
];

// 발화에 나온 지역/역/동네/랜드마크명(예: '미사역', '홍대')을 좌표로 변환한다. 캘린더 일정
// 위치 확인(inputType==='locate')과 똑같은 방식 — 반경 제한 없이 정확도순 — 인데, 그 흐름을
// 재사용하지 않고 별도 함수로 둔 건 여기는 항상 카카오 REST만 쓰고(로컬 검색 결과일 필요
// 없음) 실패해도 조용히 null을 반환해 현재 GPS로 자연스럽게 폴백해야 하기 때문.
// TODO(2단계): 후보가 여러 곳으로 갈릴 만큼 모호하면(같은 이름의 다른 지역 등) 1순위를
// 바로 쓰지 말고 clarification으로 사용자에게 후보를 되물어야 하는데, 지금은 카카오
// 정확도순 1위를 그대로 신뢰하는 단순한 버전이다.
async function resolveNamedLocation(hint) {
  const clean = String(hint || '').trim();
  if (!clean) return null;
  try {
    const kakaoUrl = buildKakaoUrl({ query: clean, size: '5', sort: 'accuracy' });
    const raw = await kakaoSearch(kakaoUrl);
    const candidates = normalizeKakaoResults(raw);
    if (!candidates.length) return null;
    return { lat: candidates[0].lat, lng: candidates[0].lng, name: candidates[0].name };
  } catch (err) {
    console.error(`[search] locationHint "${clean}" 확인 실패:`, err);
    return null;
  }
}
function inferCategoryFromText(text) {
  const found = CATEGORY_KEYWORDS.find(([, keywords]) => keywords.some((kw) => text.includes(kw)));
  return found ? found[0] : '';
}

// ─── 오늘의 브리핑 (캘린더 연동 + LLM) ───────────────────────────────
// 시간 계산(이동시간/출발 권장 시각/빠듯한 구간 경고)은 프론트엔드(index.html의
// computeScheduleFacts)가 이미 다 끝내서 scheduleFacts로 넘겨준다. LLM은 그 사실을
// 자연스러운 1~2문장 음성 브리핑으로 "표현"만 하고, 새로운 사실을 계산하거나
// 지어내지 않는다 (curateResults의 근거 제한과 같은 원칙).
const BRIEFING_TOOL_SCHEMA = {
  name: 'generate_briefing',
  description: '오늘 일정 사실을 바탕으로 자연스러운 음성 브리핑 문장을 만듭니다.',
  parameters: {
    type: 'object',
    properties: {
      briefingText: {
        type: 'string',
        description:
          '짧은 인사로 시작하는 간결한 음성 브리핑. scheduleFacts.events의 각 항목은 title/time/location은 ' +
          '항상 있고, travelMinutes/transportMode/departBy는 이동시간이 실제로 계산된 경우에만 있습니다 ' +
          '(없으면 travelTimeKnown:false — 아직 위치를 확인 전인 캘린더 일정). events에 있는 일정은 하나도 ' +
          '빠짐없이 전부 언급하되, **각 일정은 딱 한 문장으로만** 다루세요 — 제목·시각·이동시간(몇 분 ' +
          "걸리는지)·출발 권장 시각을 자연스러운 한 문장에 녹여서 말하세요(예: '여의도 미팅은 11시, 약 " +
          "38분 걸려서 10시 8분쯤 출발하시면 돼요'). 같은 시각/숫자를 다시 반복하지 마세요. location은 " +
          '전체 도로명주소를 그대로 읽지 말고, 그 안에서 상호명·건물명 같은 짧은 핵심 지명만 골라 ' +
          "언급하세요(예: '대한민국 서울특별시 영등포구 여의대로 108 파크원타워 2 43층' → '여의도 " +
          "파크원타워'). 매 일정마다 똑같은 문장 틀을 기계적으로 반복하지 말고 자연스럽게 어조를 " +
          '바꿔가며 쓰세요. travelTimeKnown:false인 일정은 제목·시각만 언급하고 이동시간·출발 권장 시각을 ' +
          "지어내지 마세요. estimated:true인 일정은 '정확히 X분'처럼 단정하지 말고 '약 X분 정도'처럼 " +
          '부드럽게 표현하세요. tightGapWarnings가 있으면 한 문장으로만 짧게 언급하되(필드 이름 그대로 ' +
          "말하지 말고 자연스러운 한국어로, 예: 'OO과 OO 사이는 이동 여유가 부족해요'), 앞에서 이미 말한 " +
          '이동시간 숫자를 또 반복하지 마세요. 일정 사이는 "그다음" 정도의 짧은 연결어만 쓰세요. 날씨/ ' +
          '교통상황/시설 등 제공되지 않은 정보는 절대 지어내지 말고, 체크리스트 제안 같은 부가 멘트도 ' +
          '덧붙이지 마세요. 전체 분량은 인사 한 문장 + 일정당 한 문장 정도로 짧게 유지하세요.',
      },
    },
    required: ['briefingText'],
  },
};

async function generateBriefing(body) {
  const lang = (body.lang || 'ko').trim();
  const scheduleFacts = body.scheduleFacts || { events: [], tightGapWarnings: [] };
  const llmOverride = body.llmProvider ? { provider: body.llmProvider, apiKey: body.llmApiKey } : null;

  if (!scheduleFacts.events || !scheduleFacts.events.length) return { briefingText: '' };

  const langDirective =
    lang === 'en'
      ? "IMPORTANT: The user's UI language is English. Write briefingText in English only. "
      : '중요: 사용자 UI 언어는 한국어입니다. briefingText를 한국어로 작성하세요. ';
  const systemPrompt =
    langDirective +
    '당신은 외근이 많은 영업직 사용자를 위한 아침 일정 브리핑 어시스턴트입니다. ' +
    '제공된 오늘 일정 사실(scheduleFacts)만 바탕으로, 소리 내어 듣기 좋은 **간결한** 브리핑을 작성하세요. ' +
    '짧은 인사로 시작하고(예: "좋은 아침이에요, 오늘 일정 안내해 드릴게요"), scheduleFacts.events에 있는 ' +
    '일정은 하나도 빠짐없이 전부 언급하되 **각 일정은 딱 한 문장으로만** 다루세요 — 제목·시각·이동시간(몇 ' +
    '분 걸리는지)·출발 권장 시각을 자연스러운 한 문장에 녹여서 말하고(예: "여의도 미팅은 11시, 약 38분 ' +
    '걸려서 10시 8분쯤 출발하시면 돼요"), 같은 시각/숫자를 다시 반복하지 마세요. location은 전체 ' +
    '도로명주소를 그대로 읽지 말고 상호명·건물명 같은 짧은 핵심 지명만 골라 언급하세요. 매 일정마다 똑같은 ' +
    '문장 틀을 기계적으로 반복하지 말고 자연스럽게 어조를 바꿔가며 쓰세요. travelMinutes가 없는 ' +
    '(travelTimeKnown:false) 일정도 제목·시각만은 반드시 포함하되 이동시간/출발 시각은 지어내지 마세요. ' +
    'tightGapWarnings가 있으면 한 문장으로만 짧게 언급하되, 필드 이름을 그대로 말하지 말고 자연스러운 ' +
    '문장으로 풀어 쓰고, 앞에서 이미 말한 이동시간 숫자를 또 반복하지 마세요. 일정 사이는 "그다음" 정도의 ' +
    '짧은 연결어만 쓰세요. 사실에 없는 내용(날씨, 실시간 교통상황, 장소 시설 정보 등)은 절대 지어내지 말고, ' +
    '체크리스트 제안 같은 부가 멘트도 덧붙이지 마세요. 전체 분량은 인사 한 문장 + 일정당 한 문장 정도로 ' +
    '짧게 유지하세요. ' +
    langDirective;
  const userMessage = `# 오늘 일정 사실\n${JSON.stringify(scheduleFacts)}`;

  try {
    const args = await callLLMTool({
      systemPrompt,
      userMessage,
      toolSchema: BRIEFING_TOOL_SCHEMA,
      toolChoiceName: 'generate_briefing',
      override: llmOverride,
    });
    return { briefingText: (args && args.briefingText) || '' };
  } catch (err) {
    return { briefingText: '', _llmError: String(err.message || err) };
  }
}

// ─── 음성으로 일정 추가 (자연어 → Google Calendar 일정 필드) ──────────────
// 실제 Google Calendar 생성 API 호출은 여기서 안 한다 — 이미 브라우저가 갖고 있는
// 액세스 토큰으로 프론트가 직접 호출한다(오늘 일정 조회와 동일한 방식, CORS 문제 없음).
// 여기는 발화를 제목/날짜/시간으로 "해석"만 한다. 상대 날짜("내일", "다음주 화요일")를
// 서버가 잘못된 타임존으로 계산하는 걸 막기 위해, 오늘 날짜/요일/현재시각은 서버 시계가
// 아니라 프론트(사용자의 실제 로컬 시간)가 계산해서 todayDate/todayWeekday/nowTime으로
// 넘겨준 값을 기준점으로 쓴다.
const CREATE_EVENT_TOOL_SCHEMA = {
  name: 'create_event',
  description: '사용자 발화에서 캘린더 일정 생성에 필요한 정보(제목/날짜/시간/장소)를 추출합니다.',
  parameters: {
    type: 'object',
    properties: {
      understood: {
        type: 'boolean',
        description:
          '제목과 날짜, 시작 시각을 발화에서 확신 있게 알아냈으면 true. ' +
          '날짜나 시간이 아예 없거나("일정 잡아줘"처럼) 너무 모호하면 false — ' +
          '이 경우 사실이 아닌 값을 지어내서 채우지 말고 false로 두세요.',
      },
      title: {
        type: 'string',
        description: '일정 제목(예: "김이사님 미팅", "OO팀 회식"). 명시적인 제목이 없으면 "일정".',
      },
      date: {
        type: 'string',
        description:
          'YYYY-MM-DD. 상대 날짜 표현("내일", "모레", "다음주 화요일", "이번주 금요일")은 ' +
          '컨텍스트의 오늘 날짜/요일을 기준으로 계산하세요. 날짜 언급이 전혀 없으면 오늘 날짜를 쓰세요.',
      },
      startTime: {
        type: 'string',
        description:
          'HH:MM 24시간제. "오후 3시"→15:00, "3시 반"→15:30, "아침 9시"→09:00. ' +
          '오전/오후 명시가 없는 애매한 시각(예: 그냥 "7시")은 업무 맥락상 자연스러운 쪽으로 판단하되, ' +
          '너무 불확실하면 understood=false로 두세요.',
      },
      durationMinutes: {
        type: 'integer',
        description: '일정 길이(분). "1시간", "30분" 등 언급되면 반영, 없으면 60.',
      },
      location: { type: 'string', description: '장소 언급이 있으면 그대로, 없으면 빈 문자열.' },
      clarification: {
        type: 'string',
        description: 'understood가 false일 때, 무엇이 불명확한지 짧게 되물을 질문 (예: "언제로 잡아드릴까요?").',
      },
    },
    required: ['understood', 'title', 'date', 'startTime', 'durationMinutes', 'location', 'clarification'],
  },
};

async function parseEventFromText(body) {
  const text = (body.text || '').trim();
  const lang = (body.lang || 'ko').trim();
  const llmOverride = body.llmProvider ? { provider: body.llmProvider, apiKey: body.llmApiKey } : null;
  const fallback = { understood: false, clarification: lang === 'en' ? 'Sorry, I could not understand that.' : '무슨 일정인지 잘 못 알아들었어요.' };

  if (!text) return fallback;

  const langDirective =
    lang === 'en'
      ? "IMPORTANT: The user's UI language is English. Write title/clarification in English only, even though instructions below are in Korean. "
      : '중요: 사용자 UI 언어는 한국어입니다. title, clarification을 한국어로 작성하세요. ';
  const systemPrompt =
    langDirective +
    '당신은 음성으로 캘린더 일정을 추가하는 어시스턴트입니다. 발화에서 일정 제목/날짜/시작시각/길이/장소를 추출하세요. ' +
    '날짜·시간 계산의 기준점은 아래 "# 현재 시각" 컨텍스트입니다(서버 시각이 아니라 사용자의 실제 로컬 시각). ' +
    '확실하지 않은 값을 지어내지 말고, 제목/날짜/시각 중 하나라도 불확실하면 understood=false로 정직하게 표시하세요. ' +
    langDirective;
  const userMessage = [
    `# 사용자 발화\n"${text}"`,
    `# 현재 시각\n- 오늘 날짜: ${body.todayDate || ''}\n- 오늘 요일: ${body.todayWeekday || ''}\n- 지금 시각: ${body.nowTime || ''}`,
  ].join('\n\n');

  try {
    const args = await callLLMTool({
      systemPrompt,
      userMessage,
      toolSchema: CREATE_EVENT_TOOL_SCHEMA,
      toolChoiceName: 'create_event',
      override: llmOverride,
    });
    if (!args) return fallback;
    return {
      understood: !!args.understood,
      title: args.title || '일정',
      date: args.date || body.todayDate || '',
      startTime: args.startTime || '',
      durationMinutes: parseInt(args.durationMinutes, 10) || 60,
      location: args.location || '',
      clarification: args.clarification || '',
    };
  } catch (err) {
    return { understood: false, clarification: String(err.message || err), _llmError: String(err.message || err) };
  }
}

// ─── 자동차 이동시간 (NAVER Directions 5) ────────────────────────────
// 이 API는 브라우저에서 직접 fetch/XHR로 호출하면 CORS로 막힌다 — NCP 포럼에도
// 동일 증상 리포트가 있고, 실제로 확인함(TypeError: Failed to fetch). 그래서
// 서버-서버 호출로만 씀(서버는 CORS 제약이 없음). GitHub Pages처럼 server/ 없이
// 브라우저에서만 도는 배포에서는 이 API를 쓸 방법이 없어서, 그쪽은 처음부터
// 직선거리 기반 추정치로 감(web/index.html의 resolveCarTravelMinutes 참고).
// NCP 문서/포럼에 도메인이 naveropenapi.apigw.ntruss.com(예전 "AI NAVER API")과
// maps.apigw.ntruss.com(현재 "Maps" 상품) 둘 다로 나와서 어느 쪽이 실제 발급받은
// 자격증명과 맞는지 확신이 안 서, 401(인증 실패)이면 다른 도메인으로 한 번 더
// 시도한다 — 매번 두 번 부르는 게 아니라 실패했을 때만.
const NAVER_DIRECTIONS_DOMAINS = ['maps.apigw.ntruss.com', 'naveropenapi.apigw.ntruss.com'];

async function fetchNaverDrivingMinutes({ originLat, originLng, destLat, destLng }) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('NAVER_CLIENT_ID/NAVER_CLIENT_SECRET이 설정되지 않았습니다.');

  const start = encodeURIComponent(`${originLng},${originLat}`);
  const goal = encodeURIComponent(`${destLng},${destLat}`);
  let lastErr;
  for (const domain of NAVER_DIRECTIONS_DOMAINS) {
    // trafast(실시간 빠른길)는 이론상 최단시간 경로라 실제 네이버지도 앱이 기본으로
    // 추천하는 경로(실시간 최적, traoptimal)보다 낙관적으로 나올 수 있음 — 실측 대비
    // 약 10분 짧게 나온 것도 이 옵션 차이 때문으로 확인되어 traoptimal로 변경.
    const url = `https://${domain}/map-direction/v1/driving?start=${start}&goal=${goal}&option=traoptimal`;
    const res = await fetch(url, {
      headers: {
        'x-ncp-apigw-api-key-id': clientId,
        'x-ncp-apigw-api-key': clientSecret,
      },
    });
    if (!res.ok) {
      lastErr = new Error(`Naver Directions API 오류(${domain}): HTTP ${res.status}`);
      if (res.status === 401) continue; // 인증 실패 -> 다른 도메인으로 재시도
      throw lastErr; // 401 이외의 오류는 도메인 문제가 아니므로 바로 중단
    }
    const data = await res.json();
    const route = data.route && data.route.traoptimal && data.route.traoptimal[0];
    if (!route || !route.summary) throw new Error(`Naver Directions 응답에 경로 정보가 없습니다(${domain}).`);
    console.log(`[travel-time] Naver Directions 성공 (도메인: ${domain})`);
    return {
      minutes: Math.max(Math.round(route.summary.duration / 60000), 1),
      distanceM: Math.round(route.summary.distance),
    };
  }
  throw lastErr;
}

async function runMockPipeline(body) {
  if ((body.inputType || '') === 'briefing') {
    return generateBriefing(body);
  }
  if ((body.inputType || '') === 'create-event') {
    return parseEventFromText(body);
  }
  if ((body.inputType || '') === 'travel-time') {
    try {
      const { minutes, distanceM } = await fetchNaverDrivingMinutes(body);
      return { travelMinutes: minutes, distanceM, real: true };
    } catch (err) {
      return { travelMinutes: null, distanceM: null, real: false, error: String(err.message || err) };
    }
  }
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
    let candidates = normalizeKakaoResults(raw);

    // 캘린더 일정 위치 확인은 "OO로60길 17 6층" 같은 도로명주소로 들어올 때가 많은데,
    // 키워드검색(상호명 검색에 최적화)은 이런 형태를 잘 못 찾는다. 0건이면 주소검색으로
    // 한 번 더 시도한다(건물 내부 상세정보는 떼어내고).
    if (isLocate && candidates.length === 0) {
      const stripped = stripBuildingDetail(q);
      const addrUrl = buildKakaoAddressUrl({ query: stripped, size: '5' });
      const rawAddr = await kakaoSearch(addrUrl);
      candidates = normalizeKakaoAddressResults(rawAddr);
      console.log(`[locate] 키워드검색 0건 -> 주소검색 "${stripped}" -> ${candidates.length}건`);
    }

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
      `transportMode=${intent.transportMode} originHint=${intent.originHint} locationHint=${intent.locationHint || '(none)'} ` +
      `dest=${intent.destinationFavoriteName || '(none)'}` +
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
  // 검색 기준점이 현재 GPS가 아닌 다른 곳(즐겨찾기/지명)으로 바뀌면, 카카오가 돌려주는
  // distanceLabel도 그 기준점부터의 거리로 바뀐다 — "1.4km"만 보면 내 위치 기준처럼
  // 보이기 쉬워서, 그 기준점 이름을 anchorLabel로 같이 넘겨 프론트에서 "OO 기준"으로
  // 표시하게 한다(카드 문구 자체를 현재위치 기준으로 바꾸는 대신, 기준점을 명시하는 방식 — 그래야
  // "여의도 안에서 어디가 더 중심인지" 비교하는 용도도 그대로 유지됨).
  let anchorLabel = '';
  let originResolved = false;
  if (intent.originHint && intent.originHint !== '현재위치') {
    const origin = findFavorite(ctx.favorites, intent.originHint);
    if (origin) {
      searchLat = origin.lat;
      searchLng = origin.lng;
      anchorLabel = origin.alias || origin.name;
      originResolved = true;
      console.log(`[search] 기준 위치 = 즐겨찾기 "${intent.originHint}" -> (${origin.lat}, ${origin.lng})`);
    } else {
      console.log(
        `[search] 기준 위치 = 즐겨찾기 "${intent.originHint}" (매칭 실패, 현재 GPS로 대체) ` +
          `보유 즐겨찾기: ${JSON.stringify((ctx.favorites || []).map((f) => f.alias || f.name))}`
      );
    }
  }

  // 즐겨찾기가 아닌 임의 지역/랜드마크명("미사역 주변 맛집"의 "미사역")이 검색 기준 위치로
  // 쓰인 경우 — 예전엔 이런 지명이 검색 기준으로 반영될 방법이 없어서 항상 현재 GPS
  // 근처만 뒤졌다(예: "미사역 주변 맛집"이 현재 위치 근처 맛집 검색이 되어버림).
  // originHint가 이미 즐겨찾기로 정확히 해석됐으면 이 단계는 건너뛴다 — LLM이 "회사근처 카페"
  // 같은 발화에서 "회사"를 originHint와 locationHint 양쪽에 다 채우는 경우가 있는데, 그러면
  // 방금 정확히 찾은 즐겨찾기 좌표가 무관한 동명 장소(카카오 전국 검색 1위)로 덮어써지는
  // 버그가 있었다("회사" 검색 시 제주도의 상호명에 "회사"가 들어간 업체로 잘못 이동한 사례).
  if (!originResolved && intent.locationHint) {
    // LLM이 "집"/"회사"처럼 즐겨찾기 별칭에 해당하는 단어를 originHint가 아니라 locationHint로
    // 잘못 분류하는 경우가 실제로 있다("집 근처 편의점" -> originHint는 비고 locationHint="집").
    // 이 경우 위 originHint 분기 자체가 안 돌기 때문에 그 방어코드로도 못 잡는다 — 그래서
    // 카카오 전국검색으로 넘기기 전에 즐겨찾기와 먼저 매칭해본다(엉뚱한 동명 장소로 새는
    // 것을 막는 마지막 안전망).
    const favMatch = findFavorite(ctx.favorites, intent.locationHint);
    if (favMatch) {
      searchLat = favMatch.lat;
      searchLng = favMatch.lng;
      anchorLabel = favMatch.alias || favMatch.name;
      console.log(`[search] 기준 위치 = locationHint "${intent.locationHint}"가 즐겨찾기와 일치 -> (${favMatch.lat}, ${favMatch.lng})`);
    } else {
      const resolved = await resolveNamedLocation(intent.locationHint);
      if (resolved) {
        searchLat = resolved.lat;
        searchLng = resolved.lng;
        anchorLabel = resolved.name;
        console.log(`[search] 기준 위치 = "${intent.locationHint}" -> (${resolved.lat}, ${resolved.lng}) [${resolved.name}]`);
      } else {
        console.log(`[search] 기준 위치 "${intent.locationHint}" 확인 실패 -> 현재 GPS로 대체`);
      }
    }
  }

  // query가 비어서 ctx.text(원문 발화 전체)로 대체될 때, locationHint가 있으면 그 지명이
  // 다시 검색어에 섞여 들어간다(애초에 이 문제를 풀려고 만든 기능인데 폴백에서 되풀이됨).
  // 그래서 locationHint가 있을 땐 원문 대신 빈 문자열로 둬서 categoryGroupCode 기반
  // 카테고리 검색 폴백(아래)에 맡긴다.
  const query = intent.query || (intent.locationHint ? '' : ctx.text);
  // 정확도순 검색이라도 반경은 걸어둠 — 안 그러면 이름만 비슷한 수백km 밖 결과가 섞여 들어옴.
  // 자동차는 카카오 로컬 API의 radius 파라미터 최대값(20km)까지 허용, 그 외(대중교통/도보)는
  // 사용자가 설정한 칩 검색 반경을 그대로 씀.
  const CAR_SEARCH_RADIUS_M = 20000;
  const searchRadius = intent.transportMode === 'car' ? CAR_SEARCH_RADIUS_M : ctx.userChipRadius;

  // 카카오 키워드검색(keyword.json)은 query가 필수 파라미터라 빈 문자열로는 호출 못 함
  // (locationHint만 있고 구체적인 검색어가 없는 경우 — 예: "미사역 주변 맛집"에서 categoryGroupCode
  // =FD6만으로 충분한 케이스). 그럴 땐 키워드 검색을 건너뛰고 바로 카테고리 검색으로 간다.
  let candidates = [];
  if (query) {
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
    candidates = normalizeKakaoResults(raw);
    console.log(`[search] 카카오 검색 "${query}" (반경 ${searchRadius}m) -> ${candidates.length}건`);
  }

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
    console.log(
      `[search] ${query ? '키워드 0건 -> ' : '검색어 없음 -> '}카테고리(${intent.categoryGroupCode}) 검색 -> ${candidates.length}건`
    );
  }

  // 반경 검색(+카테고리 폴백)까지 다 0건이면, 발화 자체가 "미사역"처럼 지역/역/랜드마크명
  // 그 자체(business 이름이 아니라)일 가능성이 있다 — 그런 경우 반경 제한이 오히려 방해가
  // 된다(현재 위치에서 멀리 떨어진 곳을 찾는 거니까). 마지막 안전망으로 반경 없이
  // 전국 정확도순으로 한 번 더 시도한다.
  if (candidates.length === 0 && query) {
    const nationalUrl = buildKakaoUrl({ query, size: '10', sort: 'accuracy' });
    const rawNational = await kakaoSearch(nationalUrl);
    candidates = normalizeKakaoResults(rawNational);
    console.log(`[search] 반경 검색 0건 -> 전국 무제한 검색 "${query}" -> ${candidates.length}건`);
  }

  // 여기까지 다 0건이면, 발화가 "월드컵북로60길 17 6층"처럼 상호명이 아니라 도로명주소
  // 그 자체일 가능성이 있다 — 키워드검색(상호명 검색에 최적화)은 이런 형태를 잘 못
  // 찾는다. 마지막 안전망으로 카카오 주소검색 API를 한 번 더 시도한다(위치 확인
  // (inputType==='locate')에서 쓰는 것과 동일한 폴백).
  if (candidates.length === 0) {
    const strippedAddr = stripBuildingDetail(ctx.text);
    if (strippedAddr) {
      const addrUrl = buildKakaoAddressUrl({ query: strippedAddr, size: '5' });
      const rawAddr = await kakaoSearch(addrUrl);
      candidates = normalizeKakaoAddressResults(rawAddr);
      console.log(`[search] 전국 검색도 0건 -> 주소검색 "${strippedAddr}" -> ${candidates.length}건`);
    }
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
    // "OO 검색 결과예요" 메시지에 쓰이는 값이라, LLM이 정제한 query(예: "양꼬치")가 아니라
    // 사용자가 실제로 말한 문장(예: "가디역 양꼬치") 그대로 보여준다 — locationHint로
    // 지명이 query에서 빠진 경우에도 자기가 뭘 물어봤는지 그대로 보이는 게 자연스럽다.
    destination: ctx.text || query || intent.locationHint,
    // 검색 기준점이 현재 GPS가 아니면(즐겨찾기/지명) 그 이름 — 카드의 거리(distanceLabel)가
    // 이 기준점부터의 거리라는 걸 프론트에서 "OO 기준"으로 표시하는 데 씀.
    locationLabel: anchorLabel,
    transportMode: intent.transportMode,
    spoken: curated.spoken,
    topPick: curated.topPick,
    clarification: '',
  };
}

module.exports = { runMockPipeline };
