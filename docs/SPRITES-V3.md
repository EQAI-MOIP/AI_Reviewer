# QURI v3: 동작 스프라이트와 단계별 안내

## 새로 추가한 이미지

`assets/quri-v3-motion-16frames.webp`는 기존 큐리 캐릭터를 기준으로 생성한 투명 배경 4×4 아틀라스다. 인사, 입력 위치 안내, 서류 검토 중 기다림, 검토 내역 정리의 네 동작을 각 네 프레임으로 표현한다. 단일 그림을 위아래로 이동시키는 방식에 더해, 실제로 서로 다른 프레임의 손·표정·소품 동작을 전환한다.

| 항목 | 실제 파일 기준 |
| --- | --- |
| 이미지 크기 | 1,254 × 1,254 pixels |
| 프레임 배열 | 4열 × 4행, 16프레임 |
| 셀 크기 | 313.5 × 313.5 pixels, CSS 비율 좌표로 분할 |
| 형식 | WebP, 알파 채널 유지 |
| 파일 크기 | 468,350 bytes |
| 변환 | 생성 PNG를 같은 크기의 WebP 품질 95로 인코딩 |
| 권장 사용 | 안내용 64–144 CSS px, 이 범위에서 셀 원본이 표시 크기의 2배 이상 |
| 기존 자산 | 512 pixels 셀인 v2 포즈 및 기존 기타 WebP도 계속 포함 |

생성 요청은 2,048 pixels 아틀라스를 목표로 했지만 도구가 실제 반환한 해상도는 1,254 pixels였다. 해상도를 키운 파일로 바꿔 고해상도라고 표시하지 않았다. 큰 히어로 영역에는 동일한 아틀라스를 표시하므로 고밀도 화면에서는 작은 안내 영역보다 선명도가 낮아질 수 있다.

## 화면에서의 동작

- **첫 화면:** 큐리의 인사 프레임과 ‘큐리와 둘러보기’ 버튼을 제공한다.
- **문서 입력:** 끌어놓기 영역에 큐리가 문서 위치를 안내한다.
- **출원번호 입력:** 번호 칸에 초점을 주면 안내 동작으로 바뀌고 번호 형식과 연결 조건을 알려 준다.
- **진단 중:** 서류를 읽는 동작, 실제 단계 메시지, 경과 시간을 함께 보여 준다. 애니메이션은 진행률이나 성공을 추정하지 않는다.
- **결과:** 실제 사건 상태가 `clear`이면 정리 동작을, 추가 확인 상태에서는 정지한 검토 포즈를 사용한다. 결과 문구가 판단 상태를 전달한다.
- **6단계 화면 안내:** 시작 방법 → 문서 넣기 → 출원번호 → 서류 시점 → 진단 실행 → 근거·저장 순서로 화면을 직접 열고 해당 영역을 표시한다. 이 안내는 API 요청이나 문서 업로드를 실행하지 않는다.

## 접근성과 사용량

- 시스템의 `prefers-reduced-motion`과 앱의 ‘모션 끄기’를 모두 지원한다.
- 화면 밖의 캐릭터는 `IntersectionObserver`로 애니메이션을 일시 정지한다.
- 다른 탭으로 이동하면 CSS 애니메이션과 경과 시간 갱신을 멈춘다. 돌아오면 실제 경과 시간을 다시 계산한다.
- 애니메이션에만 상태 의미를 맡기지 않는다. 같은 상태를 제목·설명·버튼으로 표시한다.
- 안내는 자동으로 작업을 가리는 모달을 띄우지 않는다. 사용자가 버튼을 누르면 비모달 안내를 연다.
- 안내의 이전·다음·닫기는 키보드로 조작한다. Escape로 닫고 안내를 연 버튼으로 초점을 돌린다.
- 좁은 화면에서는 안내 패널 크기를 줄이며, 상단의 중복 경로 표시를 숨겨 버튼이 밀리지 않도록 한다.
- 실행에 CDN, 프레임워크, 외부 폰트, 이미지 서비스 호출을 요구하지 않는다.

## 연결 방법

`index.html`에서 기존 CSS 뒤에 `css/v3.css`, 기존 앱 JavaScript 뒤에 `js/quri-guide.js`를 불러온다. 모듈은 DOM이 준비되면 자동으로 초기화한다.

```html
<link rel="stylesheet" href="css/v3.css">
<script defer src="js/quri-guide.js"></script>
```

앱은 실제 상태가 바뀔 때 다음 API를 호출한다.

```js
QuriGuide.setState('reading', { message: '의견제출통지서의 근거를 확인하고 있습니다.' });
QuriGuide.setState('hold');      // 추가 확인이 필요한 결과
QuriGuide.setState('complete');  // 적용 범위 검토가 완료된 상태
QuriGuide.setState('welcome');   // 새 사건 준비
QuriGuide.refresh();            // 사건 표시 변경 뒤 재연결
```

허용 상태는 `welcome`, `reading`, `upload`, `input`, `complete`, `hold`다. 실제 실행 상태는 앱의 `ReviewApp.isBusy()`를 우선한다. 화면을 이동해도 진행 중 동작과 마지막 실제 단계 메시지를 복원하며, 새 사건에는 이전 사건의 결과 동작을 남기지 않는다. 합성 예시는 캐릭터의 접근성 설명에도 실제 진단이 아님을 표시한다. `startTour()`와 `endTour()`로 안내를 열고 닫을 수 있다. 모듈은 문서·API 키·진단 결과를 저장하지 않는다.

## 제작·검증 기록

- built-in `image_gen`으로 기존 `quri-v2-guide-6frames.webp`를 참고하여 생성했다.
- 투명 배경, 캐릭터 외형, 네 행의 동작 구분은 생성 이미지에서 시각 확인했다.
- 실제 이미지 크기, 알파 채널 범위(0–255), WebP 인코딩 결과를 확인했다.
- `node --check js/quri-guide.js` 구문 검사를 통과했다.
- `node --test tests/quri-v3.test.cjs`: **8개 테스트 통과, 0개 실패**. 독립 DOM 하네스에서 실제 `app.js`와 `quri-guide.js`를 실행한다. 기존 `ui.test.cjs`의 다른 테스트를 중복 등록하지 않는다.
- 검사 범위: 안내 6단계 이동·Escape 닫기·초점 복귀·메시지의 텍스트 처리·진행 중 타이머 중복 방지·화면 전환 중 상태 유지·백그라운드 정지/재개·새 사건 상태 초기화·모션 끄기·합성 예시 표시·실제 busy 상태 복구. 실제 브라우저의 레이아웃 검증과는 구별한다.
- 작업 환경에서 Playwright 기본 브라우저 파일이 없었고 설치된 Chromium도 소켓 제한으로 시작하지 못했다. 이 기록만으로 실제 브라우저 렌더링·모든 키보드 동작이 검증됐다고 볼 수 없다. 배포 전 통합 검증 결과는 최종 검증 문서를 따른다.

### 생성 프롬프트의 핵심

> 기존 큐리의 아이보리 로봇 몸체, 검은 화면 얼굴, 청록색 눈과 귀, 전구 안테나, Q 표식을 유지한다. 투명 배경의 4열×4행 스프라이트 아틀라스를 만들고, 행마다 인사·오른쪽 위치 안내·문서와 돋보기 검토·체크리스트 정리의 연속 네 동작을 배치한다. 몸체 크기·시선·조명과 발 기준선을 유지하고, 셀 간 겹침·문자·격자·배경을 넣지 않는다.

원본 생성 이미지를 별도 네트워크에서 불러오지 않고 프로젝트 안의 WebP 자산을 사용한다.

### 최종 생성 프롬프트 원문

```text
Use case: identity-preserve. Asset type: production sprite animation atlas for the Korean AI patent review assistant QURI. Transform the supplied reference character sheet into a NEW transparent sprite atlas; preserve exactly the character identity: warm ivory ceramic little robot, black rounded screen face, bright teal eyes and ear rings, golden lightbulb antenna, tiny Q emblem, dark articulated gloves and boots, teal shoulder details. High quality soft 3D studio rendering, friendly and professional. Required layout: a square 2048 by 2048 atlas with EXACTLY 4 columns and 4 rows of equal 512 by 512 invisible cells, total 16 full body robot figures. No grid lines, no text, no labels, genuinely transparent background. The robot is center-aligned at the same feet baseline and identical scale in every cell, fits fully in each cell with 35px margin. Each row is a temporal animation sequence of the SAME action, with subtle deliberate pose changes, suitable looping. Row 1 (top): 4 progressive greeting wave frames, open hand moves slightly left, center, right, center while smiling. Row 2: 4 progressive guiding frames, robot pointing toward viewer's RIGHT with one extended hand, a small document folder held in other hand, slight arm bend/extend differences. Row 3: 4 progressive reading and waiting frames, robot holds a document and magnifier, looks down, magnifier moves a little across document; no imaginary progress or clock. Row 4 (bottom): 4 progressive gentle ready/completion frames, robot holds a neat checklist and nods lightly, relaxed happy smile, thumb raised. Exact matching lighting/camera and body size throughout all 16 cells, no overlap across cells, no hard shadows extending outside cells, no scenery, no floor rectangle. Make details clear and adorable even rendered at 140px. This is animation art, NOT sixteen unrelated poses. Preserve alpha transparency, no fake checkerboard.
```
