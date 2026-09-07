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
| Result/End 노드의 JSON 템플릿에서 상위 노드 결과 참조 | `#{아이템 이름.경로.경로}` (dot notation) | `#{KAKAO MAP.meta.same_name.keyword}` |

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
- 선언 이후엔 `#{필드명}`으로 플로우 어디서든 바로 참조 가능(예: `#{candidates}`,
  `#{radius}`) — Code 노드 이름이나 다른 접두사 없이 그냥 변수 이름만 쓴다.
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

## 13. `text` 자연어 검색 — 전체 LLM 의도분석(`resolveIntent`) 플로우 설계

지금까지 검색 플로우는 `chip`/`locate`(`skipLLM=true`, LLM 없이 카카오 검색만)만 만들어져
있었다. 남은 건 `text` 분기 — `server/src/pipeline.js`의 `resolveIntent()` +
원점(origin/location) 해석 + 카카오 폴백 체인 + `curateResults()` 전체를 ActionFlow로
옮기는 것. 이 절은 그 설계를 정리한다 (실제 노드는 아직 안 만들어봤으므로, 만들면서
겪는 실제 함정은 이 절 아래에 계속 추가할 것).

### 13-1. ✅ 확인됨: Code 노드에서 트리거 body 필드 접근법 + 실제 요청 본문 스키마

**Code 노드**에서는 `model.parameter.body.필드명`으로 트리거 body를 바로 읽을 수 있다
(예: `var q = model.parameter.body.text;`). 2번 항목의 Smart Component 문법표에 있는
`#{parameter.body.필드명}`(Plugin-API 파라미터/Result JSON 템플릿용)과는 문법만 다를 뿐
같은 데이터를 가리킨다 — Code 노드 안에서는 `#{}` 없이 `model.parameter.body.x`로 바로
JS 값처럼 쓰면 된다. 13-1이 막혀서 만들었던 "Variable 우회" 아이디어는 필요 없다.

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
없는 필드를 읽으면 `undefined`가 아니라 에러가 날 수도 있으니 방어적으로).
`recentSearches[].code`는 그 검색 당시의 `categoryGroupCode`를 기록해둔 것(있으면).

### 13-2. 전체 플로우 구조

```
Trigger (parameter.body: text/lat/lng/landmark/transportMode/categoryGroupCode/
         inputType/chipRadius/lang/favorites[]/recentSearches[])
 └ Agent "의도분석" (LLM, 13-3 프롬프트 — System/User 프롬프트만 있고 함수 호출은 없음) — 발화 → JSON 텍스트(`.answer`)
 └ Code "의도파싱" (13-4) — 코드블록 벗기고 JSON.parse + 기본값 채우기 + 카테고리 키워드 보정
 └ Condition A: #{의도파싱.intent} == "navigate_favorite" && #{의도파싱.destinationFavoriteName} != ""
    ├ 참: Code "즐겨찾기매칭"(alias/name로 찾기)
    │      └ Condition A2: 매칭됨?
    │         ├ 참: Result① { candidates:[그 즐겨찾기 좌표 1건], destination, transportMode,
    │         │              spoken: #{의도파싱.spoken}, topPick:{index:0,reason:""}, clarification:"" }
    │         └ 거짓: (아래 "검색 분기"로 합류 — 그대로 진행)
    └ 거짓: (아래로 진행)
 └ Condition B: #{의도파싱.intent} == "ambiguous" && #{의도파싱.clarification} != ""
    ├ 참: Result② { candidates:[], destination:"", transportMode, spoken:#{의도파싱.clarification 우선},
    │              topPick:null, clarification:#{의도파싱.clarification} }
    └ 거짓: "검색 분기" 진입
 └ [검색 분기] 13-5(원점 해석) → 13-6(카카오 폴백 체인) → 13-7(큐레이션 Agent) → Result③(최종)
```

**주의**: `pipeline.js`에서는 `navigate_favorite`인데 즐겨찾기 매칭에 실패하거나
`ambiguous`인데 `clarification`이 비어있으면 **그냥 검색 분기로 자연스럽게 흘러간다**
(별도 에러 처리 없음) — ActionFlow에서도 Condition의 "거짓" 쪽이 전부 같은 검색 분기로
합류하게 만들어야 원본과 동작이 같아진다.

### 13-3. Agent "의도분석" 프롬프트

**확인됨: Agent 노드에 함수 호출(tool use)은 없고 System Prompt/User Prompt 두 칸뿐이다**
(이전 판에서 tool use가 있다고 잘못 짚었던 부분 — 취소). 즉 6번 항목에서 이미 확인된
대로 결과는 텍스트(`.answer`)로 오고, 마크다운 코드블록으로 감싸진 JSON일 수 있다.
그래서 원래 설계대로 **System Prompt에서 순수 JSON 출력을 강하게 지시**하는 방식으로
간다.

**System Prompt** (`pipeline.js`의 `resolveIntent` 시스템 프롬프트 + 출력 형식 지시):

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

**User Prompt** (Smart Component로 트리거 값 바인딩 — 문법은 13-1 참고, 이건 Code 노드가
아니라 Agent 노드 입력 폼이므로 `#{parameter.body.필드명}`):

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
치환했을 때 `[object Object]`로 깨지는지 아니면 JSON 문자열(`[{"name":"..."}]`)로 잘
치환되는지 확인 필요(15번 항목 질문). 깨지면 Agent 앞에 Code 노드를 하나 두고
`JSON.stringify(model.parameter.body.favorites)`로 미리 문자열을 만들어(13-1 접근법 확인됐으니
이제 이 자체는 쉬움) 그 Code 노드 결과를 Agent 프롬프트에 넣는 방식으로 바꾸면 됨.

### 13-4. Code "의도파싱"

6번 항목에서 이미 확인된 패턴 그대로 — Agent 결과는 `.answer`에 텍스트로 오고, 마크다운
코드블록으로 감싸져 올 수 있다.

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

return intent; // 순수 객체 — 6번 항목의 "Can not parse json result" 함정 주의
```

### 13-5. 원점(origin/location) 해석 — `searchLat`/`searchLng`/`anchorLabel`

`pipeline.js`의 originHint → 즐겨찾기 매칭 → (실패시) locationHint → 즐겨찾기 매칭 →
(실패시) 카카오 지명 검색, 순서를 그대로 옮긴다. 새 카카오 API 호출이 필요한 건
**locationHint를 좌표로 바꾸는 지명 검색 하나뿐**(`resolveNamedLocation` — 반경 제한 없이
정확도순 키워드검색, `locate` 분기에서 쓰는 것과 같은 카카오 키워드검색 Plugin-API를
그대로 재사용 가능). 즐겨찾기 매칭(`findFavorite`)은 외부 호출이 아니라 순수 계산이라
Code 노드로 충분하다.

```
Variable 선언: searchLat=parameter.body.lat, searchLng=parameter.body.lng, anchorLabel='', originResolved=false
Condition: #{의도파싱.originHint} != "현재위치" && #{의도파싱.originHint} != ""
 ├ 참: Code "즐겨찾기매칭(origin)" — favorites에서 alias/name이 originHint로 시작하는 항목 탐색
 │      └ Condition: 매칭됨?
 │         ├ 참: Variable 재대입 — searchLat/searchLng/anchorLabel=매칭된 즐겨찾기 값, originResolved=true
 │         └ 거짓: (그대로 유지, 로그만)
 └ 거짓: (그대로 유지)
Condition: !originResolved && #{의도파싱.locationHint} != ""
 ├ 참: Code "즐겨찾기매칭(location)" — 위와 동일 로직을 locationHint로
 │      └ Condition: 매칭됨?
 │         ├ 참: Variable 재대입 — searchLat/searchLng/anchorLabel=매칭된 즐겨찾기 값
 │         └ 거짓: 카카오 키워드검색(locationHint, 반경없음, accuracy) → Condition(결과 0건?)
 │                  ├ 거짓: Variable 재대입 — searchLat/searchLng=1번째 결과 좌표, anchorLabel=그 place_name
 │                  └ 참: (그대로 유지 — 현재 GPS로 자연스럽게 폴백)
 └ 거짓: (그대로 유지)
```

`findFavorite`는 `server/src/pipeline.js`의 버전(부분일치: `clean.startsWith(f.alias)`)을
그대로 옮기면 됨 — `pipeline-client.js` 버전(`indexOf === 0`)과 동치. Code 노드 구현:

```javascript
// "즐겨찾기매칭(origin)" — locationHint 매칭용도 hint 값만 바꿔서 그대로 재사용
var favorites = model.parameter.body.favorites || [];
var hint = (model["의도파싱"].originHint || '').trim(); // location 매칭이면 .locationHint
var match = favorites.find(function (f) {
  return (f.alias && (f.alias === hint || hint.indexOf(f.alias) === 0)) ||
         (f.name && (f.name === hint || hint.indexOf(f.name) === 0));
});
return match || null; // 매칭 안 되면 null — 이어지는 Condition에서 null 체크
```

### 13-6. 카카오 검색 폴백 체인 — `candidates`

`pipeline.js`의 4단계 폴백(키워드→카테고리→전국→주소)을 그대로 옮긴다. 11번 항목에 이미
만들어둔 "키워드검색 0건 → 주소검색" 2단계 구조를 확장하는 개념.

```
Code "쿼리결정" — query = 의도파싱.query, 단 (locationHint 있음 || originResolved)면 빈 문자열
                  그리고 isGenericCategoryTerm(query, categoryGroupCode)면(= CATEGORY_KEYWORDS 값과
                  완전히 같은 일반명사) 빈 문자열로. searchRadius = transportMode=='car' ? 20000 : chipRadius.
Condition: #{쿼리결정.query} != ""
 ├ 참: 카카오 키워드검색(query, x=searchLng, y=searchLat, radius=searchRadius, sort=accuracy,
 │              category_group_code=categoryGroupCode) → Variable candidates 대입(Code로 정규화 후)
 └ 거짓: (candidates는 빈 배열 그대로)
Condition: #{candidates}.length == 0 && categoryGroupCode != ""
 └ 참: 카카오 카테고리검색(category_group_code, x, y, radius, sort=distance) → Variable candidates 재대입
Condition: #{candidates}.length == 0 && #{쿼리결정.query} != ""
 └ 참: 카카오 키워드검색(query, 반경/좌표 없이 sort=accuracy) → Variable candidates 재대입   ← "전국 검색"
Condition: #{candidates}.length == 0
 └ 참: Code(건물상세정보 제거, 11번 항목과 동일) → 카카오 주소검색 → Variable candidates 재대입(주소결과 정규화)
```

카카오 Plugin-API를 이미 3종(키워드/카테고리/주소) 만들어뒀다면(11번 항목 기준으로는
키워드+주소만 있을 가능성) **카테고리검색 Plugin-API가 새로 필요**하다 — 5번 항목의
"category_group_code 빈 문자열이면 400" 문제 때문에 키워드검색 Plugin-API와는 별도로
분리해야 했던 그 API. `#{parameter.body.categoryGroupCode}`가 아니라 `의도파싱.categoryGroupCode`를
바인딩해야 하는 점에 주의(즉 지금 값은 트리거가 아니라 Agent 결과에서 옴).

### 13-7. Agent "큐레이션" + Result

후보가 있을 때만 두 번째 LLM 호출(`curateResults`)을 태운다 — `candidates.length==0`이면
호출 자체를 건너뛰고 바로 Result로 감(불필요한 LLM 호출 비용 절감, `pipeline.js`도 동일).

**Agent "큐레이션" System Prompt** (`pipeline.js`의 `curateResults` 시스템 프롬프트 +
출력 형식 지시 — 13-3과 같은 이유로 함수 호출이 아니라 텍스트 JSON 강제 방식):

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

**User Prompt**:
```
# 원본 발화
"#{parameter.body.text}"

# 의도 필터
#{의도파싱.filters}

# 언어: #{parameter.body.lang}

# 후보 (0-based)
#{후보JSON목록}
```
`후보 목록`은 `candidates`를 `{i, name, category, address, distance}`로 축약한 배열이어야
함(`pipeline.js`와 동일) — Code 노드로 `candidates.map(function(c,i){return {i:i, name:c.name,
category:c.category, address:c.address, distance:c.distanceLabel};})`를 만들어서 Agent 프롬프트
앞에 하나 더 두면 됨.

```
Condition: #{candidates}.length > 0
 ├ 참: Agent "큐레이션" (위 프롬프트) → Code "큐레이션파싱" (아래 코드)
 └ 거짓: (curated = candidates 그대로, spoken = 의도파싱.spoken, topPick = null)
Result: {
  "candidates": #{최종candidates},
  "destination": "#{parameter.body.text}",
  "locationLabel": "#{anchorLabel}",
  "transportMode": "#{의도파싱.transportMode}",
  "spoken": "#{최종spoken}",
  "topPick": #{최종topPick},
  "clarification": ""
}
```

**Code "큐레이션파싱"** — 13-4와 같은 방식(코드블록 벗기고 JSON.parse)으로 꺼낸 뒤,
`rankedIndices`로 `candidates` 재정렬 + `topPickIndex`의 재정렬 후 새 인덱스 계산
(`pipeline.js`의 `curateResults` 로직 그대로):

```javascript
var agent = model["큐레이션"];
var text = (agent.answer || '').replace(/```json/g, '').replace(/```/g, '').trim();
var args = {};
try { args = JSON.parse(text); } catch (e) { args = {}; }
var candidates = model["candidates 대입한 Variable/Code"]; // 13-6 결과
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

**원점 해석**: `originHint`="현재위치"라 origin 매칭 skip(`originResolved=false`). `locationHint`="미사역"이
즐겨찾기엔 없으므로 카카오 키워드검색(반경 없음, `accuracy`)으로 지명 좌표 확인:

```
GET /v2/local/search/keyword.json?query=미사역&sort=accuracy&size=5
→ documents[0] = { "place_name": "미사역", "road_address_name": "경기 하남시 미사대로 지하 66",
                    "x": "127.194719", "y": "37.560597" }
```
→ `searchLat=37.560597, searchLng=127.194719, anchorLabel="미사역"`

**쿼리결정**: `query="파스타"` — ⚠️ **"파스타"는 `CATEGORY_KEYWORDS`의 FD6 목록에 실제로 포함된
단어라 `isGenericCategoryTerm`이 `true`를 반환** → `query`가 빈 문자열로 바뀌어 **키워드검색을
건너뛰고 바로 카테고리검색으로 감**(이건 버그가 아니라 원본 `pipeline.js`와 동일한 동작 —
"파스타" 하나만 딱 말하면 상호명 매칭보다 거리순 카테고리 검색이 더 정확한 결과를 준다고
판단한 설계. ActionFlow 쪽 결과가 이거랑 다르게 나오면 `CATEGORY_KEYWORDS` 목록이 Agent
프롬프트/Code 노드 사이에서 최신 상태로 안 맞는 것부터 의심).

**카카오 카테고리검색**:
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

**Agent "큐레이션" 응답** (기대값):
```json
{
  "rankedIndices": [0, 1],
  "topPickIndex": 0,
  "topPickReason": "요청하신 파스타(이탈리안) 카테고리와 가장 가깝고, 미사역에서 420m로 이동이 편한 곳입니다.",
  "spoken": "미사역 근처에서 파스타집 두 곳을 찾았어요. 가장 가까운 미사 파스타하우스를 추천드려요."
}
```

**최종 Result**:
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

**원점 해석**: `originHint`="집"이 즐겨찾기 alias와 정확히 일치 → **카카오 API 호출 없이 즉시**
`searchLat=37.4979, searchLng=127.0276, anchorLabel="집", originResolved=true`.

**쿼리결정**: `query="편의점"` — CS2 목록이 `['편의점']` 딱 하나뿐이라 `isGenericCategoryTerm`이
`true` → `query=""` → 키워드검색 건너뛰고 바로 카테고리검색. **여기서 `searchLat`/`searchLng`가
집 좌표(37.4979, 127.0276)를 쓰는지가 핵심** — 만약 Agent가 `originHint`를 빈 문자열로
잘못 내놓거나(즐겨찾기 대신 `locationHint`에 "집"을 넣는 경우가 실제로 있었음 — 13-5의
"즐겨찾기매칭(location)" 폴백이 바로 이걸 잡는 안전망), 즐겨찾기 매칭 Code 노드가 실패하면
`searchLat/Lng`가 트리거의 GPS 좌표(37.5665, 126.9780 — 서울시청 부근)로 남아서 엉뚱하게
먼 편의점이 나온다.

**카카오 카테고리검색**: `x=127.0276, y=37.4979, radius=5000, category_group_code=CS2, sort=distance`
→ 집(강남) 근처 편의점들이 거리순으로 나와야 정상. (`x=126.9780, y=37.5665`로 나가면 시청 근처
결과가 나오는 것이므로 이게 바로 그 버그 재현.)

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

**Condition A** 참 → 즐겨찾기매칭("회사") → 매칭됨(alias="회사") → **카카오 호출도 큐레이션도
없이 즉시 Result①**:
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
주소/카테고리를 안 들고 있어서 원래 그럼. 프론트가 별도로 채우는 게 아니라면 정상.)

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

**Condition B** 참 → 카카오 호출도 큐레이션도 없이 즉시 Result②:
```json
{
  "candidates": [], "destination": "", "transportMode": "transit",
  "spoken": "어디를 다시 찾아드릴까요?", "topPick": null, "clarification": "어디를 다시 찾아드릴까요?"
}
```
(`spoken`은 `intent.spoken || intent.clarification` — `spoken`이 비어있으면 `clarification`
문구를 그대로 음성 안내에도 씀. 두 필드에 같은 문구가 중복돼 보여도 정상.)

### 13-9. 만들면서 확인할 것 (체크리스트)

1. Agent 노드가 진짜 순수 JSON만 주는지, 아니면 매번 마크다운 코드블록/사족이 붙는지
   (붙으면 13-4/13-7의 코드블록 제거 정규식이 이미 대응하지만, 사족 문장까지 섞이면 정규식으로는
   못 걷어내므로 프롬프트를 더 강하게 다듬어야 함 — 예: "반드시 `{`로 시작해서 `}`로 끝나야
   한다"처럼 더 명시적으로).
2. 카테고리검색 Plugin-API가 아직 없다면 새로 등록(5번 항목 참고, `category_group_code` 필수
   파라미터로).
3. `findFavorite`/`isGenericCategoryTerm`/`stripBuildingDetail`을 Code 노드로 옮길 때 원본
   함수(`pipeline.js`)와 완전히 같은 로직인지 대조 — 미묘하게 다르면 "그 버그"(originHint가
   즐겨찾기로 해석됐는데 query에 원문이 남는 것 등, e7cac3e/600f3ef에서 고친 것들)가 ActionFlow
   쪽에서 재발할 수 있음.
4. 12번 항목의 레이스 컨디션 이슈 — 이 플로우도 Variable을 많이 쓰므로, 프론트엔드가 검색을
   병렬로 여러 번 동시 호출하지 않는지 확인(오늘 탭의 일정 위치 확인은 이미 순차 처리로
   고쳐져 있음, `c56ba55`).

## 14. Sub-flow로 공통 로직 재사용 (제안 — 아직 안 만들어봄)

Sub-flow 노드로 기존 플로우를 호출할 수 있다는 걸 확인했으므로, `chip`/`locate`/`text`
세 분기가 각자 중복해서 만들 뻔한 로직을 하나로 뽑아 재사용할 수 있다. 특히 13-6(카카오
검색 폴백 체인)은 `chip`/`locate`가 이미 만든 "키워드검색 → (0건이면) 주소검색"(11번 항목)
구조와 사실상 같은 뼈대라, 처음부터 다시 만들기보다 **기존 검색 플로우의 핵심 로직을
Sub-flow로 분리하고, `chip`/`locate`/`text` 세 플로우가 전부 그걸 호출**하는 편이 유지보수가
쉽다(카카오 API 파라미터가 바뀌면 한 곳만 고치면 됨).

**제안하는 Sub-flow 3개와 입출력 계약**:

1. **"카카오검색체인" Sub-flow** — 13-6 전체(키워드→카테고리→전국→주소 폴백)를 감싼다.
   - 입력: `{ query, categoryGroupCode, lat, lng, radius, originalTextForAddressFallback }`
     (`chip`/`locate`는 `categoryGroupCode`를 트리거에서 그대로, `text`는 `의도파싱` 결과에서
     가져와 이 값들로 채워서 호출)
   - 출력: `{ candidates: Candidate[] }` (13-6에서 정의한 정규화 형태 그대로)
   - `locate`는 반경 제한이 없다는 차이가 있으니, `radius`를 `null`/빈 값으로 넘기면 그
     단계를 건너뛰는 분기가 Sub-flow 안에 이미 있어야 함(지금 `locate` 플로우에 있는 로직을
     그대로 Sub-flow 쪽으로 옮기는 방식이 될 것).
2. **"즐겨찾기매칭" Sub-flow** — 13-5의 `findFavorite`.
   - 입력: `{ favorites, hint }`
   - 출력: 매칭된 즐겨찾기 객체 또는 `null`
3. **"지명좌표확인" Sub-flow** — `resolveNamedLocation`(13-5, locationHint를 좌표로).
   - 입력: `{ hint }`
   - 출력: `{ lat, lng, name }` 또는 못 찾으면 `null`

**단, 지금 당장 리팩터링하지 말고 순서 제안**: 이미 동작 중인 `chip`/`locate` 플로우를
건드리는 건 위험 부담이 있으니, ① 먼저 `text` 분기를 지금 설계(13-3~13-8)대로 **독립적으로**
새로 만들어서 끝까지 동작시키고, ② 그 다음에 `chip`/`locate`가 쓰는 카카오 폴백 로직을
"카카오검색체인" Sub-flow로 뽑아내면서 `text`도 거기 맞춰 리팩터링하는 2단계로 가는 걸
권장. 처음부터 세 플로우를 동시에 Sub-flow 공유 구조로 만들면, 문제가 생겼을 때 그게
Sub-flow 자체 문제인지 호출부 문제인지 구분하기가 더 어려움.

## 15. 확인이 필요한 질문 (다음에 답 주시면 위 설계를 확정)

1. **Agent 노드의 User Prompt(Smart Component)에 배열(`#{parameter.body.favorites}`)을
   그대로 넣으면 어떻게 치환되는가?** — 유효한 JSON 문자열로 나오는지, `[object Object]`로
   깨지는지. 깨지면 13-3에 적어둔 대로 Agent 앞에 `JSON.stringify` Code 노드를 하나 추가.
2. **Sub-flow 노드의 입출력 계약이 API Trigger 호출(Plugin-API처럼 동기적으로 끝나고
   `#{서브플로우 이름.필드}`로 결과 참조)과 동일한 모양인가?** — 아니면 별도의 입력/출력
   매핑 UI가 있는지. 14번 항목의 Sub-flow 분리 제안이 이 답에 따라 구체적인 모양이
   달라짐.
3. **Agent 노드의 System/User Prompt에도 Smart Component(`#{parameter.body.x}`)가
   그대로 먹히는가?** — 지금까지 확인된 Smart Component는 전부 Plugin-API 파라미터/Result
   JSON 템플릿 쪽이었고, Agent 노드의 프롬프트 입력창에서도 똑같이 동작하는지는 아직 실제로
   본 적이 없음(13-3/13-7의 User Prompt 설계 전체가 이 전제 위에 있음).
