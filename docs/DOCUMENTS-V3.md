# v3 문서 읽기: 지원 범위, 확인 절차와 한계

## 핵심 결론

HWPX·DOCX의 텍스트와 지원되는 PDF의 텍스트 레이어를 브라우저에서 읽는다. 파일을 선택했다는 사실, 텍스트가 추출되었다는 사실, 심사 근거로 원문의 전체 문언·위치가 확인되었다는 사실은 서로 다르다. v3 파서는 이 차이를 추출 상태와 위치·누락 항목으로 전달한다.

로컬 파서는 외부 모듈·네트워크 호출·OCR 엔진을 사용하지 않는다. 문서 속 스크립트·외부 링크·매크로를 실행하지 않는다. 별도로 사용자가 실행하는 AI 진단은 설정한 LLM 서비스에 자료를 전송할 수 있으며, 이는 로컬 파일 읽기와 별도 단계다.

## 형식별 실제 지원

| 형식 | 실제 읽는 내용 | 추가 확인이 필요한 내용 |
|---|---|---|
| PDF | 지원되는 페이지 트리, 콘텐츠 스트림, 글꼴 매핑에서 추출한 텍스트. Flate, ASCII85, ASCIIHex, RunLength 압축을 지원 | 스캔·이미지 안의 글자, 그림·표·수식의 시각적 의미, 숨은 OCR 레이어, 선택 표시 레이어, 주석·첨부·양식 필드. 미지원 글꼴·압축·리비전은 미완료 표시 |
| HWPX | ZIP 내부 구역 XML의 문단·표 셀 텍스트. `content.hpf`의 `spine` 순서로 구역을 읽고, 구역·문단·표·행·셀 위치를 보존 | 실제 인쇄 쪽수, 표 병합·다단·글자 서식, 그림, 수식 객체, 자동 번호, OLE 개체, 모든 변형의 변경 추적·표시 상태 |
| DOCX | 본문, 표 셀, 각주·미주, 머리말·꼬리말 텍스트. 삭제·이동 전 텍스트를 제외하고 삽입 텍스트를 포함 | 실제 인쇄 쪽수, 자동 문단 번호, 글꼴 기호, 수식, 이미지, 삽입 문서, 대체 표시 콘텐츠, 숨김 글자 및 복잡한 스타일 |
| TXT·MD·JSON | UTF-8, BOM이 있는 UTF-16, CP949/EUC-KR 텍스트. 깨진 문자·바이너리를 확인 | 텍스트 파일만으로 원본 문서의 출처·완전성·쪽 위치가 증명되지는 않음. Markdown 링크의 자료는 자동으로 읽지 않음 |
| HWP·DOC | 직접 읽지 않음 | 원래 편집기에서 HWPX·DOCX 또는 PDF로 저장한 사본 필요 |

HWPX·DOCX 구역·문단을 PDF의 쪽 번호로 가장하지 않는다. 심사관이 보고서의 쪽별 인용을 확인해야 하는 경우에는 **같은 판본의 PDF를 함께 추가하는 방법**이 가장 명확하다. 한컴이나 Word에서 PDF로 저장한 뒤 문서명·출원번호·기준일과 본문이 같은지 확인한다. 구조 텍스트만 있는 상태에서는 판본·전체 문언을 요구하는 확정 판단을 제한한다.

## HWPX 읽기 보강

v2는 `section0.xml`, `section1.xml` 등의 파일 번호순으로 본문을 읽었다. v3는 패키지의 `manifest`와 `spine`을 대조하여 본문 순서를 따른다. 한컴 공식 설명에서도 `manifest` 목록의 순서는 중요하지 않지만 `spine` 순서대로 읽어야 한다고 명시한다.[1][2]

- `spine`이 없으면 파일 번호순으로 복구하되 `partial`과 복구 경고를 남긴다.
- 필요한 구역이 없거나, 중복·외부 참조·헤더의 구역 수 불일치가 있으면 성공으로 처리하지 않는다.
- 미리보기 텍스트만 있는 파일을 본문 전체로 사용하지 않는다.
- 문단 중간의 표·중첩 문단을 읽은 뒤 이어지는 문단을 원래 XML 순서에 맞춘다. 부모 문단의 앞뒤 글자를 먼저 합친 뒤 표를 뒤에 붙이던 순서 오류를 줄였다.
- 표 셀에는 표·행·셀·문단 위치를 남긴다. 이 값은 XML 구조 위치이며 인쇄 쪽수가 아니다.
- 그림·수식·OLE·자동 번호를 읽지 못한 사실을 `omittedContent`로 전달한다. 수식이 제외된 텍스트를 전체 문언이 읽힌 것으로 표시하지 않는다.

## PDF 판독 상태의 의미

PDF는 보이는 글자를 Unicode 텍스트로 바꾸기 위해 글꼴의 인코딩·ToUnicode 등의 정보를 사용한다.[3] 따라서 PDF 파일이 정상적으로 열리더라도 텍스트가 온전히 추출된다는 보장은 없다.

v3는 다음 정보를 별도로 제공한다.

- 전체 페이지 수와 텍스트가 있는 페이지 수
- 읽을 수 있는 문자를 찾지 못한 페이지 목록
- 그림이 있는 페이지 목록
- 페이지별 문자 수·미해석 문자 수·이미지 수·판독 상태
- 페이지 트리의 순서를 확인했는지, 복구된 순서인지
- 시각 확인이 필요한지와 읽지 않은 요소 목록

`coverage: 100`은 **각 페이지에서 일정량 이상의 문자를 찾았다는 뜻**이다. 그림·표·수식·판독 정확도 100%를 뜻하지 않는다. 텍스트가 있는 페이지에 그림도 있으면 100%의 페이지 텍스트 비율과 함께 `partial`, `visualReviewRequired: true`가 표시될 수 있다.

스캔 PDF는 로컬 파서만으로 OCR할 수 없다. 텍스트 원본 또는 정확한 PDF 판독을 지원하는 모델과 후속 원문 확인이 필요하다. AI 전사 결과 또한 원문 검증과 동일하지 않다. 눈으로 확인할 수 없는 내용을 정상 판독으로 바꾸지 않는다.

## 파서 반환 계약

기존 `SpecParsers.parse(file, {signal, onProgress})` 계약을 유지한다. `quality`에 다음 값을 추가한다.

```js
{
  status: 'good' | 'partial' | 'insufficient',
  pageProvenance: 'physical' | 'recovered' | 'nonphysical',
  pageOrderVerified: Boolean,
  visualReviewRequired: Boolean,
  omittedContent: [{ kind: 'images' | 'equations' | 'annotations' | 'form-fields'
    | 'embedded-documents' | 'automatic-numbering' | 'font-symbols'
    | 'altChunk' | 'alternate-content' | 'uncertain-visibility', count: Number }],
  // PDF에서 제공:
  unreadablePages: [Number],
  pagesWithImages: [Number],
  pageDetails: [{ page, chars, usableChars, images, missingGlyphs,
    status: 'text' | 'partial' | 'unreadable' }],
  coverageMeaning: 'pages-with-text-not-reading-accuracy',
  // HWPX에서 제공:
  sectionOrderVerified: Boolean
}
```

모든 필드는 형식에 따라 선택적이다. `good`은 지원하는 텍스트 구조를 읽었다는 의미이며 출처 진위, 법적 타당성, 원본 화면과의 완전한 일치를 보증하지 않는다. `metadata.provenanceVerified`는 항상 `false`다. 문서 정체성·판본·증거 검증은 진단 엔진의 후속 절차에서 다룬다.

HWPX·DOCX의 `blocks`에는 `location: {part, paragraph, fragment, table?, row?, cell?}`와 사람이 읽을 수 있는 `label`이 들어간다. 물리적 쪽 번호는 생성하지 않는다.

## 안정성 보강

- ZIP 중앙·로컬 헤더의 이름·크기·CRC를 대조한다. 중복 경로, 상위 경로, 겹치는 데이터 범위, 목록 길이 불일치를 차단한다.
- 압축 선언 크기뿐 아니라 실제 해제 크기에도 한도를 적용한다.
- 암호화 문서, ZIP64, 지원하지 않는 압축 방식은 명확한 오류로 남긴다.
- XML의 손상된 Unicode를 다른 한국어 인코딩으로 조용히 재해석하지 않는다. 명시된 지원 인코딩만 엄격하게 해석한다.
- 외부 엔터티·DTD를 허용하지 않는다. XML은 25만 요소, 120단계 중첩을 한도로 처리한다.
- `AbortSignal`을 파일 읽기, 압축 해제 청크, PDF 페이지·HWPX 구역 처리에 전달한다. 중단을 정상 판독 결과로 변환하지 않는다.
- 파일 30 MiB, 압축 항목 32 MiB, 총 해제 100 MiB, 본문 200만 자, 25,000 블록, PDF 1,000쪽 한도를 유지한다. 한도 초과나 부분 복구는 경고 또는 실패로 처리한다.

동기식 XML 구성·문단 순회 도중에는 JavaScript의 현재 작업이 끝나기 전까지 UI 이벤트가 즉시 실행되지 않을 수 있다. 한도 설정은 최악의 메모리·처리 부담을 줄이기 위한 것이며 모든 문서에서 즉시 취소를 보장하지 않는다.

## 검증 범위

`tests/parsers-v3.test.cjs`는 합성 문서로 다음 위험을 확인한다.

- 스캔과 텍스트가 섞인 PDF, 텍스트와 그림이 함께 있는 페이지, 주석, 미지원 압축, 순환 페이지 트리, 도중 취소
- ZIP 경로·중복·CRC·과대 해제 선언, XML 손상 인코딩·DTD
- HWPX `spine` 순서, 구역 누락·수 불일치, 표의 중첩 순서, 수식·그림 누락, 미리보기만 있는 파일
- DOCX 변경 추적·표·각주, 자동 번호·수식 누락, 잘못되거나 지나치게 깊은 XML, UTF-16 한국어 XML

PDF·ZIP 검사는 Node 내장 기능으로 실행한다. XML 구조 회귀 검사는 Python 표준 라이브러리 XML 파서에 작은 테스트용 DOM 어댑터를 연결해 실행한다. 앱에는 이 어댑터·Python 의존성이 없다. 별도 개발 환경에 Playwright와 Chromium이 있으면 같은 XML 사례를 네이티브 `DOMParser`, `File`, `DecompressionStream`으로 다시 실행하는 선택적 시험도 포함되어 있다. 실행하지 못한 네이티브 시험은 `skip`으로 표시된다.

합성 문서 시험은 모든 한컴·Word 버전에서 출력된 업무 파일의 호환성이나 모든 PDF에 대한 판독 정확도를 입증하지 않는다. 실제 업무에서 사용할 대표 문서의 판독 결과와 원문을 대조해야 한다.

## 공식 형식 참고 자료

1. 한컴테크, [한/글 문서 파일 형식: HWPX 포맷 구조 살펴보기](https://tech.hancom.com/hwpxformat/), 2025-02-26. `content.hpf`, `manifest`, `spine`, 구역 XML 및 미리보기의 역할.
2. 한컴테크, [한/글 문서 파일 형식: Python을 통한 HWPX 포맷 파싱하기 (1)](https://tech.hancom.com/python-hwpx-parsing-1/), 2025-06-18. `spine` 순서와 헤더의 `secCnt` 설명.
3. Adobe, [PDF Reference 1.6](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.6.pdf), 제5.9절 Extraction of Text Content, ToUnicode CMaps.

확인일: 2026-11-22. 이 문서는 파서 구현 범위에 관한 설명이며 특허 법령 해석을 대신하지 않는다.
