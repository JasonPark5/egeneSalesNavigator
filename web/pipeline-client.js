'use strict';

// GitHub Pages 같은 순수 정적 호스팅용 클라이언트 사이드 파이프라인.
// server/src/pipeline.js(mock 모드)와 동일한 로직을 브라우저에서 직접 수행한다 —
// server/가 없는 환경(백엔드 없이 정적 파일만 배포)에서 index.html이 대신 이 파일을 씀.
// (index.html의 shouldUseClientPipeline() 참고: localhost 개발 환경에서는 지금처럼
// server/의 Node 브릿지를 그대로 쓰고, 그 외 호스트에서만 이 파일이 활성화됨)
//
// 주의: 이 파일에서 쓰는 LLM 키(OpenAI 등)는 브라우저에 그대로 노출된다(페이지 소스에서
// 조회 가능). 사내 해커톤 검증용 임시 배포 목적으로만 쓰고, 실서비스에는 server/ +
// ActionFlow 연동(BACKEND_MODE=actionflow) 방식을 쓸 것.

(function () {
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
      skipLLM: body.inputType === 'chip' || body.inputType === 'locate',
      llmOverride: body.llmProvider ? { provider: body.llmProvider, apiKey: body.llmApiKey } : null,
    };
  }

  var INTENT_TOOL_SCHEMA = {
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

  // 빌드(배포) 시 GitHub Actions가 repo secret에서 주입하는 기본값. Actions를 거치지 않고
  // (로컬에서 그대로 열거나 server/로 개발 중) 로드된 경우 플레이스홀더 문자열 그대로이므로
  // 빈 값 취급 — 그러면 사용자가 설정 화면에서 자기 키를 입력해야 동작한다.
  function buildDefault(name) {
    var v = (typeof window !== 'undefined' && window[name]) || '';
    if (/^__BUILD_[A-Z_]+__$/.test(v)) return '';
    return v;
  }

  function resolveLlmConfig(override) {
    var provider = (override && override.provider) || buildDefault('__DEFAULT_LLM_PROVIDER__') || 'openai';
    var overrideKey = override && override.provider === provider ? override.apiKey : null;
    var apiKey = overrideKey || buildDefault('__DEFAULT_LLM_API_KEY__');
    return { provider: provider, apiKey: apiKey };
  }

  async function callLLMTool(opts) {
    var systemPrompt = opts.systemPrompt;
    var userMessage = opts.userMessage;
    var toolSchema = opts.toolSchema;
    var toolChoiceName = opts.toolChoiceName;
    var cfg = resolveLlmConfig(opts.override);
    var provider = cfg.provider;
    var apiKey = cfg.apiKey;
    if (!apiKey) throw new Error(provider + ' API 키가 설정되지 않았습니다. 설정 > 내 연동 설정에서 입력해주세요.');

    if (provider === 'gemini') {
      var model = 'gemini-2.5-flash';
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;
      var res = await fetch(url, {
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
      if (!res.ok) throw new Error('Gemini API 오류: HTTP ' + res.status);
      var data = await res.json();
      var parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      var part = parts.find(function (p) { return p.functionCall; });
      return (part && part.functionCall && part.functionCall.args) || null;
    }

    if (provider === 'claude') {
      var claudeModel = 'claude-haiku-4-5-20251001';
      var res2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 800,
          system: systemPrompt,
          tools: [{ name: toolSchema.name, description: toolSchema.description, input_schema: toolSchema.parameters }],
          tool_choice: { type: 'tool', name: toolChoiceName },
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!res2.ok) throw new Error('Claude API 오류: HTTP ' + res2.status);
      var data2 = await res2.json();
      var block = (data2.content || []).find(function (b) { return b.type === 'tool_use'; });
      return (block && block.input) || null;
    }

    if (provider === 'openai') {
      var openaiModel = 'gpt-4o-mini';
      var res3 = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: openaiModel,
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
      if (!res3.ok) throw new Error('OpenAI API 오류: HTTP ' + res3.status);
      var data3 = await res3.json();
      var toolCall = data3.choices && data3.choices[0] && data3.choices[0].message && data3.choices[0].message.tool_calls && data3.choices[0].message.tool_calls[0];
      return toolCall ? JSON.parse(toolCall.function.arguments) : null;
    }

    throw new Error('알 수 없는 LLM provider: ' + provider);
  }

  async function resolveIntent(ctx) {
    var langDirective =
      ctx.lang === 'en'
        ? 'IMPORTANT: The user\'s UI language is English. Write ALL free-text output fields (spoken, clarification) in English only, even though the instructions below are in Korean. '
        : '중요: 사용자 UI 언어는 한국어입니다. spoken, clarification 등 모든 자유 텍스트 출력 필드를 한국어로 작성하세요. ';
    var systemPrompt =
      langDirective +
      '당신은 한국 길찾기 앱의 의도 분석 어시스턴트입니다. 사용자의 자연어 발화에서 카카오 로컬 검색에 쓸 쿼리/카테고리/필터를 추출하세요. ' +
      "즐겨찾기 별칭(집, 회사 등)이 발화에서 목적지 자체로 쓰이면(예: '집으로 가자', '회사 가는 길') intent='navigate_favorite'이고 destinationFavoriteName에 그 별칭을 넣으세요. " +
      "즐겨찾기 별칭이 검색 기준 위치로만 쓰이면(예: '집 근처 편의점', '회사 주변 카페') intent='search'이고 originHint에만 넣으세요 (destinationFavoriteName은 비움). " +
      "originHint/destinationFavoriteName에 즐겨찾기를 넣을 때는 '# 즐겨찾기' 목록에 있는 alias 값을 토씨 하나 안 틀리고 그대로 복사해서 넣으세요 (예: 목록에 alias:'집'이면 '집근처'/'우리집'이 아니라 정확히 '집'만). " +
      "이동수단(transportMode)은 발화에 명시적으로 언급된 경우에만(예: '대중교통으로', '차 타고') 그 값으로 바꾸고, 언급이 없으면 컨텍스트의 '이동수단 기본' 값을 절대 임의로 바꾸지 말고 그대로 유지하세요. " +
      "query는 실제 상호명/업종에 매칭될 짧은 검색어만 넣고, '아이랑 갈만한' 같은 동반자/분위기/목적 수식어는 query에서 빼서 filters에 넣으세요 (query에 그대로 넣으면 검색결과 0건이 됩니다). " +
      "모호하면 clarification에 짧은 질문을 넣고 intent='ambiguous'. " +
      langDirective;
    var userMessage = [
      '# 사용자 발화\n"' + ctx.text + '"',
      '# 컨텍스트\n- 위치: (' + ctx.userLat + ', ' + ctx.userLng + ')' + (ctx.landmark ? ', ' + ctx.landmark + ' 근처' : '') +
        '\n- 이동수단 기본: ' + ctx.userTransportMode + '\n- 입력 방식: ' + ctx.inputType + '\n- 언어: ' + ctx.lang,
      '# 즐겨찾기\n' + JSON.stringify(ctx.favorites),
      '# 최근 검색\n' + JSON.stringify(ctx.recentSearches),
    ].join('\n\n');

    try {
      var args = await callLLMTool({
        systemPrompt: systemPrompt,
        userMessage: userMessage,
        toolSchema: INTENT_TOOL_SCHEMA,
        toolChoiceName: 'resolve_intent',
        override: ctx.llmOverride,
      });
      return args ? Object.assign(defaultIntent(ctx), args) : defaultIntent(ctx);
    } catch (err) {
      var fallback = defaultIntent(ctx);
      fallback._llmError = String((err && err.message) || err);
      return fallback;
    }
  }

  // ========================
  // Kakao Maps JS SDK 기반 로컬 검색
  // (REST API는 브라우저에서 CORS로 막혀 있어, JS SDK의 services.Places를 대신 씀 —
  //  Kakao Developers에서 발급받은 "JavaScript" 키 + 이 사이트 도메인 등록이 필요함)
  // ========================
  var kakaoSdkPromise = null;
  function ensureKakaoSdk() {
    if (kakaoSdkPromise) return kakaoSdkPromise;
    kakaoSdkPromise = new Promise(function (resolve, reject) {
      if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
        resolve();
        return;
      }
      var appKey = buildDefault('__DEFAULT_KAKAO_JS_KEY__');
      if (!appKey) {
        reject(new Error('Kakao JavaScript 키가 설정되지 않았습니다 (KAKAO_JS_KEY).'));
        return;
      }
      var script = document.createElement('script');
      script.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + encodeURIComponent(appKey) + '&libraries=services&autoload=false';
      script.onerror = function () { reject(new Error('Kakao Maps SDK 로드 실패')); };
      script.onload = function () {
        window.kakao.maps.load(function () { resolve(); });
      };
      document.head.appendChild(script);
    });
    return kakaoSdkPromise;
  }

  function normalizeKakaoResults(docs) {
    return (docs || []).map(function (d, i) {
      var dm = parseInt(d.distance, 10) || 0;
      return {
        index: i + 1,
        name: d.place_name,
        address: d.road_address_name || d.address_name || '',
        category: d.category_group_name || (d.category_name || '').split(' > ').pop() || '',
        lat: parseFloat(d.y),
        lng: parseFloat(d.x),
        distanceM: dm,
        distanceLabel: dm < 1000 ? dm + 'm' : (dm / 1000).toFixed(1) + 'km',
        phone: d.phone || '',
        placeUrl: d.place_url || '',
      };
    });
  }

  async function kakaoSearchDocs(query, params) {
    await ensureKakaoSdk();
    return new Promise(function (resolve, reject) {
      var places = new window.kakao.maps.services.Places();
      var options = { size: 10 };
      if (params.x != null && params.y != null) options.location = new window.kakao.maps.LatLng(params.y, params.x);
      if (params.radius) options.radius = params.radius;
      if (params.category_group_code) options.category_group_code = params.category_group_code;
      options.sort = params.sort === 'distance' ? window.kakao.maps.services.SortBy.DISTANCE : window.kakao.maps.services.SortBy.ACCURACY;
      places.keywordSearch(query, function (data, status) {
        if (status === window.kakao.maps.services.Status.OK) resolve(data);
        else if (status === window.kakao.maps.services.Status.ZERO_RESULT) resolve([]);
        else reject(new Error('Kakao 키워드 검색 실패: ' + status));
      }, options);
    });
  }

  async function kakaoCategoryDocs(categoryGroupCode, params) {
    await ensureKakaoSdk();
    return new Promise(function (resolve, reject) {
      var places = new window.kakao.maps.services.Places();
      var options = { size: 10, sort: window.kakao.maps.services.SortBy.DISTANCE };
      if (params.x != null && params.y != null) options.location = new window.kakao.maps.LatLng(params.y, params.x);
      if (params.radius) options.radius = params.radius;
      places.categorySearch(categoryGroupCode, function (data, status) {
        if (status === window.kakao.maps.services.Status.OK) resolve(data);
        else if (status === window.kakao.maps.services.Status.ZERO_RESULT) resolve([]);
        else reject(new Error('Kakao 카테고리 검색 실패: ' + status));
      }, options);
    });
  }

  var CURATE_TOOL_SCHEMA = {
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

  async function curateResults(opts) {
    var candidates = opts.candidates;
    var fallback = {
      candidates: candidates,
      spoken: opts.spokenFallback || '',
      topPick: { index: 0, reason: '' },
    };
    if (candidates.length === 0) return fallback;

    var langDirective =
      opts.lang === 'en'
        ? "IMPORTANT: The user's UI language is English. Write ALL free-text output fields (spoken, topPickReason) in English only. "
        : '중요: 사용자 UI 언어는 한국어입니다. spoken, topPickReason 등 모든 자유 텍스트 출력 필드를 한국어로 작성하세요. ';
    var systemPrompt =
      langDirective +
      '당신은 검색 결과 큐레이터입니다. 사용자의 필터/분위기/의도와 후보들의 카테고리/거리를 종합해 가장 맞는 곳을 추천하세요. ' +
      '후보 데이터에는 이름/카테고리/주소/거리만 있고 평점·가격대·시설·서비스 품질 정보는 없습니다. ' +
      "topPickReason/spoken에서 '고급스러운', '평점 높은', '분위기 좋은'처럼 확인 불가능한 사실을 지어내지 말고, " +
      '실제로 아는 정보(카테고리 일치, 거리, 이름)에만 근거해 이유를 말하세요. ' +
      langDirective;
    var userMessage = [
      '# 원본 발화\n"' + opts.originalText + '"',
      '# 의도 필터\n' + JSON.stringify(opts.filters),
      '# 언어: ' + opts.lang,
      '# 후보 (0-based)\n' + JSON.stringify(candidates.map(function (c, i) {
        return { i: i, name: c.name, category: c.category, address: c.address, distance: c.distanceLabel };
      })),
    ].join('\n\n');

    try {
      var args = await callLLMTool({
        systemPrompt: systemPrompt,
        userMessage: userMessage,
        toolSchema: CURATE_TOOL_SCHEMA,
        toolChoiceName: 'curate_results',
        override: opts.override,
      });
      if (!args) return fallback;
      var ordered = (args.rankedIndices || [])
        .map(function (i) { return candidates[i]; })
        .filter(Boolean)
        .map(function (c, newI) { return Object.assign({}, c, { index: newI + 1 }); });
      var newTopIdx = (args.rankedIndices || []).indexOf(args.topPickIndex);
      return {
        candidates: ordered.length ? ordered : candidates,
        spoken: args.spoken || opts.spokenFallback || '',
        topPick: { index: newTopIdx >= 0 ? newTopIdx : 0, reason: args.topPickReason || '' },
      };
    } catch (e) {
      return fallback;
    }
  }

  function findFavorite(favorites, name) {
    var clean = String(name || '').trim();
    if (!clean) return null;
    return (favorites || []).find(function (f) {
      return (f.alias && (f.alias === clean || clean.indexOf(f.alias) === 0)) ||
        (f.name && (f.name === clean || clean.indexOf(f.name) === 0));
    });
  }

  var CATEGORY_KEYWORDS = [
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
    var found = CATEGORY_KEYWORDS.find(function (entry) {
      return entry[1].some(function (kw) { return text.indexOf(kw) !== -1; });
    });
    return found ? found[0] : '';
  }

  // ─── 오늘의 브리핑 (캘린더 연동 + LLM) ───────────────────────────────
  // 시간 계산은 index.html의 computeScheduleFacts가 이미 끝내서 scheduleFacts로 넘겨준다.
  // LLM은 그 사실을 자연스러운 1~2문장 음성 브리핑으로 "표현"만 함 (curateResults와 같은 근거 제한 원칙).
  var BRIEFING_TOOL_SCHEMA = {
    name: 'generate_briefing',
    description: '오늘 일정 사실을 바탕으로 자연스러운 음성 브리핑 문장을 만듭니다.',
    parameters: {
      type: 'object',
      properties: {
        briefingText: {
          type: 'string',
          description:
            '1~2문장의 자연스러운 음성 브리핑. scheduleFacts에 있는 사실(미팅 수, 이동시간, 출발 권장 시각, ' +
            'tightGapWarnings)만 사용하세요. 날씨/교통상황/시설 등 제공되지 않은 정보는 지어내지 마세요. ' +
            'tightGapWarnings가 있으면 반드시 언급하세요.',
        },
      },
      required: ['briefingText'],
    },
  };

  async function generateBriefing(body) {
    var lang = (body.lang || 'ko').trim();
    var scheduleFacts = body.scheduleFacts || { events: [], tightGapWarnings: [] };
    var llmOverride = body.llmProvider ? { provider: body.llmProvider, apiKey: body.llmApiKey } : null;

    if (!scheduleFacts.events || !scheduleFacts.events.length) return { briefingText: '' };

    var langDirective =
      lang === 'en'
        ? "IMPORTANT: The user's UI language is English. Write briefingText in English only. "
        : '중요: 사용자 UI 언어는 한국어입니다. briefingText를 한국어로 작성하세요. ';
    var systemPrompt =
      langDirective +
      '당신은 외근이 많은 영업직 사용자를 위한 아침 일정 브리핑 어시스턴트입니다. ' +
      '제공된 오늘 일정 사실만 바탕으로 자연스럽게 소리내어 읽기 좋은 1~2문장 브리핑을 작성하세요. ' +
      '사실에 없는 내용(날씨, 실시간 교통상황, 장소 시설 정보 등)은 절대 지어내지 마세요. ' +
      langDirective;
    var userMessage = '# 오늘 일정 사실\n' + JSON.stringify(scheduleFacts);

    try {
      var args = await callLLMTool({
        systemPrompt: systemPrompt,
        userMessage: userMessage,
        toolSchema: BRIEFING_TOOL_SCHEMA,
        toolChoiceName: 'generate_briefing',
        override: llmOverride,
      });
      return { briefingText: (args && args.briefingText) || '' };
    } catch (err) {
      return { briefingText: '', _llmError: String((err && err.message) || err) };
    }
  }

  async function runClientPipeline(body) {
    if ((body.inputType || '') === 'briefing') {
      return generateBriefing(body);
    }
    var ctx = prepareContext(body);

    if (ctx.skipLLM) {
      var isLocate = ctx.inputType === 'locate';
      var q = ctx.text.replace(/근처\s*/g, '').trim() || ctx.text;
      var docs = await kakaoSearchDocs(q, {
        x: ctx.userLng,
        y: ctx.userLat,
        radius: isLocate ? null : ctx.userChipRadius,
        sort: isLocate ? 'accuracy' : 'distance',
        category_group_code: ctx.categoryGroupCode,
      });
      return {
        candidates: normalizeKakaoResults(docs),
        destination: q,
        transportMode: ctx.userTransportMode,
        spoken: '',
        topPick: null,
        clarification: '',
      };
    }

    var intent = await resolveIntent(ctx);
    if (!intent.categoryGroupCode) {
      var inferred = inferCategoryFromText(ctx.text);
      if (inferred) intent.categoryGroupCode = inferred;
    }
    console.log(
      '[search] "' + ctx.text + '" -> intent=' + intent.intent + ' query="' + intent.query + '" category=' + (intent.categoryGroupCode || '(none)') +
      ' transportMode=' + intent.transportMode + ' originHint=' + intent.originHint + ' dest=' + (intent.destinationFavoriteName || '(none)') +
      (intent._llmError ? ' llmError=' + intent._llmError : '')
    );

    if (intent.intent === 'navigate_favorite' && intent.destinationFavoriteName) {
      var dest = findFavorite(ctx.favorites, intent.destinationFavoriteName);
      if (dest) {
        return {
          candidates: [{
            index: 1, name: dest.name, address: '', category: '',
            lat: dest.lat, lng: dest.lng, distanceM: 0, distanceLabel: '', phone: '', placeUrl: '',
          }],
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

    var searchLat = ctx.userLat;
    var searchLng = ctx.userLng;
    if (intent.originHint && intent.originHint !== '현재위치') {
      var origin = findFavorite(ctx.favorites, intent.originHint);
      if (origin) {
        searchLat = origin.lat;
        searchLng = origin.lng;
        console.log('[search] 기준 위치 = 즐겨찾기 "' + intent.originHint + '" -> (' + origin.lat + ', ' + origin.lng + ')');
      } else {
        console.log('[search] 기준 위치 = 즐겨찾기 "' + intent.originHint + '" (매칭 실패, 현재 GPS로 대체)');
      }
    }

    var query = intent.query || ctx.text;
    var CAR_SEARCH_RADIUS_M = 20000;
    var searchRadius = intent.transportMode === 'car' ? CAR_SEARCH_RADIUS_M : ctx.userChipRadius;
    var searchDocs = await kakaoSearchDocs(query, {
      x: searchLng, y: searchLat, radius: searchRadius, sort: 'accuracy', category_group_code: intent.categoryGroupCode,
    });
    var candidates = normalizeKakaoResults(searchDocs);
    console.log('[search] 카카오 검색 "' + query + '" (반경 ' + searchRadius + 'm) -> ' + candidates.length + '건');

    if (candidates.length === 0 && intent.categoryGroupCode) {
      var categoryDocs = await kakaoCategoryDocs(intent.categoryGroupCode, { x: searchLng, y: searchLat, radius: searchRadius });
      candidates = normalizeKakaoResults(categoryDocs);
      console.log('[search] 키워드 0건 -> 카테고리(' + intent.categoryGroupCode + ') 검색 폴백 -> ' + candidates.length + '건');
    }

    var curated = await curateResults({
      candidates: candidates,
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

  window.runClientPipeline = runClientPipeline;
})();
