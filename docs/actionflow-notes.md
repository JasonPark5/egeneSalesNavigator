# ActionFlow(egene7) 연동 노하우

사내 ActionFlow로 검색 플로우(카카오 키워드 검색)를 실제로 만들면서 겪은 문제/원인/해결을
정리한 문서입니다. README의 "ActionFlow 플로우 계약"이 *무엇을* 만들어야 하는지를 정의한다면,
이 문서는 ActionFlow라는 도구 자체를 다룰 때 겪는 함정과 UI 사용법을 다룹니다.

## 1. 전체 구조 — Plugin / Plugin-API / Flow 액션 아이템 (3단계, 헷갈리기 쉬움)

1. **Plugin (Plugin Manager)**: 외부 시스템의 "연결 정보"만 등록. 예: Kakao Local이면
   Plugin URL = `https://dapi.kakao.com`. 여러 API가 공통으로 쓰는 헤더(예: 카카오는
   `Authorization: KakaoAK {REST API 키}`)를 여기 한 번만 등록해두면 이 Plugin 밑의 모든
   Plugin-API가 공유해서 쓸 수 있음.
2. **Plugin-API (Plugin-API Manager)**: 개별 API 하나하나의 **템플릿/정의**. API 경로, 메소드,
   header/param/body, 그리고 그 안에서 쓸 `#{key}` placeholder들을 정의. 이 placeholder들은
   아래 "input values" 표에 선언한 key와 이름이 같아야 함. **주의**: 여기서 params 탭의
   "value" 칸에 쓰는 `#{key}`는 이 Plugin-API *자체*가 요구하는 입력 슬롯 이름을 가리키는
   것뿐이지, flow의 Trigger나 다른 노드 데이터를 직접 참조하는 게 아님. 보통 key와 value가
   똑같은 이름이면 됨 (예: key=`query`, value=`#{query}`).
3. **Flow 캔버스 안의 액션 아이템**: 등록된 Plugin-API를 실제로 "호출하는 자리". 이 노드를
   클릭하면 (Plugin-API Manager와는 별개로) **"API 설정 > 파라미터"**라는 자체 입력 폼이 있고,
   여기서 Plugin-API가 요구하는 각 input value(query/x/y/...)에 실제 flow 데이터를
   Smart Component로 연결함 (예: `#{parameter.body.text}` — POST+JSON body 트리거일 때.
   자세한 건 2-1번 참고).

**겪었던 실수**: Plugin-API Manager의 params 탭(2번)에 flow 데이터 참조(`#{text}` 등)를
직접 넣으려고 시도 → 안 먹힘. 대신 **flow 캔버스의 액션 아이템(3번)**에서 연결해야 함.
"INPUT[1].QUERY 존재하지 않습니다" 같은 유효성 에러는 보통 3번 화면의 파라미터가
비어있을 때 뜸.

## 2. Smart Component 참조 문법 (상황별로 다름)

| 위치 | 문법 | 예시 |
|---|---|---|
| Plugin-API Manager의 params/header/body (템플릿 정의) | `#{key}` — 이 Plugin-API 자신의 input values 이름 | `#{query}` |
| Flow 액션 아이템의 파라미터 입력 폼 (**POST+JSON body 트리거일 때**) | `#{parameter.body.필드명}` — 아래 2-1 참고 | `#{parameter.body.text}` |
| Code 노드(JavaScript) 안에서 상위 노드 결과 참조 | `model["아이템 이름"]` | `model["KAKAO MAP"]` |
| Code 노드 안에서 Variable 필드 참조 | `model["Variable 아이템 이름"].필드명` | `model["검색변수"].originResolved` |
| Condition/Result/Plugin-API 파라미터 등에서 Code/Agent/Plugin-API 결과 참조 | `#{아이템 이름.경로.경로}` (dot notation) | `#{KAKAO MAP.meta.same_name.keyword}` |
| Condition/Result/Plugin-API 파라미터 등에서 **Variable** 필드 참조 | `#{필드명}` (아이템 이름 없이 필드명만 — Variable만 예외) | `#{originResolved}` |
| Smart Component 필드(소스 칸 등)에서 내장 Function 적용 | `함수명(#{...})` — fx 패널에서 String(`length`/`substring`/`indexOf`/`contains`/`trim`/...), Math(`add`/`sum`/`round`/...) 등 카테고리 확인됨. 고른 값의 타입에 따라 뜨는 함수 목록이 달라지는 것으로 보임(13번 항목 참고) | `length(#{candidates})` |

### 2-1. ⚠️ API Trigger의 "parameter" 목록 vs "요청 본문(Request Body)" — 제일 크게 삽질한 부분

API Trigger 속성 화면에는 두 가지 입력 선언이 따로 있음:

1. **파라미터 목록**(text/lat/lng/... 같은 필드를 하나씩 추가하는 표) — flow 캔버스의 액션
   아이템에서 `#{parameter.필드명}`(body 없이)로 참조하는, **flat 구조**.
2. **요청 본문(Request Body)** — 드롭다운에서 `application/json`을 고르고 JSON 스키마를
   입력하는 칸.

**실제 겪은 문제**: 우리 서버는 `Content-Type: application/json`으로 body를 통째로 POST함.
- 이 "요청 본문"을 **설정 안 하면(기본값 None)**, 진짜 POST 요청의 body가 아예 파싱이
  안 됨(활동 로그의 `__body__.contentType`이 `"empty"`로 찍힘) → `parameter.*`가 죄다
  비어서 → 뒤에서 카카오 호출이 400 남.
- `application/json`으로 바꾸고 body 스키마를 채워도, **body로 들어온 값은 flat
  `parameter.필드명`이 아니라 `parameter.body.필드명`처럼 `body` 밑에 중첩되어 들어옴.**
  즉 flow 액션 아이템에서 `#{parameter.lat}`처럼 참조하고 있었다면 그것도 다 고쳐야 함
  → `#{parameter.body.lat}`로.

**결론**: POST+JSON body로 호출하는 트리거라면
- 요청 본문을 반드시 `application/json`으로 설정하고, 실제 우리가 보내는 필드 구조와
  이름이 같은 JSON을 스키마로 채워둘 것 (예시 값은 빈 문자열/빈 배열이어도 됨).
- flow 안에서 그 값들을 쓸 땐 전부 **`#{parameter.body.필드명}`**로 참조할 것.
- 맨 위 "파라미터 목록"(flat)은 **Simulation의 입력값 모달을 편하게 쓰려고 만드는 것일
  뿐, 실제 POST 요청에서는 쓰이지 않는다.** (Simulation은 이 모달 값을 body 파싱 없이
  바로 꽂아넣는 방식이라 항상 성공하는 것처럼 보여서, 진짜 버그(본문 파싱 문제)를
  숨기고 있었음 — 아래 10번 디버깅 체크리스트에도 반영.) 필요 없으면 지워도 되지만,
  지우면 Simulation 모달로 편하게 값 채우던 걸 못 하고 매번 Request Body의 JSON
  텍스트를 직접 고쳐야 함.

## 3. 한글(비-ASCII) 인코딩 문제 — 여러 겹의 함정

증상: 카카오에 한글 검색어를 보내면 응답의 `meta.same_name.keyword`가 `"t�"`처럼 깨지거나,
아예 다른(엉뚱한) 검색 결과가 나옴.

**원인/해결 정리**:

- ❌ **API URL 필드에 `?query=#{text}`처럼 직접 문자열로 박아넣기** — 이 방식은 한글이
  전송 중에 깨짐. (근본 원인: URL 문자열을 통째로 만들 때 UTF-8 인코딩을 제대로 안 함)
- ❌ **수동으로 `%EC%B9%B4...`처럼 미리 URL-인코딩해서 텍스트로 타이핑** — 더 나쁨. 입력
  필드가 `%` 문자를 HTML 엔티티(`&#037;`)로 자동 이스케이프해버려서 `Illegal character in
  fragment` 에러가 남.
- ❌ **Code 노드에서 `encodeURIComponent()`로 미리 인코딩해서 넘기기** — 한 글자만 인코딩되는
  등(예: "병원" → "병"만) 이상하게 잘리는 현상이 있었음. 원인 미확정.
- ✅ **해결: 원문 한글을 그대로 Plugin-API의 "params" 탭(쿼리스트링 파라미터 메커니즘)에
  Smart Component로 연결.** URL 문자열에 직접 쓰지 말고 params 탭을 쓰면 인코딩을 플랫폼이
  알아서 올바르게 처리해줌. `meta.same_name.keyword`에 "병원"이 정확히 찍히는 것으로 확인.

**교훈**: 이 플랫폼에서 비-ASCII 텍스트가 관여하는 필드는, 되도록 **구조화된 입력(params
탭, input values)을 쓰고 URL/body에 직접 문자열로 조립하지 말 것.**

## 4. Windows PowerShell로 테스트할 때 (ActionFlow 문제 아님, 별개)

`Invoke-RestMethod -Body '{"text":"카페"}'`처럼 문자열을 바로 넘기면 Windows PowerShell
5.1이 UTF-8이 아닌 인코딩으로 보내서 한글이 깨짐. 이렇게 바이트로 명시 변환해서 보낼 것:

```powershell
$body = @{ text = "카페" } | ConvertTo-Json
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri "<URL>" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes
```

## 5. GET vs POST

카카오 로컬 검색(`/v2/local/search/keyword.json`)은 **GET + 쿼리스트링**. API Trigger나
Plugin-API 등록 시 기본으로 보게 되는 예시(Google Chat 등)는 POST+JSON body라서 헷갈리기
쉬운데, 외부 API 스펙에 맞게 메소드를 골라야 함.

`category_group_code`처럼 **선택적(optional) 파라미터가 빈 문자열이면 아예 카카오가 400
Bad Request를 던짐** — 값이 없을 땐 그 파라미터 자체를 안 보내는 게 안전. (이 플랫폼은
빈 값이어도 파라미터 자체를 빼는 조건부 처리가 쉽지 않아서, 지금은 이 필드를 아예 이
Plugin-API에서 뺐음 — 카테고리 필터링은 필요하면 별도 "카테고리 검색" API로 분리 예정.)

## 6. Code 노드 — 상위 데이터를 다룰 때

- Plugin-API(Web System) 호출 결과는 **이미 파싱된 객체**로 `model["아이템이름"]`에 들어옴.
  `JSON.parse(model["KAKAO MAP"])`처럼 또 파싱하면 `SyntaxError: Unexpected token o in
  JSON at position 1`(객체를 문자열로 취급해서 생기는 에러 — `[object Object]`의 'o'를
  가리킴) 남. **파싱하지 말고 바로 `.documents` 등으로 접근.**
- 단, **Agent/LLM 노드의 결과는 다름** — LLM 응답은 텍스트(예: `.answer` 필드)로 오고,
  그 텍스트 안에 JSON이 마크다운 코드블록(```json ... ```)으로 감싸져 오는 경우가 많음.
  이런 경우엔 코드블록을 벗겨내고 `JSON.parse()`를 명시적으로 해야 함:
  ```javascript
  var agent = model['에이전트 아이템 이름'];
  var text = (agent.answer || '').replace(/```json/g, '').replace(/```/g, '').trim();
  var parsed = JSON.parse(text);
  ```
- **Code 노드에서 상위 Plugin-API의 원본 객체를 그대로 `return`하면
  `com.steg.actionflow.exception.ActionFlowException: Can not parse json result`가 남**
  (원인: 원본 객체가 순수 JS 객체가 아니라 Java-JS 브릿지 객체라 직렬화가 안 되는 것으로
  추정). **해결**: 원본을 그대로 반환하지 말고, 필요한 필드만 뽑아 **완전히 새로운 순수
  객체/배열로 재조립**해서 반환할 것. 예:
  ```javascript
  var docs = model["KAKAO MAP"].documents || [];
  return docs.map(function(d, i) {
    var distanceM = parseInt(d.distance, 10) || 0;
    return {
      index: i + 1,
      name: d.place_name,
      address: d.road_address_name || d.address_name || '',
      category: d.category_group_name || (d.category_name || '').split(' > ').pop() || '',
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      distanceM: distanceM,
      distanceLabel: distanceM < 1000 ? (distanceM + 'm') : ((distanceM / 1000).toFixed(1) + 'km'),
      phone: d.phone || '',
      placeUrl: d.place_url || ''
    };
  });
  ```
- **디버깅 팁**: Code 노드 자체에 "TEST" 버튼이 있어서 전체 flow를 안 돌리고 이 노드만
  단독 실행해볼 수 있음. 원인 모를 때는 일단 원본 데이터를 그대로 반환해서 실제 구조부터
  확인 — 단, 위에 적은 것처럼 원본 통째 반환 자체가 에러날 수 있다는 점은 감안할 것.

## 7. Result(최종 응답)/End 노드 — JSON 템플릿 따옴표 규칙 (제일 많이 틀림)

Result 노드의 Response(JSON) 템플릿은 **엄격한 JSON 문법**을 지켜야 함. 특히:

- **문자열 값은 반드시 큰따옴표로 감싸야 함.** `#{...}` placeholder라도 예외 없음.
- **배열/객체 값은 따옴표 없이 그대로.**

```json
{
  "candidates": #{Code1},
  "destination": "#{KAKAO MAP.meta.same_name.keyword}",
  "transportMode": "#{parameter.body.transportMode}",
  "spoken": "",
  "topPick": null,
  "clarification": ""
}
```

`destination`/`transportMode`처럼 문자열인데 따옴표를 빼먹으면 치환 후
`destination: 병원,`처럼 되어 유효한 JSON이 아니게 되고, 이게 바로
`Can not parse json result` 에러의 실제 원인이었음 (Code 노드 문제가 아니라 **Result
노드**에서 나는 에러였는데 한참을 Code 노드 쪽에서 헤맸음 — 에러가 어느 액션 아이템
이름 아래 찍히는지 Activity Log에서 꼭 먼저 확인할 것).

## 8. 인증/게이트웨이 (egene7 마이그레이션 이슈, 우리 코드 문제 아님)

- 원래 설계: **Webhook 트리거 = 인증 불필요**(외부의 임의 발신자가 부르는 용도라 세션
  인증을 요구하면 애초에 성립 불가), **API 트리거 = 인증 필요**(내부 시스템 전용).
- egene7로 옮기며 버그로 **둘 다 인증이 필요하게** 바뀌어 있었음. 이번 해커톤 한정으로
  둘 다 인증 없이 열어주는 임시 패치를 받아서 해결.
- **플로우를 수정한 뒤에는 다시 활성화(Active)해야** 외부에서 호출 가능. 비활성/편집 중
  상태에서 외부 호출하면 로그인 페이지(HTML)로 리다이렉트되고, 이게 `403 Forbidden` /
  `Illegal character` 같은 알 수 없는 에러로 보여서 헷갈리기 쉬움.
- 브라우저(로그인 세션 있음)로 테스트하면 되는데 PowerShell/서버 코드(세션 없음)로
  테스트하면 안 되는 경우, 세션 게이트웨이 문제인지부터 의심할 것.

## 9. 유효성 검사(Validation) 에러 메시지 읽는 법

- `INPUT[1].QUERY 존재하지 않습니다` 같은 메시지는 **HTTP 에러가 아니라 저장/실행 전
  정적 유효성 검사** — 액션 아이템이 필요로 하는 입력값이 안 채워졌다는 뜻. Activity Log에
  `#유효성` 칩으로 표시됨(`#테스트`/`#시뮬레이션`과는 다른 카테고리).
- 실제 HTTP 에러(`org.sdf.slim.BizException: HTTP/1.1 400/401/403 ...`)는 상태코드만
  보지 말고 **해당 액션 아이템의 활동 로그 > 더보기**에서 실제 요청 URL과 응답 본문을
  꼭 확인할 것 — 상태코드만으로는 원인(인증 문제/파라미터 문제/서버 자체 에러)을 구분할
  수 없었음.

## 10. 디버깅 체크리스트 (막혔을 때 순서대로)

1. Activity Log에서 에러가 **어느 액션 아이템 이름** 아래 찍혔는지부터 확인 (Code 노드가
   의심되어도 실제로는 Result 노드 문제였던 사례 있음).
2. `#유효성` 칩이면 → 파라미터 미입력 문제. Flow 캔버스의 해당 노드 속성에서 입력값 확인.
3. HTTP 에러(400/401/403 등)면 → 상태코드만 보지 말고 실제 요청/응답 본문을 더보기로 확인.
4. Code 노드 결과가 이상하면 → 일단 원본을 그대로 return해서 실제 데이터 구조부터 확인
   (단, 원본 통째 반환 자체가 에러날 수 있음 — 7번 참고).
5. 최종 Result가 이상하면 → JSON 템플릿의 따옴표부터 의심.
6. **Simulation은 되는데 진짜 앱(localhost)에서 호출하면 안 되면** → 거의 항상 "요청
   본문(Request Body)" 문제. Simulation은 입력값 모달의 값을 body 파싱 없이 바로
   `parameter.*`에 꽂아넣기 때문에, 진짜 POST 요청의 body 파싱 문제를 재현하지 못함
   (2-1번 참고). Activity Log의 `__body__.contentType`이 `"empty"`면 body가 아예 안
   읽힌 것 — 요청 본문을 `application/json`으로 설정하고 `#{parameter.body.필드명}`으로
   참조하는지부터 확인.
7. **트리거 body에 실제로 보내는 필드가 다 선언돼있는지 확인.** 우리 서버가 보내는
   필드 중 하나라도 Request Body 스키마에 빠져있으면(예: `chipRadius`), 그 필드를
   쓰는 로직에서 `undefined`/빈 값이 흘러들어가 카카오 400 같은 하위 에러로 나타남 —
   증상이 엉뚱한 곳(외부 API 오류)처럼 보여서 헷갈리기 쉬움.

## 11. Variable / Switch / Condition으로 분기 결과 합류시키기

여러 케이스(예: `locate`는 반경 제한 없음·정확도순, `chip`은 반경 있음·거리순)에 따라
값을 다르게 만들어야 하는데 Smart Component만으로는 조건부 처리(값 있으면 이거, 없으면
저거)가 안 된다 — 이럴 때 Built-in tools의 **Variable/Switch/Condition** 노드를 쓴다.

- **Variable은 "선언"과 "할당"이 문법적으로 구분되지 않는다.** 처음에 Variable 노드로
  필드(예: `radius`, `sort`, `candidates`)를 선언해두면, **이후 플로우 어디서든 같은
  이름의 필드를 가진 Variable 노드를 또 두면 그게 곧 그 변수에 값을 대입하는 것**이다.
  별도의 "업데이트 모드" 같은 게 있는 게 아니라 이름이 같으면 같은 변수를 가리킨다.
- 선언 이후엔 (Condition/Result/Plugin-API 파라미터 같은 Smart Component 자리에서)
  `#{필드명}`으로 플로우 어디서든 바로 참조 가능(예: `#{candidates}`, `#{radius}`) —
  Variable 아이템 이름이나 다른 접두사 없이 그냥 필드 이름만 쓴다. (Code 노드 **안**에서는
  2번 표대로 `model["Variable 아이템 이름"].필드명`으로 접근.)
- **Switch/Condition의 각 분기는 서로 다른 액션 아이템을 거친 뒤 다시 하나의 다음
  노드로 합류할 수 있다.** 즉 분기 A는 Code1을 거치고, 분기 B는 Code2를 거쳐도, 각
  분기 끝에서 **같은 이름의 Variable에 결과를 대입**해두면, 합류 지점 이후로는
  어느 분기를 탔든 상관없이 `#{그 변수명}` 하나로 결과를 참조할 수 있다.
- **Condition의 조건식은 중첩 경로도 직접 참조 가능**하다. 예:
  `#{카카오맵.meta.total_count} == 0`처럼 Plugin-API 응답의 nested 필드를 Code 노드
  없이 바로 조건에 쓸 수 있음.
- **Variable의 타입은 String/Json/ListData/XML로 나뉘고, 배열 값은 반드시 ListData를
  써야 한다.** 배열을 Json 타입 변수에 넣으면(빈 배열이든 채워진 배열이든)
  `RESULTFORMAT 형식이 올바르지 않습니다` 에러가 남 — Json은 단일 객체(`{}`)용으로
  보임.

**실전 예시(검색 플로우의 주소검색 fallback)**: 카카오 키워드검색이 0건이면(도로명주소
스타일 입력이라 키워드검색이 잘 못 찾는 경우) 건물 상세정보(`6층` 등)를 뗀 뒤 카카오
주소검색으로 재시도하는 구조:

```
Trigger
 └ Variable 선언: radius='', sort='accuracy', candidates=[](ListData)
 └ Switch(inputType) → Variable(radius/sort 대입, locate/chip 각각) → 카카오 키워드검색
 └ Condition: #{카카오맵.meta.total_count} == 0
    ├ 거짓(0건 아님): Code(키워드검색 결과 → candidates 배열 변환) → Variable(candidates 대입)
    └ 참(0건): Code(건물 상세정보 제거) → 카카오 주소검색 → Code(주소검색 결과 → candidates 배열 변환) → Variable(candidates 대입)
 └ (합류) Result: { "candidates": #{candidates} }
```

## 12. ⚠️ 같은 플로우를 동시에(병렬로) 여러 번 호출하면 Variable이 섞일 수 있음

프론트엔드가 캘린더 일정 여러 개의 위치를 `Promise.all`로 동시에 검색하니(각 일정이
서로 독립적이라 병렬 처리가 자연스러워서), 같은 검색 플로우 인스턴스가 거의 동시에
여러 번 실행됐다. 이때 **서로 다른 요청인데 한쪽 요청의 결과 좌표가 다른 요청 것과
뒤섞여 나오는 현상**이 간헐적으로 발생함(예: "여의도" 검색인데 "삼성생명" 검색 결과를
받아옴) — 재현이 100%가 아니라 가끔만 나는 전형적인 레이스 컨디션 증상.

Switch/Condition/Variable을 검색 플로우에 추가한 뒤로 눈에 띄게 나타나서, **Variable
노드가 요청(실행)별로 격리되지 않고 플로우 인스턴스 차원에서 공유되는 것으로 추정**
(확정된 건 아니고, 프론트엔드를 병렬→순차 호출로 바꾸니 재현이 사라진 것으로 정황
확인만 됨). ActionFlow 자체에 실행별 변수 격리 옵션이 있는지는 못 찾음.

**대응**: 같은 플로우를 동시에 여러 번 호출하는 걸 피하고 순차 호출로 바꿨다
(`web/index.html`의 `resolveEventTravelTimes()` — `Promise.all` → `for`+`await` 순차
처리, 커밋 `c56ba55`). 일정 개수가 보통 적어서 체감 속도 차이는 크지 않음. Variable을
쓰는 플로우를 만들 땐 애초에 동시 호출 가능성을 염두에 두고, 프론트엔드에서 순차
호출하거나 플로우 자체에 실행 격리 옵션이 있는지 먼저 확인할 것.

## 13. `text` 자연어 검색 — 노드별 상세 설계 (실제 캔버스와 1:1, 순서대로 복사)

지금까지 검색 플로우는 `chip`/`locate`(`skipLLM=true`, LLM 없이 카카오 검색만)만 만들어져
있었다. 남은 건 `text` 분기 — `server/src/pipeline.js`의 `resolveIntent()` + 원점(origin/
location) 해석 + 카카오 폴백 체인 + `curateResults()` 전체를 ActionFlow로 옮기는 것.

**이 절의 구성 원칙 (이전 판 문제 수정)**: 예전 판은 13-2의 전체 다이어그램과 13-3~13-9의
상세 설명이 서로 다른 표현(Condition A/B, "검색 분기" 같은 추상적 이름)을 써서 실제로
만들 때 다이어그램에 있던 navigate_favorite/ambiguous 조기 분기를 상세 절에서 빠뜨리는
문제가 있었다. 이번 판은 **13-2의 노드 목록과 13-3 이후 상세 설명이 정확히 같은 노드
이름**을 쓰도록 통일했고, 노드 이름은 지금까지 실제로 만든 캔버스(의도분석/의도파싱/
검색변수/검색분기/즐겨찾기매칭origin)를 그대로 따랐다. **"신규"라고 표시된 노드만
새로 추가하면 되고, 나머지는 이미 만든 그대로 두면 된다** (단, 즐겨찾기매칭origin은
13-5의 반환값 형태를 살짝 다듬는 걸 권장 — 아래 참고).

### 13-1. ✅ 확인됨: Code 노드 트리거 접근법 + 실제 요청 본문 스키마

**Code 노드**에서는 `model.parameter.body.필드명`으로 트리거 body를 바로 읽을 수 있다
(예: `var q = model.parameter.body.text;`). 2번 항목의 Smart Component 문법표에 있는
`#{parameter.body.필드명}`(Plugin-API 파라미터/Result JSON 템플릿용)과는 문법만 다를 뿐
같은 데이터를 가리킨다.

**실제 요청 본문(Request Body)** — `web/index.html`의 `buildSearchPayload()`가 실제로
보내는 필드 그대로(README 표의 요약보다 상세함, API Trigger의 "요청 본문" 스키마에
그대로 붙여넣을 것):

```json
{
  "text": "미사역 주변에 아이랑 갈만한 파스타집 찾아줘",
  "lat": 37.5665,
  "lng": 126.9780,
  "landmark": "",
  "transportMode": "transit",
  "categoryGroupCode": "",
  "inputType": "text",
  "userId": "b3f1c2e4-3a1d-4b7a-9c2e-1f0a2b3c4d5e",
  "tz": "Asia/Seoul",
  "chipRadius": 5000,
  "lang": "ko",
  "favorites": [
    { "name": "래미안강남포레스트", "alias": "집", "lat": 37.4979, "lng": 127.0276 },
    { "name": "우리금융 상암센터", "alias": "회사", "lat": 37.5793, "lng": 126.8912 }
  ],
  "recentSearches": [
    { "text": "강남역 스타벅스", "code": "CE7" }
  ],
  "localTime": "2026-09-07T08:04:12.345Z",
  "llmProvider": "openai",
  "llmApiKey": "sk-..."
}
```

⚠️ **`llmProvider`/`llmApiKey`는 사용자가 설정에서 개인 키를 입력하지 않은 대부분의 경우
아예 body에서 빠진다** (`index.html`이 `undefined`로 넣는데 `JSON.stringify`가 `undefined`
값 키를 통째로 생략함) — `null`이나 빈 문자열이 아니라 **필드 자체가 없음**. API Trigger의
요청 본문 스키마에서 이 둘은 required로 두지 말고, Code 노드에서 읽을 땐
`model.parameter.body.llmProvider || ''`처럼 항상 기본값을 깔 것(트리거 파싱 방식에 따라
없는 필드를 읽으면 에러가 날 수도 있으니 방어적으로).
`recentSearches[].code`는 그 검색 당시의 `categoryGroupCode`를 기록해둔 것(있으면).

### 13-2. 전체 노드 순서 (이 순서 그대로 캔버스에 배치 — 아래 13-3~13-7이 각 행의 상세)

⚠️ **확인됨(스크린샷 기준): Condition 노드는 "소스 / 연산자 / 값"으로 딱 하나만 비교하는
구조다 — `&&`/`||`로 여러 조건을 한 노드에 합칠 수 없다.** AND가 필요한 곳은 아래 두 가지
방법 중 하나로 풀었다:

1. **양쪽 값이 전부 `의도파싱`(3번 Code) 시점에 이미 나와 있으면 → Code 안에서 미리
   정리**해서 뒤에 Condition을 아예 안 두는 쪽을 우선한다. 예: `intent`가
   `navigate_favorite`인데 `destinationFavoriteName`이 비어있는 경우 — 이건 `의도파싱`
   Code 노드 안에서 바로 `intent`를 `'search'`로 되돌려버리면 그만이라, 굳이 "그리고
   이름도 있나?"를 묻는 Condition(전 판의 `4b`)이 따로 필요 없다(아래 참고).
2. **한쪽 값이 나중 단계(다른 Condition/Code/Plugin-API 실행 결과)에야 정해지면 →
   Condition 노드 2개를 체인**으로 연결한다(14a/14b, 23a/23b, 26a/26b). `originResolved`는
   13번 즐겨찾기매칭이 끝나야, `count`는 그때그때 카카오 API 응답이 와야 알 수 있는
   값이라 `의도파싱` 시점엔 아직 없다 — 이런 건 Code로 미리 당겨올 수가 없다.

⚠️ **확인됨(스크린샷 기준): Smart Component 필드(소스 칸 등)에서 내장 Function을 쓸 수
있다** — Condition "소스" 칸 오른쪽에 fx 패널이 있고, String 카테고리에
`length`/`substring`/`indexOf`/`contains`/`trim`/... 등, Math 카테고리에
`add`/`sum`/`round`/... 등이 있음. 그래서 배열 개수 확인은 이전 판처럼 **Code 노드가
`count`를 따로 계산해서 반환**할 필요 없이, Condition 소스에서 바로 `length(#{candidates})`
같은 함수 호출로 처리한다(18번 "후보변수"는 이제 `candidates`(배열) 필드 하나만 있으면 됨).
⚠️ 단, 스크린샷은 String 타입 필드(`#{의도파싱.originHint}`)를 선택한 상태에서 뜬 패널이라
`length`가 문자열 전용인지, 배열(ListData/Array) 타입을 고르면 다른 카테고리(예:
"List"/"Array")에 별도의 개수 함수가 따로 뜨는지는 확인 못 함(플랫폼이 선택된 값의
타입에 맞춰 함수 목록을 바꿔주는 것으로 보임) — `candidates`를 소스로 골랐을 때 실제로
뜨는 함수 이름으로 아래 `length(...)` 자리를 바꿔 끼우면 됨(15번 항목 질문).

**Switch로 바꾼 부분**: `#{의도파싱.intent}`는 `search`/`navigate_favorite`/`ambiguous` 셋
중 하나인 **전형적인 enum 분기**라서, 예전에 같은 값을 두 번 따로 비교하던 Condition
두 개를 **Switch 노드 하나**로 합쳤다(11번 항목에 이미 나온 `Switch(inputType)` 예시와
같은 3-way 분기, default 케이스 지원 확인됨). 위 1번 방법(Code에서 미리 정리)까지
같이 적용하니, Switch의 `navigate_favorite`/`ambiguous` 케이스는 **더 이상 뒤에 확인
Condition을 안 두고 바로 다음 노드로 간다**(전 판의 `4b`/`8b` 삭제). 반면 `14a/14b`
(originResolved && locationHint 있음), `23a/23b`(candidates 비었음 && categoryGroupCode
있음), `26a/26b`(candidates 비었음 && query 있음), 13-6의 폴백 체인(20/23a/26a/29, "이전
단계 결과가 비었으면 다음 단계 시도")은 전부 위 2번 경우(한쪽 값이 나중에야 정해짐)라
그대로 Condition 체인으로 남아있다 — Switch도, Code 선처리도 시점 문제 때문에 대신할 수
없다.

```
 1. API Trigger                     [있음]        13-1
 2. 의도분석            (Agent)      [있음]        13-3
 3. 의도파싱            (Code)       [있음, destinationFavoriteName/clarification 없으면
                                       intent를 'search'로 되돌리는 정리 로직 추가 — 13-3]
 4. 의도분기            (Switch)     [신규] — 소스=#{의도파싱.intent}  13-4
    case "navigate_favorite":
      → 5. 즐겨찾기매칭destination (Code) [신규] → 6. 즐겨찾기매칭destination확인 (Condition) [신규]  13-4
           YES → 7. 즉시응답즐겨찾기 (Result, 종료) [신규]  13-4
           NO  → 10. 검색변수로
    case "ambiguous":
      → 9. 즉시응답모호 (Result, 종료) [신규]  13-4
    default(그 외 = "search" 등):
      → 10. 검색변수로

10. 검색변수 (Variable) [있음, 필드 재확인]  13-5
11. 검색분기            (Condition)  [있음]        13-5
      YES → 12. 즐겨찾기매칭origin (Code) [있음, 반환형태 다듬기 권장]  13-5
              → 13. 즐겨찾기매칭origin확인 (Condition) [신규]  13-5
                   YES → 검색변수 재대입(Variable) [신규] → 14a
                   NO  ↘
      NO  ─────────────┴→ 14a. location힌트분기_미해결 (Condition) [신규] — 소스=#{originResolved}, !=, true  13-5
      YES → 14b. location힌트분기_힌트있음 (Condition) [신규] — 소스=#{의도파싱.locationHint}, !=, ""  13-5
              YES → 15. 즐겨찾기매칭location (Code) [신규]  13-5
                      → 16. 즐겨찾기매칭location확인 (Condition) [신규]  13-5
                           YES → 검색변수 재대입(Variable) [신규] → 18
                           NO  → 17. 카카오지명검색 (Plugin-API) [신규] 13-5
                                   → 지명검색결과분기 (Condition) [신규] 13-5
                                        0건아님 → 지명검색결과정규화(Code) → 검색변수 재대입(Variable) → 18
                                        0건    ↘
              NO  ↘
      NO  ─────────┴──────────┴→ 18. 후보변수  (Variable, candidates 하나만)   [신규]  13-6
19. 쿼리결정            (Code)       [신규]        13-6
20. 키워드검색분기       (Condition)  [신규] — 소스=#{쿼리결정.query}, !=, ""       13-6
      YES → 카카오키워드검색메인(Plugin-API) → 키워드검색결과정규화(Code) → 후보변수 재대입(Variable) → 23a
      NO  ─────────────────────────────────────────────────────────────┘
23a. 카테고리검색분기_비었음 (Condition) [신규] — 소스=length(#{candidates}), ==, 0
      YES → 23b. 카테고리검색분기_카테고리있음 (Condition) [신규] — 소스=#{의도파싱.categoryGroupCode}, !=, ""
              YES → 카카오카테고리검색(Plugin-API) → 카테고리검색결과정규화(Code) → 후보변수 재대입(Variable) → 26a
              NO  ↘
      NO  ────────┴→ 26a. 전국검색분기_비었음 (Condition) [신규] — 소스=length(#{candidates}), ==, 0
      YES → 26b. 전국검색분기_쿼리있음 (Condition) [신규] — 소스=#{쿼리결정.query}, !=, ""
              YES → 카카오키워드검색전국(Plugin-API) → 전국검색결과정규화(Code) → 후보변수 재대입(Variable) → 29
              NO  ↘
      NO  ────────┴→ 29. 주소검색분기         (Condition)  [신규] — 소스=length(#{candidates}), ==, 0
      YES → 건물상세제거(Code) → 카카오주소검색(Plugin-API) → 주소검색결과정규화(Code) → 후보변수 재대입(Variable) → 32
      NO  ─────────────────────────────────────────────────────────────┘
32. 큐레이션분기         (Condition)  [신규] — 소스=length(#{candidates}), >, 0        13-7
      YES → 후보목록축약(Code) → 큐레이션(Agent) → 큐레이션파싱(Code) → 36. 최종응답큐레이션있음(Result, 종료)
      NO  → 37. 최종응답큐레이션없음(Result, 종료)
```

**주의(중요)**: `pipeline.js`에서는 `navigate_favorite`인데 즐겨찾기 매칭에 실패하면
**그냥 검색 분기(10번, 검색변수)로 자연스럽게 흘러간다**(별도 에러 처리 없음 — `ambiguous`
쪽은 `clarification`이 있는 게 이미 전제라 매칭 실패에 해당하는 경우가 없음, 3번
Code에서 정리되고 나면 남는 경우는 이거 하나뿐) — 즉 4번 Switch의 default 케이스뿐
아니라, 6번 Condition의 "NO" 쪽도 최종적으로 10번(검색변수)에 도달해야 원본과 동작이
같아진다.

### 13-3. 노드 2~3 — 의도분석(Agent) / 의도파싱(Code) [이미 있음]

**확인됨: Agent 노드에 함수 호출(tool use)은 없고 System Prompt/User Prompt 두 칸뿐이다.**
6번 항목에서 이미 확인된 대로 결과는 텍스트(`.answer`)로 오고, 마크다운 코드블록으로
감싸진 JSON일 수 있다 — 그래서 System Prompt에서 순수 JSON 출력을 강하게 지시한다.

**Agent "의도분석" System Prompt**:

```
중요: 사용자 UI 언어는 한국어입니다. spoken, clarification 등 모든 자유 텍스트 출력 필드를 한국어로 작성하세요. (UI 언어가 english면 이 문단 대신 "IMPORTANT: ... English only"로 교체)

당신은 한국 길찾기 앱의 의도 분석 어시스턴트입니다. 사용자의 자연어 발화에서 카카오 로컬 검색에 쓸 쿼리/카테고리/필터를 추출하세요.
즐겨찾기 별칭(집, 회사 등)이 발화에서 목적지 자체로 쓰이면(예: '집으로 가자', '회사 가는 길') intent='navigate_favorite'이고 destinationFavoriteName에 그 별칭을 넣으세요.
즐겨찾기 별칭이 검색 기준 위치로만 쓰이면(예: '집 근처 편의점', '회사 주변 카페') intent='search'이고 originHint에만 넣으세요 (destinationFavoriteName은 비움).
originHint/destinationFavoriteName에 즐겨찾기를 넣을 때는 '# 즐겨찾기' 목록에 있는 alias 값을 토씨 하나 안 틀리고 그대로 복사해서 넣으세요.
즐겨찾기가 아닌 임의의 지역/역/동네/랜드마크명이 검색 기준 위치로 쓰이면(예: '미사역 주변 맛집', '홍대에서 혼술', '판교역 근처 카페') locationHint에 그 지명만 넣으세요(originHint는 '현재위치'로 둠). 이때 query에는 그 지명을 절대 포함하지 마세요.
지명 없이 그냥 '카페 찾아줘'처럼 현재 위치 기준이면 locationHint는 비워두세요.
발화가 지역/역/동네/랜드마크명 단독으로만 이루어져 있으면(예: '미사역', '강남역', '홍대') query에 그 이름을 그대로 넣고 categoryGroupCode와 locationHint는 반드시 빈 문자열로 두세요.
'# 최근 검색'은 '거기', '그 근처', '아까 거기서' 처럼 지금 발화만으로는 뜻이 불완전할 때만 참고하세요.
이동수단(transportMode)은 발화에 명시적으로 언급된 경우에만 그 값으로 바꾸고, 언급이 없으면 컨텍스트의 '이동수단 기본' 값을 그대로 유지하세요.
query는 실제 상호명/업종에 매칭될 짧은 검색어만 넣고, '아이랑 갈만한' 같은 동반자/분위기/목적 수식어는 query에서 빼서 filters에 넣으세요.
모호하면 clarification에 짧은 질문을 넣고 intent='ambiguous'.

categoryGroupCode는 다음 중 하나이거나 빈 문자열: FD6=음식점/맛집, CE7=카페, CS2=편의점, PM9=약국, SW8=지하철역, PK6=주차장, BK9=은행, OL7=주유소/충전소, HP8=병원, MT1=대형마트, AD5=숙박, AT4=관광명소, CT1=문화시설, PO3=공공기관, AC5=학원, SC4=학교, PS3=어린이집/유치원, AG2=부동산.

아래 JSON 형식으로만 답하세요. 설명 문장이나 마크다운 코드블록 없이, 이 스키마의 순수 JSON 객체 하나만 출력하세요. 모든 필드를 항상 포함하세요(해당 없으면 빈 문자열 "" 또는 빈 배열 []):
{
  "intent": "search" | "navigate_favorite" | "ambiguous",
  "query": "string",
  "categoryGroupCode": "string",
  "transportMode": "transit" | "car",
  "originHint": "string",
  "locationHint": "string",
  "destinationFavoriteName": "string",
  "filters": ["string"],
  "spoken": "string",
  "clarification": "string"
}
```

**Agent "의도분석" User Prompt** (Smart Component로 트리거 값 바인딩 — Agent 노드 프롬프트
입력창에서도 `#{parameter.body.x}`가 먹히는지는 15번 항목 질문 참고. 안 먹히면 Agent 앞에
Code 노드를 하나 두고 문자열을 직접 조립해서 넘기는 방식으로 바꿀 것):

```
# 사용자 발화
"#{parameter.body.text}"

# 컨텍스트
- 위치: (#{parameter.body.lat}, #{parameter.body.lng})
- 이동수단 기본: #{parameter.body.transportMode}
- 입력 방식: #{parameter.body.inputType}
- 언어: #{parameter.body.lang}

# 즐겨찾기
#{parameter.body.favorites}

# 최근 검색
#{parameter.body.recentSearches}
```

⚠️ `favorites`/`recentSearches`는 배열인데, Smart Component가 프롬프트 텍스트에 그대로
치환했을 때 `[object Object]`로 깨지는지 아니면 JSON 문자열로 잘 치환되는지 확인 필요
(15번 항목 질문). 깨지면 Agent 앞에 Code 노드를 하나 두고
`JSON.stringify(model.parameter.body.favorites)`로 미리 문자열을 만들어 넘기는 방식으로
바꾸면 됨.

**Code "의도파싱"** (지금 만든 노드가 `var agent = model["의도분석"];`으로 시작한다고
하셨는데, 아래가 그 뒤에 이어져야 하는 전체 내용 — 이미 있는 앞부분은 그대로 두고
나머지가 빠져있다면 채워 넣으면 됨):

```javascript
var agent = model["의도분석"];
var text = (agent.answer || '').replace(/```json/g, '').replace(/```/g, '').trim();
var parsed = {};
try { parsed = JSON.parse(text); } catch (e) { parsed = {}; }

// 즐겨찾기 목록에 없는 흔한 업종 단어가 원문에 있으면 categoryGroupCode 보조 추론
// (pipeline.js의 CATEGORY_KEYWORDS와 완전히 동일해야 함 — 새 업종 추가 시 양쪽 다 갱신).
var CATEGORY_KEYWORDS = [
  ['FD6', ['맛집','밥집','식당','고깃집','고기집','국밥','냉면','분식','돈까스','파스타','이자카야','포차','중국집','일식집','백반','뷔페']],
  ['CE7', ['카페','커피','디저트','베이커리','빵집']],
  ['CS2', ['편의점']],
  ['PM9', ['약국']],
  ['SW8', ['지하철역','전철역']],
  ['PK6', ['주차장']],
  ['BK9', ['은행','atm','현금인출기']],
  ['OL7', ['주유소','충전소']],
  ['HP8', ['병원','의원','치과','한의원']],
  ['MT1', ['대형마트','이마트','홈플러스','롯데마트']],
  ['AD5', ['호텔','모텔','펜션','게스트하우스','리조트','숙소']],
  ['AT4', ['관광지','관광명소','전망대','유적지']],
  ['CT1', ['영화관','극장','미술관','박물관','공연장','전시관']],
  ['PO3', ['주민센터','구청','시청','동사무소','우체국','경찰서','소방서']],
  ['AC5', ['학원']],
  ['SC4', ['학교','초등학교','중학교','고등학교','대학교']],
  ['PS3', ['어린이집','유치원']],
  ['AG2', ['부동산','공인중개사']]
];

// 트리거 body는 Code 노드에서 model.parameter.body.*로 직접 읽는다(13-1 확인됨).
var originalText = model.parameter.body.text || '';
var defaultCategory = model.parameter.body.categoryGroupCode || '';
var userTransportMode = model.parameter.body.transportMode || 'transit';

var intent = {
  intent: parsed.intent || 'search',
  query: parsed.query != null ? parsed.query : originalText,
  categoryGroupCode: parsed.categoryGroupCode || defaultCategory || '',
  transportMode: parsed.transportMode || userTransportMode,
  originHint: parsed.originHint || '현재위치',
  locationHint: parsed.locationHint || '',
  destinationFavoriteName: parsed.destinationFavoriteName || '',
  filters: Array.isArray(parsed.filters) ? parsed.filters : [],
  spoken: parsed.spoken || '',
  clarification: parsed.clarification || ''
};

if (!intent.categoryGroupCode) {
  var found = CATEGORY_KEYWORDS.find(function (e) {
    return e[1].some(function (kw) { return originalText.indexOf(kw) !== -1; });
  });
  if (found) intent.categoryGroupCode = found[0];
}

// pipeline.js는 navigate_favorite인데 destinationFavoriteName이 없거나 ambiguous인데
// clarification이 없으면 그 분기 자체를 안 타고 그냥 검색으로 흘려보낸다(if 조건에
// && 로 같이 검사하는 방식) — 여기서 미리 intent를 'search'로 되돌려두면, 4번
// Switch 뒤에 "그런데 필드가 비어있으면?"을 또 물어보는 Condition(4b/8b)이
// 필요 없어진다. 이 두 필드는 항상 Agent 응답에서 나오는 값이라(뒤에서 다른
// 노드가 채우는 값이 아님) 여기서 한 번에 정리해도 안전함 — 14a/14b·23a/23b·
// 26a/26b가 여전히 Condition 체인인 이유(13-2 참고)와 대조됨: 그것들은 반대로
// originResolved/count처럼 *이후* 단계에서 정해지는 값이 껴 있어서 여기서
// 미리 계산해둘 수가 없음.
if (intent.intent === 'navigate_favorite' && !intent.destinationFavoriteName) {
  intent.intent = 'search';
}
if (intent.intent === 'ambiguous' && !intent.clarification) {
  intent.intent = 'search';
}

return intent; // 순수 객체 — 6번 항목의 "Can not parse json result" 함정 주의
```

이후 모든 노드에서 이 결과는 `#{의도파싱.intent}`, `#{의도파싱.query}` 처럼(Condition/
Result 등) 또는 `model["의도파싱"].intent`처럼(Code 노드 안) 참조한다.

### 13-4. 노드 4~9 — 의도분기(Switch) / 즐겨찾기매칭destination / 즉시응답모호 (조기 종료, 전부 신규)

`intent`가 `navigate_favorite`이면서 즐겨찾기가 실제로 매칭되거나, `ambiguous`이면(이
시점엔 `clarification`이 반드시 있음 — 아래 참고) 카카오 검색/큐레이션 없이 **바로
응답하고 끝낸다.** 그 외엔 전부 10번(검색변수)으로 흘러간다.

**4. Switch "의도분기"**: 소스 `#{의도파싱.intent}`. `intent`는 `search`/`navigate_favorite`/
`ambiguous` 셋 중 하나만 나오는 enum 값이라, 예전 판에서 같은 필드를 두 번 따로 비교하던
Condition 2개(`intent==navigate_favorite`, `intent==ambiguous`) 대신 **Switch 하나로 3-way
분기**했다(11번 항목의 `Switch(inputType)` 예시와 같은 패턴). default 케이스 지원 확인됨.
case는 3개: `navigate_favorite` → 5로, `ambiguous` → 9로, **default(그 외 — 사실상
`search`)** → 10(검색변수)으로.

⚠️ **각 case 뒤에 "그런데 짝 필드도 있나?"를 다시 묻는 Condition이 없다** — `intent`가
`navigate_favorite`인데 `destinationFavoriteName`이 비어있거나 `ambiguous`인데
`clarification`이 비어있는 경우는, **3번 `의도파싱` Code 안에서 이미 `intent`를
`'search'`로 되돌려놨기 때문에** 여기 Switch에 도달한 시점엔 그 경우가 존재하지 않는다
(13-3 참고). 두 필드 다 Agent 응답에서 바로 나오는 값이라 `의도파싱` 시점에 이미 다
갖춰져 있어서 가능한 정리다 — 즐겨찾기 매칭 자체의 성공/실패(6번)는 이후에나 알 수 있는
별개의 일이라 그건 그대로 Condition으로 남아있다.

**5. Code "즐겨찾기매칭destination"** (Switch의 `navigate_favorite` 케이스):
```javascript
var favorites = model.parameter.body.favorites || [];
var hint = (model["의도파싱"].destinationFavoriteName || '').trim();
var match = favorites.find(function (f) {
  return (f.alias && (f.alias === hint || hint.indexOf(f.alias) === 0)) ||
         (f.name && (f.name === hint || hint.indexOf(f.name) === 0));
});
return match
  ? { matched: true, name: match.name, alias: match.alias || '', lat: match.lat, lng: match.lng }
  : { matched: false };
```
(`null` 대신 `{matched: boolean}` 형태로 반환 — 이어지는 Condition에서 `== true`로 비교하면
플랫폼이 `null` 비교를 어떻게 처리하는지 몰라도 안전함. 아래 즐겨찾기매칭origin/location도
같은 패턴.)

**6. Condition "즐겨찾기매칭destination확인"**: 소스 `#{즐겨찾기매칭destination.matched}`,
연산자 `==`, 값 `true` — YES면 7로, NO면 10(검색변수)으로.

**7. Result "즉시응답즐겨찾기"** (YES 분기, 플로우 종료):
```json
{
  "candidates": [
    {
      "index": 1,
      "name": "#{즐겨찾기매칭destination.name}",
      "address": "",
      "category": "",
      "lat": #{즐겨찾기매칭destination.lat},
      "lng": #{즐겨찾기매칭destination.lng},
      "distanceM": 0,
      "distanceLabel": "",
      "phone": "",
      "placeUrl": ""
    }
  ],
  "destination": "#{즐겨찾기매칭destination.alias}",
  "transportMode": "#{의도파싱.transportMode}",
  "spoken": "#{의도파싱.spoken}",
  "topPick": { "index": 0, "reason": "" },
  "clarification": ""
}
```
(`lat`/`lng`는 숫자라 따옴표 없이 — 7번 항목 규칙.)

**9. Result "즉시응답모호"** (Switch의 `ambiguous` 케이스 — Condition 없이 바로 연결,
플로우 종료):
```json
{
  "candidates": [],
  "destination": "",
  "transportMode": "#{의도파싱.transportMode}",
  "spoken": "#{의도파싱.clarification}",
  "topPick": null,
  "clarification": "#{의도파싱.clarification}"
}
```

6번 Condition의 NO는 10번(검색변수)으로 이어진다(Switch의 default 케이스와 합쳐서 결국
두 갈래 다 같은 곳으로 모임).

### 13-5. 노드 10~17 — 검색변수 / 검색분기 / location힌트분기_미해결·힌트있음 (원점 해석)

`originHint` → 즐겨찾기 매칭 → (실패 시) `locationHint` → 즐겨찾기 매칭 → (실패 시) 카카오
지명 검색 순서로 `searchLat`/`searchLng`/`anchorLabel`을 정한다.

**10. Variable "검색변수"** (이미 있음 — 확인됨: Variable 타입에 불리언이 실제로 있음, 지금
있는 4개 필드가 아래와 같은지만 재확인):
```
searchLat = #{parameter.body.lat}   (문자열 타입으로 만들었어도 숫자 문자열이라 비교/연산엔
searchLng = #{parameter.body.lng}    문제없음 — 스크린샷상 지금 문자열 타입으로 보임, 그대로 둬도 됨)
anchorLabel = ''                     (문자열)
originResolved = false               (불리언)
```

**11. Condition "검색분기"** (이미 있음 — 그대로 유지): 소스 `#{의도파싱.originHint}`, 연산자
`!=`, 값 `현재위치`. (`defaultIntent`에서 `originHint`가 항상 `'현재위치'` 기본값을 가지므로
빈 문자열 체크는 불필요 — 지금 만든 그대로 맞음, 스크린샷과 동일.)

**12. Code "즐겨찾기매칭origin"** (이미 있음 — 지금 `return match || null;` 형태라면 아래로
바꾸는 걸 권장. 5번과 같은 패턴):
```javascript
var favorites = model.parameter.body.favorites || [];
var hint = (model["의도파싱"].originHint || '').trim();
var match = favorites.find(function (f) {
  return (f.alias && (f.alias === hint || hint.indexOf(f.alias) === 0)) ||
         (f.name && (f.name === hint || hint.indexOf(f.name) === 0));
});
return match
  ? { matched: true, name: match.name, alias: match.alias || '', lat: match.lat, lng: match.lng }
  : { matched: false };
```

**13. Condition "즐겨찾기매칭origin확인"** (신규): 소스 `#{즐겨찾기매칭origin.matched}`,
연산자 `==`, 값 `true`.
YES → **Variable "검색변수" 재대입**(같은 이름의 Variable 노드를 하나 더 둠):
```
searchLat = #{즐겨찾기매칭origin.lat}
searchLng = #{즐겨찾기매칭origin.lng}
anchorLabel = #{즐겨찾기매칭origin.alias}
originResolved = true
```
NO → 그대로(변경 없이) 14a번으로.

**14a. Condition "location힌트분기_미해결"** (신규, 13번 YES 뒤(재대입 후)/NO 둘 다 여기로
합류): 소스 `#{originResolved}`, 연산자 `!=`, 값 `true` — YES면 14b로, NO면 18(후보변수)로.

**14b. Condition "location힌트분기_힌트있음"** (14a YES 분기): 소스
`#{의도파싱.locationHint}`, 연산자 `!=`, 값 (빈 문자열) — YES면 15로, NO면 18(후보변수)로.

**15. Code "즐겨찾기매칭location"** (14b YES 분기, 신규 — 12번과 동일 패턴, `hint`만 다름):
```javascript
var favorites = model.parameter.body.favorites || [];
var hint = (model["의도파싱"].locationHint || '').trim();
var match = favorites.find(function (f) {
  return (f.alias && (f.alias === hint || hint.indexOf(f.alias) === 0)) ||
         (f.name && (f.name === hint || hint.indexOf(f.name) === 0));
});
return match
  ? { matched: true, name: match.name, alias: match.alias || '', lat: match.lat, lng: match.lng }
  : { matched: false };
```

**16. Condition "즐겨찾기매칭location확인"** (신규): 소스 `#{즐겨찾기매칭location.matched}`,
연산자 `==`, 값 `true`.
YES → **Variable "검색변수" 재대입**:
```
searchLat = #{즐겨찾기매칭location.lat}
searchLng = #{즐겨찾기매칭location.lng}
anchorLabel = #{즐겨찾기매칭location.alias}
```
(→ 18번으로) NO → 17번으로.

**17. 카카오지명검색 → 지명검색결과분기 → 지명검색결과정규화** (신규 — `locate` 분기에서
이미 등록한 카카오 키워드검색 Plugin-API를 재사용, 파라미터만 다르게 바인딩한 새
액션아이템):

- **카카오지명검색** (Plugin-API 액션아이템, 키워드검색 API 재사용): `query =
  #{의도파싱.locationHint}`, `x`/`y`/`radius`/`category_group_code`는 **비워둠**(전국
  정확도순 검색이라 좌표/반경 없이), `sort = accuracy`, `size = 5`.
- **Condition "지명검색결과분기"**: 소스 `#{카카오지명검색.meta.total_count}`, 연산자 `==`,
  값 `0` (11번 항목에서 이미 확인된 nested 필드 참조 방식 그대로 — 이건 배열의 `.length`가
  아니라 카카오 응답의 실제 JSON 필드라 안전함).
  - YES(0건) → 그대로(변경 없이) 18번으로.
  - NO(0건 아님) → **Code "지명검색결과정규화"**:
    ```javascript
    var docs = model["카카오지명검색"].documents || [];
    var d = docs[0];
    if (!d) return { matched: false };
    return { matched: true, lat: parseFloat(d.y), lng: parseFloat(d.x), name: d.place_name };
    ```
    → **Variable "검색변수" 재대입**:
    ```
    searchLat = #{지명검색결과정규화.lat}
    searchLng = #{지명검색결과정규화.lng}
    anchorLabel = #{지명검색결과정규화.name}
    ```
    → 18번으로.

### 13-6. 노드 18~29 — 후보변수 / 쿼리결정 / 4단계 카카오 폴백

`pipeline.js`의 4단계 폴백(키워드→카테고리→전국→주소)을 그대로 옮긴다. 11번 항목의
"키워드검색 0건 → 주소검색" 2단계 구조를 확장하는 개념.

**18. Variable "후보변수"** (신규):
```
candidates = [] (배열)
```
(배열 개수는 `count` 필드를 따로 안 두고, Condition 소스에서 바로 `length(#{candidates})`
같은 Function으로 구한다 — 13-2 참고. `candidates`를 소스로 골랐을 때 실제 함수 목록에
뜨는 이름으로 아래 `length` 자리를 바꿔 끼울 것.)

**19. Code "쿼리결정"** (신규):
```javascript
var intent = model["의도파싱"];
var search = model["검색변수"];

var CATEGORY_KEYWORDS = [
  ['FD6', ['맛집','밥집','식당','고깃집','고기집','국밥','냉면','분식','돈까스','파스타','이자카야','포차','중국집','일식집','백반','뷔페']],
  ['CE7', ['카페','커피','디저트','베이커리','빵집']],
  ['CS2', ['편의점']],
  ['PM9', ['약국']],
  ['SW8', ['지하철역','전철역']],
  ['PK6', ['주차장']],
  ['BK9', ['은행','atm','현금인출기']],
  ['OL7', ['주유소','충전소']],
  ['HP8', ['병원','의원','치과','한의원']],
  ['MT1', ['대형마트','이마트','홈플러스','롯데마트']],
  ['AD5', ['호텔','모텔','펜션','게스트하우스','리조트','숙소']],
  ['AT4', ['관광지','관광명소','전망대','유적지']],
  ['CT1', ['영화관','극장','미술관','박물관','공연장','전시관']],
  ['PO3', ['주민센터','구청','시청','동사무소','우체국','경찰서','소방서']],
  ['AC5', ['학원']],
  ['SC4', ['학교','초등학교','중학교','고등학교','대학교']],
  ['PS3', ['어린이집','유치원']],
  ['AG2', ['부동산','공인중개사']]
];

var query = intent.query;
// locationHint가 있거나 origin이 즐겨찾기로 해석됐으면, 원문 그대로 쓸 때 위치 참조 단어가
// 검색어에 섞여 들어간다("집주변 편의점"의 "집주변") — 빈 문자열로 둬서 카테고리 검색에 맡김.
if (!query) {
  query = (intent.locationHint || search.originResolved) ? '' : (model.parameter.body.text || '');
}
// query가 categoryGroupCode를 그대로 가리키는 일반명사면("편의점" 등) 카테고리 검색 우선.
if (query && intent.categoryGroupCode) {
  var entry = CATEGORY_KEYWORDS.find(function (e) { return e[0] === intent.categoryGroupCode; });
  if (entry && entry[1].indexOf(query.trim()) !== -1) query = '';
}
var searchRadius = intent.transportMode === 'car' ? 20000 : (model.parameter.body.chipRadius || 5000);

return { query: query, searchRadius: searchRadius };
```

**20. Condition "키워드검색분기"**: 소스 `#{쿼리결정.query}`, 연산자 `!=`, 값 (빈 문자열).
- YES → **카카오키워드검색메인**(Plugin-API, 키워드검색 재사용): `query =
  #{쿼리결정.query}`, `x = #{searchLng}`, `y = #{searchLat}`, `radius =
  #{쿼리결정.searchRadius}`, `sort = accuracy`, `category_group_code =
  #{의도파싱.categoryGroupCode}`.
  → **Code "키워드검색결과정규화"** (6번 항목 패턴 그대로):
  ```javascript
  var docs = model["카카오키워드검색메인"].documents || [];
  return docs.map(function (d, i) {
    var distanceM = parseInt(d.distance, 10) || 0;
    return {
      index: i + 1,
      name: d.place_name,
      address: d.road_address_name || d.address_name || '',
      category: d.category_group_name || (d.category_name || '').split(' > ').pop() || '',
      lat: parseFloat(d.y),
      lng: parseFloat(d.x),
      distanceM: distanceM,
      distanceLabel: distanceM < 1000 ? (distanceM + 'm') : ((distanceM / 1000).toFixed(1) + 'km'),
      phone: d.phone || '',
      placeUrl: d.place_url || ''
    };
  });
  ```
  → **Variable "후보변수" 재대입**: `candidates = #{키워드검색결과정규화}`
- NO → 그대로(빈 배열 유지) 23a번으로.

**23a. Condition "카테고리검색분기_비었음"**: 소스 `length(#{candidates})`, 연산자 `==`, 값
`0` — YES면 23b로, NO면 26a로.

**23b. Condition "카테고리검색분기_카테고리있음"** (23a YES 분기): 소스
`#{의도파싱.categoryGroupCode}`, 연산자 `!=`, 값 (빈 문자열) — YES면 카카오카테고리검색으로,
NO면 26a로.
- YES → **카카오카테고리검색**(Plugin-API, 5번 항목에서 이미 따로 등록해둔 카테고리검색
  API): `category_group_code = #{의도파싱.categoryGroupCode}`, `x = #{searchLng}`, `y =
  #{searchLat}`, `radius = #{쿼리결정.searchRadius}`, `sort = distance`.
  → **Code "카테고리검색결과정규화"** (위와 동일한 정규화 로직, `model["카카오카테고리검색"]`만 다름)
  → **Variable "후보변수" 재대입**: `candidates = #{카테고리검색결과정규화}`
  → 26a로.

**26a. Condition "전국검색분기_비었음"**: 소스 `length(#{candidates})`, 연산자 `==`, 값 `0`
— YES면 26b로, NO면 29로.

**26b. Condition "전국검색분기_쿼리있음"** (26a YES 분기): 소스 `#{쿼리결정.query}`, 연산자
`!=`, 값 (빈 문자열) — YES면 카카오키워드검색전국으로, NO면 29로.
- YES → **카카오키워드검색전국**(Plugin-API, 키워드검색 재사용): `query =
  #{쿼리결정.query}`, `x`/`y`/`radius`/`category_group_code`는 **비워둠**, `sort = accuracy`.
  → **Code "전국검색결과정규화"** (동일 정규화 로직, `model["카카오키워드검색전국"]`)
  → **Variable "후보변수" 재대입**: `candidates = #{전국검색결과정규화}`
  → 29로.

**29. Condition "주소검색분기"**: 소스 `length(#{candidates})`, 연산자 `==`, 값 `0`.
- YES → **Code "건물상세제거"** (11번 항목과 동일):
  ```javascript
  var s = (model.parameter.body.text || '').trim();
  var patterns = [/\s*(지하)?\d+\s*층$/, /\s*\d+\s*호$/, /\s*B\d+$/i, /\s*\d+\s*동$/];
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(s)) { s = s.replace(patterns[i], '').trim(); changed = true; }
    }
  }
  return { stripped: s };
  ```
  → **카카오주소검색**(Plugin-API, 주소검색): `query = #{건물상세제거.stripped}`.
  → **Code "주소검색결과정규화"**:
  ```javascript
  var docs = model["카카오주소검색"].documents || [];
  return docs.map(function (d, i) {
    var road = d.road_address;
    var addressName = (road && road.address_name) || d.address_name || '';
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
      placeUrl: ''
    };
  });
  ```
  → **Variable "후보변수" 재대입**: `candidates = #{주소검색결과정규화}`
- NO → 그대로 32번으로.

카카오 Plugin-API가 아직 3종(키워드/카테고리/주소) 다 없다면(11번 항목 기준으로는
키워드+주소만 있을 가능성) **카테고리검색 Plugin-API를 새로 등록**해야 함 — 5번 항목의
"category_group_code 빈 문자열이면 400" 문제 때문에 키워드검색과는 별도로 분리해야 했던
그 API.

### 13-7. 노드 32~37 — 큐레이션분기 / 큐레이션 / 최종 응답

후보가 있을 때만 두 번째 LLM 호출(`curateResults`)을 태운다 — 없으면 호출 자체를 건너뛰고
바로 응답(불필요한 LLM 호출 비용 절감, `pipeline.js`도 동일).

**32. Condition "큐레이션분기"**: 소스 `length(#{candidates})`, 연산자 `>`, 값 `0`.

**33. Code "후보목록축약"** (YES 분기, 신규 — Agent 프롬프트에 넣을 후보 요약):
```javascript
var candidates = model["후보변수"].candidates || [];
return candidates.map(function (c, i) {
  return { i: i, name: c.name, category: c.category, address: c.address, distance: c.distanceLabel };
});
```

**34. Agent "큐레이션"** System Prompt:
```
중요: 사용자 UI 언어는 한국어입니다. spoken, topPickReason 등 모든 자유 텍스트 출력 필드를 한국어로 작성하세요. (UI 언어가 english면 이 문단 대신 "IMPORTANT: ... English only"로 교체)

당신은 검색 결과 큐레이터입니다. 사용자의 필터/분위기/의도와 후보들의 카테고리/거리를 종합해 가장 맞는 곳을 추천하세요.
후보 데이터에는 이름/카테고리/주소/거리만 있고 평점·가격대·시설·서비스 품질 정보는 없습니다.
topPickReason/spoken에서 '고급스러운', '평점 높은', '분위기 좋은'처럼 확인 불가능한 사실을 지어내지 말고, 실제로 아는 정보(카테고리 일치, 거리, 이름)에만 근거해 이유를 말하세요.

아래 JSON 형식으로만 답하세요. 설명 문장이나 마크다운 코드블록 없이, 이 스키마의 순수 JSON 객체 하나만 출력하세요:
{
  "rankedIndices": [0, 1, 2],
  "topPickIndex": 0,
  "topPickReason": "string",
  "spoken": "string"
}
```

User Prompt:
```
# 원본 발화
"#{parameter.body.text}"

# 의도 필터
#{의도파싱.filters}

# 언어: #{parameter.body.lang}

# 후보 (0-based)
#{후보목록축약}
```

**35. Code "큐레이션파싱"**:
```javascript
var agent = model["큐레이션"];
var text = (agent.answer || '').replace(/```json/g, '').replace(/```/g, '').trim();
var args = {};
try { args = JSON.parse(text); } catch (e) { args = {}; }

var candidates = model["후보변수"].candidates || [];
var ranked = (args.rankedIndices || [])
  .map(function (i) { return candidates[i]; })
  .filter(Boolean)
  .map(function (c, newI) { return Object.assign({}, c, { index: newI + 1 }); });
var newTopIdx = (args.rankedIndices || []).indexOf(args.topPickIndex);

return {
  candidates: ranked.length ? ranked : candidates,
  spoken: args.spoken || model["의도파싱"].spoken || '',
  topPick: { index: newTopIdx >= 0 ? newTopIdx : 0, reason: args.topPickReason || '' }
};
```

**36. Result "최종응답큐레이션있음"** (34~35번 뒤, 플로우 종료):
```json
{
  "candidates": #{큐레이션파싱.candidates},
  "destination": "#{parameter.body.text}",
  "locationLabel": "#{anchorLabel}",
  "transportMode": "#{의도파싱.transportMode}",
  "spoken": "#{큐레이션파싱.spoken}",
  "topPick": #{큐레이션파싱.topPick},
  "clarification": ""
}
```

**37. Result "최종응답큐레이션없음"** (32번 NO, 플로우 종료):
```json
{
  "candidates": #{candidates},
  "destination": "#{parameter.body.text}",
  "locationLabel": "#{anchorLabel}",
  "transportMode": "#{의도파싱.transportMode}",
  "spoken": "#{의도파싱.spoken}",
  "topPick": null,
  "clarification": ""
}
```

`topPick`은 객체 또는 `null`이라 7번 항목 규칙대로 **따옴표 없이** 그대로 넣어야 함
(문자열이 아니므로).

### 13-8. 실전 예시 트레이스 4가지 (Simulation 입력값으로 바로 쓸 수 있음)

각 노드가 실제로 어떤 값을 받고 어떤 값을 내놓아야 하는지, 트리거 body부터 최종 Result까지
구체적인 JSON으로 끝까지 따라가본다. ActionFlow에서 각 액션아이템의 "TEST"/Simulation
입력값으로 그대로 붙여넣어서 중간 단계마다 실제 출력과 대조하는 용도로 쓸 것.

#### 예시 A — `locationHint` + `filters` + 큐레이션까지 전부 타는 케이스

**Trigger body**:
```json
{
  "text": "미사역 주변에 아이랑 갈만한 파스타집 찾아줘",
  "lat": 37.5665, "lng": 126.9780, "landmark": "",
  "transportMode": "transit", "categoryGroupCode": "",
  "inputType": "text", "chipRadius": 5000, "lang": "ko",
  "favorites": [
    { "alias": "집", "name": "래미안강남포레스트", "lat": 37.4979, "lng": 127.0276 },
    { "alias": "회사", "name": "우리금융 상암센터", "lat": 37.5793, "lng": 126.8912 }
  ],
  "recentSearches": []
}
```

**Agent "의도분석" 응답** (기대값):
```json
{
  "intent": "search", "query": "파스타", "categoryGroupCode": "FD6",
  "transportMode": "transit", "originHint": "현재위치", "locationHint": "미사역",
  "destinationFavoriteName": "", "filters": ["아이랑 갈만한"],
  "spoken": "", "clarification": ""
}
```

**4번 의도분기(Switch)**: `intent`가 `search`라 default 케이스 → 곧장 10번(검색변수)으로.

**11번 검색분기**: `originHint`="현재위치"라 NO → 14a번(location힌트분기_미해결)로.

**14a번**: `originResolved`=false(즉 `!= true`는 참) → YES → **14b번**:
`locationHint`="미사역"(비어있지 않음) → YES → 15번(즐겨찾기매칭location): "미사역"은
즐겨찾기에 없음 → `{matched:false}` → 16번 NO → 17번(카카오지명검색):

```
GET /v2/local/search/keyword.json?query=미사역&sort=accuracy&size=5
→ documents[0] = { "place_name": "미사역", "road_address_name": "경기 하남시 미사대로 지하 66",
                    "x": "127.194719", "y": "37.560597" }
```
→ 검색변수 재대입: `searchLat=37.560597, searchLng=127.194719, anchorLabel="미사역"`

**19번 쿼리결정**: `query="파스타"` — ⚠️ **"파스타"는 `CATEGORY_KEYWORDS`의 FD6 목록에 실제로
포함된 단어라** 카테고리 검색 우선 분기가 걸려 `query`가 빈 문자열로 바뀜(→ `candidates`도
아직 빈 배열) → **20번 키워드검색분기가 NO** → 23a번(카테고리검색분기_비었음,
`length(candidates)==0` 참) → 23b번(`categoryGroupCode`="FD6" 비어있지 않음 → YES) →
카카오카테고리검색으로 바로 감(이건
버그가 아니라 원본 `pipeline.js`와 동일한 동작 — "파스타" 하나만 딱 말하면 상호명 매칭보다
거리순 카테고리 검색이 더 정확한 결과를 준다고 판단한 설계).

**카카오카테고리검색**:
```
GET /v2/local/search/category.json?category_group_code=FD6&x=127.194719&y=37.560597&radius=5000&sort=distance&size=10
→ documents = [
    { "place_name": "미사 파스타하우스", "road_address_name": "경기 하남시 미사대로 520",
      "category_name": "음식점 > 양식 > 이탈리안", "x": "127.19510", "y": "37.55980",
      "distance": "420", "phone": "031-000-0000", "place_url": "http://place.map.kakao.com/111" },
    { "place_name": "강가에파스타", "road_address_name": "경기 하남시 미사강변대로 200",
      "category_name": "음식점 > 양식", "x": "127.19700", "y": "37.56200", "distance": "780" }
  ]
```

**정규화된 `candidates`**:
```json
[
  { "index": 1, "name": "미사 파스타하우스", "address": "경기 하남시 미사대로 520", "category": "이탈리안",
    "lat": 37.55980, "lng": 127.19510, "distanceM": 420, "distanceLabel": "420m",
    "phone": "031-000-0000", "placeUrl": "http://place.map.kakao.com/111" },
  { "index": 2, "name": "강가에파스타", "address": "경기 하남시 미사강변대로 200", "category": "양식",
    "lat": 37.56200, "lng": 127.19700, "distanceM": 780, "distanceLabel": "780m",
    "phone": "", "placeUrl": "" }
]
```

**32번 큐레이션분기**: `length(candidates) > 0`(2건) → YES → 34번 Agent "큐레이션" 응답(기대값):
```json
{
  "rankedIndices": [0, 1],
  "topPickIndex": 0,
  "topPickReason": "요청하신 파스타(이탈리안) 카테고리와 가장 가깝고, 미사역에서 420m로 이동이 편한 곳입니다.",
  "spoken": "미사역 근처에서 파스타집 두 곳을 찾았어요. 가장 가까운 미사 파스타하우스를 추천드려요."
}
```

**36번 최종응답큐레이션있음**:
```json
{
  "candidates": [ /* 위 candidates와 동일, index 1~2 유지 */ ],
  "destination": "미사역 주변에 아이랑 갈만한 파스타집 찾아줘",
  "locationLabel": "미사역",
  "transportMode": "transit",
  "spoken": "미사역 근처에서 파스타집 두 곳을 찾았어요. 가장 가까운 미사 파스타하우스를 추천드려요.",
  "topPick": { "index": 0, "reason": "요청하신 파스타(이탈리안) 카테고리와 가장 가깝고, 미사역에서 420m로 이동이 편한 곳입니다." },
  "clarification": ""
}
```

#### 예시 B — `originHint`가 즐겨찾기로 해석되는 케이스 ("집주변 편의점" 버그의 회귀 확인용)

이건 실제로 `e7cac3e`/`600f3ef`에서 고친 버그(집 근처 편의점을 찾는데 11km 떨어진 송파구
결과가 나옴)의 원인이었던 케이스라, ActionFlow 쪽을 만들 때 **반드시 이 트레이스대로
나오는지 확인**할 것.

**Trigger body**: 위 예시 A와 같은 `favorites`, `text: "집 근처 편의점"`.

**Agent "의도분석" 응답**:
```json
{
  "intent": "search", "query": "편의점", "categoryGroupCode": "CS2",
  "transportMode": "transit", "originHint": "집", "locationHint": "",
  "destinationFavoriteName": "", "filters": [], "spoken": "", "clarification": ""
}
```

**11번 검색분기**: `originHint`="집" != "현재위치" → YES → **12번 즐겨찾기매칭origin**: "집"이
즐겨찾기 alias와 정확히 일치 → `{matched:true, lat:37.4979, lng:127.0276, alias:"집"}` →
**13번 확인 YES** → 검색변수 재대입: `searchLat=37.4979, searchLng=127.0276,
anchorLabel="집", originResolved=true`. **카카오 API 호출 없이 즉시 확정됨.**

**19번 쿼리결정**: `query="편의점"` — CS2 목록이 `['편의점']` 딱 하나뿐이라 카테고리 검색
우선 분기가 걸려 `query=""` → 20번 NO → 23a번(`length(candidates)==0` 참) →
23b번(`categoryGroupCode`="CS2" 비어있지 않음 → YES) → 카카오카테고리검색으로. **여기서
`searchLat`/
`searchLng`가 집 좌표(37.4979, 127.0276)를 쓰는지가 핵심** — 만약 12번 Code가 매칭에
실패하거나 13번 Condition의 `matched` 비교가 잘못돼 있으면, `searchLat/Lng`가 검색변수의
초기값(트리거 GPS 좌표 37.5665, 126.9780 — 서울시청 부근)으로 남아서 엉뚱하게 먼 편의점이
나온다 — 바로 이게 원래 있었던 버그다.

**카카오 카테고리검색**: `x=127.0276, y=37.4979, radius=5000, category_group_code=CS2, sort=distance`
→ 집(강남) 근처 편의점들이 거리순으로 나와야 정상.

#### 예시 C — `navigate_favorite` (즐겨찾기 자체가 목적지)

**Trigger body**: `text: "회사로 가자"`, 위와 동일한 `favorites`.

**Agent "의도분석" 응답**:
```json
{
  "intent": "navigate_favorite", "query": "", "categoryGroupCode": "",
  "transportMode": "transit", "originHint": "현재위치", "locationHint": "",
  "destinationFavoriteName": "회사", "filters": [],
  "spoken": "회사로 안내해 드릴게요.", "clarification": ""
}
```

**4번 의도분기(Switch)**(`intent`=="navigate_favorite" → 그 case로 바로) → **5번
즐겨찾기매칭destination**: "회사" 매칭됨
(`{matched:true, name:"우리금융 상암센터", alias:"회사", lat:37.5793, lng:126.8912}`) →
**6번 확인 YES** → **카카오 호출도 큐레이션도 없이 즉시 7번 Result**:
```json
{
  "candidates": [
    { "index": 1, "name": "우리금융 상암센터", "address": "", "category": "",
      "lat": 37.5793, "lng": 126.8912, "distanceM": 0, "distanceLabel": "", "phone": "", "placeUrl": "" }
  ],
  "destination": "회사", "transportMode": "transit",
  "spoken": "회사로 안내해 드릴게요.", "topPick": { "index": 0, "reason": "" }, "clarification": ""
}
```
(`address`/`category`가 빈 문자열인 것도 `pipeline.js`와 동일 — 즐겨찾기 데이터 자체에
주소/카테고리를 안 들고 있어서 원래 그럼.)

#### 예시 D — `ambiguous` (되묻기)

**Trigger body**: `text: "거기 다시 찾아줘"` (최근 검색 이력도 비어있는 상황 — `recentSearches: []`).

**Agent "의도분석" 응답**:
```json
{
  "intent": "ambiguous", "query": "", "categoryGroupCode": "",
  "transportMode": "transit", "originHint": "현재위치", "locationHint": "",
  "destinationFavoriteName": "", "filters": [],
  "spoken": "", "clarification": "어디를 다시 찾아드릴까요?"
}
```

**4번 의도분기(Switch)**(`intent`=="ambiguous" → 그 case로 바로, `clarification`은 3번
`의도파싱`에서 이미 있는 게 확인된 상태) **→ 카카오 호출도 큐레이션도 없이 즉시
9번 Result**:
```json
{
  "candidates": [], "destination": "", "transportMode": "transit",
  "spoken": "어디를 다시 찾아드릴까요?", "topPick": null, "clarification": "어디를 다시 찾아드릴까요?"
}
```
(`spoken`은 `intent.clarification`을 그대로 씀 — `pipeline.js`에서 `intent.spoken ||
intent.clarification` 로직과 동일한 결과. `spoken`이 비어있으면 `clarification` 문구를
그대로 음성 안내에도 씀.)

### 13-9. 만들면서 확인할 것 (체크리스트)

1. Agent 노드가 진짜 순수 JSON만 주는지, 아니면 매번 마크다운 코드블록/사족이 붙는지
   (붙으면 코드블록 제거 정규식이 이미 대응하지만, 사족 문장까지 섞이면 정규식으로는
   못 걷어내므로 프롬프트를 더 강하게 다듬어야 함 — 예: "반드시 `{`로 시작해서 `}`로 끝나야
   한다"처럼 더 명시적으로).
2. `{matched: boolean}` 패턴의 Condition 비교(`#{노드.matched} == true`)가 실제로 잘
   동작하는지 — 검색변수의 `originResolved`는 Variable의 네이티브 불리언 타입으로 확인됐지만
   (스크린샷), Code 노드가 return하는 일반 객체의 `matched` 필드(Variable이 아님)도 똑같이
   Condition에서 `true`/`false` 리터럴로 비교되는지는 아직 실제로 안 찍어봄 — 5/6/13/16번
   Condition을 만들 때 확인.
3. Condition의 "값" 칸에 문자열 리터럴(`navigate_favorite`, `현재위치` 등)을 따옴표 없이
   그냥 타이핑하면 되는지(스크린샷의 검색분기가 `!=` 연산자만 보여줘서 "값" 칸 실제 모습은
   아직 안 봄) — 빈 문자열(`""`)을 "값" 칸에 넣는 방법(빈 칸으로 두면 되는지, 따옴표
   두 개를 타이핑해야 하는지)도 확인 필요.
4. 카테고리검색 Plugin-API가 아직 없다면 새로 등록(5번 항목 참고, `category_group_code` 필수
   파라미터로).
5. `findFavorite`/`isGenericCategoryTerm`/`stripBuildingDetail`을 Code 노드로 옮길 때 원본
   함수(`pipeline.js`)와 완전히 같은 로직인지 대조 — 미묘하게 다르면 "그 버그"(originHint가
   즐겨찾기로 해석됐는데 query에 원문이 남는 것 등, e7cac3e/600f3ef에서 고친 것들)가 ActionFlow
   쪽에서 재발할 수 있음.
6. 12번 항목의 레이스 컨디션 이슈 — 이 플로우도 Variable을 많이 쓰므로, 프론트엔드가 검색을
   병렬로 여러 번 동시 호출하지 않는지 확인(오늘 탭의 일정 위치 확인은 이미 순차 처리로
   고쳐져 있음, `c56ba55`).
7. ~~4번 Switch에 default 케이스가 있는지~~ → **확인됨**: 있음, 나열한 case 중 어느 것도
   해당 안 되면 타는 케이스. 3-way 분기(navigate_favorite/ambiguous/default) 그대로 진행.

## 14. Sub-flow로 공통 로직 재사용 (제안 — 트리거 타입 제약 확인됨, 아직 안 만들어봄)

Sub-flow 노드로 기존 플로우를 호출할 수 있다는 걸 확인했으므로, `chip`/`locate`/`text`
세 분기가 각자 중복해서 만들 뻔한 로직을 하나로 뽑아 재사용할 수 있다. 특히 13-6(카카오
검색 폴백 체인)은 `chip`/`locate`가 이미 만든 "키워드검색 → (0건이면) 주소검색"(11번 항목)
구조와 사실상 같은 뼈대라, 처음부터 다시 만들기보다 **기존 검색 플로우의 핵심 로직을
Sub-flow로 분리하고, `chip`/`locate`/`text` 세 플로우가 전부 그걸 호출**하는 편이 유지보수가
쉽다(카카오 API 파라미터가 바뀌면 한 곳만 고치면 됨).

⚠️ **확인됨: Sub-flow 노드는 아무 플로우나 호출하지 못하고, 호출 대상 플로우의 트리거
타입이 정해져 있다** — 즉 지금 `text`/`chip`/`locate`가 쓰는 **API Trigger로 만든 플로우는
그대로 Sub-flow로 호출 대상이 안 될 수 있다.** 아래 3개 제안은 그 특정 트리거 타입(아마
"Sub-flow Trigger" 같은 전용 타입)으로 별도 플로우를 새로 만들어야 적용 가능 — 정확히 어떤
트리거 타입이 Sub-flow 호출 대상이 되는지 확인 필요(15번 질문 참고). 확인되기 전까지는
아래 설계를 참고만 하고 실제로 만들지는 말 것.

**제안하는 Sub-flow 3개와 입출력 계약**:

1. **"카카오검색체인" Sub-flow** — 13-6 전체(키워드→카테고리→전국→주소 폴백)를 감싼다.
   - 입력: `{ query, categoryGroupCode, lat, lng, radius, originalTextForAddressFallback }`
     (`chip`/`locate`는 `categoryGroupCode`를 트리거에서 그대로, `text`는 `의도파싱` 결과에서
     가져와 이 값들로 채워서 호출)
   - 출력: `{ candidates: Candidate[] }` (13-6에서 정의한 정규화 형태 그대로)
   - `locate`는 반경 제한이 없다는 차이가 있으니, `radius`를 `null`/빈 값으로 넘기면 그
     단계를 건너뛰는 분기가 Sub-flow 안에 이미 있어야 함(지금 `locate` 플로우에 있는 로직을
     그대로 Sub-flow 쪽으로 옮기는 방식이 될 것).
2. **"즐겨찾기매칭" Sub-flow** — 13-5의 `findFavorite`(13-4/13-5에서 반복되는 그 Code 로직).
   - 입력: `{ favorites, hint }`
   - 출력: `{ matched: boolean, name, alias, lat, lng }`
3. **"지명좌표확인" Sub-flow** — `resolveNamedLocation`(13-5의 17번, locationHint를 좌표로).
   - 입력: `{ hint }`
   - 출력: `{ matched: boolean, lat, lng, name }`

**단, 지금 당장 리팩터링하지 말고 순서 제안**: 이미 동작 중인 `chip`/`locate` 플로우를
건드리는 건 위험 부담이 있으니, ① 먼저 `text` 분기를 지금 설계(13-2~13-8)대로 **독립적으로**
새로 만들어서 끝까지 동작시키고, ② Sub-flow 호출 대상 트리거 타입을 확인한 뒤, ③ 그 다음에
`chip`/`locate`가 쓰는 카카오 폴백 로직을 "카카오검색체인" Sub-flow로 뽑아내면서 `text`도
거기 맞춰 리팩터링하는 순서를 권장. 처음부터 세 플로우를 동시에 Sub-flow 공유 구조로
만들면, 문제가 생겼을 때 그게 Sub-flow 자체 문제인지 호출부 문제인지 구분하기가 더 어려움.

## 15. 확인이 필요한 질문 (다음에 답 주시면 위 설계를 확정)

**해결됨** (스크린샷으로 확인, 감사합니다):
- Agent 노드 System/User Prompt에 `#{parameter.body.x}` Smart Component가 정상적으로
  먹힌다(프롬프트 칸에 파란 태그로 삽입되는 걸 확인) — 13-3의 User Prompt 설계 그대로 유효.
- `favorites`/`recentSearches` 같은 배열도 Agent 프롬프트에 잘 들어가는 것으로 보임(직접
  로그로 100% 확인은 아니지만 문제 없어 보임).
- 이 플랫폼에 **네이티브 불리언(Boolean) 타입이 실제로 있음**(Variable 타입 선택지에
  문자열/숫자/**불리언**/객체/배열) — `originResolved`는 그냥 불리언 타입으로 선언하면 됨.
- **Condition 노드는 "소스/연산자/값" 구조의 단일 비교만 가능** — `&&`/`||`로 여러 조건을
  한 노드에 합칠 수 없다(연산자 목록: `>`, `<`, `>=`, `<=`, `==`, `!=`, `equals`,
  `contains`). 13-2~13-7을 전부 이 구조에 맞게 다시 설계했다(compound 조건은 Condition
  노드 체인으로 분리하거나 Code에서 미리 정리).
- **Switch 노드에 default(그 외 전부를 받는) 케이스가 있음** — 4번 "의도분기"를
  navigate_favorite/ambiguous/default 3-way로 설계.
- **Smart Component 소스 칸에서 내장 Function(fx 패널)을 쓸 수 있음** — String 카테고리에
  `length`/`substring`/`indexOf`/`contains`/`trim`/... 등, Math 카테고리에
  `add`/`sum`/`round`/... 등 확인됨. 이 덕분에 배열 개수 비교를 위해 Code 노드가 `count`를
  따로 계산해서 반환하던 워크어라운드를 걷어내고, `length(#{candidates})`처럼 Condition
  소스에서 바로 처리하도록 13-6/13-7을 다시 단순화했다.

**아직 남은 것**:
1. Condition의 "값" 칸에 문자열 리터럴(예: `navigate_favorite`)을 따옴표 없이 그냥
   타이핑하는 게 맞는지, 빈 문자열(`""`) 비교는 "값" 칸을 비워두면 되는지 — 이번 스크린샷은
   연산자 선택 드롭다운까지만 보여서 "값" 입력 칸의 실제 모습은 아직 못 봄.
2. Code 노드가 return하는 일반 객체(Variable이 아닌)의 boolean 필드(예:
   `{matched: true}`)도 Condition에서 `true` 리터럴과 정상 비교되는지 — Variable의 네이티브
   불리언과 Code 노드의 JS boolean이 이 플랫폼에서 같은 취급을 받는지는 아직 실제로 확인 전.
3. **`candidates`(배열/ListData 타입)를 Condition 소스로 골랐을 때 fx 패널에 정확히 어떤
   함수가 뜨는가** — 스크린샷은 String 타입 필드(`originHint`) 기준이라 String/Math
   카테고리만 봤음. 배열을 고르면 "List"/"Array" 같은 별도 카테고리가 뜨고 그 안에
   `length`가 아닌 다른 이름(`size`, `count` 등)일 수 있음 — 23a/26a/29/32의 `length(...)`
   자리를 실제 이름으로 바꿔 끼울 것.
4. **Sub-flow 노드가 호출할 수 있는 트리거 타입이 정확히 무엇인가?** — API Trigger로 만든
   플로우도 되는지, 아니면 전용 트리거 타입으로 새로 만들어야 하는지. 입출력 계약이
   API Trigger 호출(Plugin-API처럼 동기적으로 끝나고 `#{서브플로우 이름.필드}`로 결과
   참조)과 동일한 모양인지도 같이 확인되면 좋음. 14번 항목의 Sub-flow 분리 제안이 이 답에
   따라 구체적인 모양이 달라짐.
