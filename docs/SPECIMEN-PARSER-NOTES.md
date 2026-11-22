# v4 추가 사항

파서 VERSION은 4.0.0입니다. 기존 본문 추출 범위는 유지하면서 다음 파일 속성 읽기를 추가했습니다.

- DOCX: Application/AppVersion, core 속성, customProperties 및 출처 경로.
- HWPX: content.hpf의 named meta. generator/producer/application 등을 기록.
- PDF: Info dictionary와 Catalog /Metadata XMP의 CreatorTool/Producer/날짜. 요소·속성 형태를 모두 처리.
- 메타데이터는 본문에 삽입하지 않습니다. 모든 결과에 provenanceVerified:false를 기록하며 값의 진위와 서명을 검증하지 않습니다.
- PDF XMP의 손상·미지원·크기 초과는 경고로 남기고 본문 추출과 구분합니다.

v4에서 실행한 문서 입력 32조건은 `../tests/parser-v4-test-results.json`과 `VALIDATION.md`에 기록했습니다. XML은 테스트용 어댑터를 사용했습니다. 네이티브 브라우저 검증 결과가 아닙니다.

---

## 이전 버전에서 유지한 본문 추출 설명

아래의 과거 브라우저 시험 기록은 v4에서 재실행한 결과가 아닙니다. 해당 JSON은 `../tests/legacy-v3/`에 보관하며, 현재 검증 범위는 위 v4 항목과 `VALIDATION.md`를 따릅니다.

# 문서 입력 범위와 재현 시험

## 실행 조건

앱 본체의 `js/parsers.js`는 이 배포물을 위해 작성한 JavaScript입니다. 외부 라이브러리, PDF.js, JSZip, OCR 프로그램, 서버, 설치형 실행 파일을 사용하지 않습니다. 선택적 내부망 LLM은 파서와 독립된 `js/llm.js`를 통해 호출합니다. 문서 파일은 `File.arrayBuffer()`, ZIP/Flate 압축은 브라우저 내장 `DecompressionStream`, XML은 내장 `DOMParser`로 처리합니다. 파일을 여는 최신 Chrome/Edge에서 `DecompressionStream('deflate-raw')`를 지원해야 합니다. 지원하지 않는 브라우저에는 업데이트 안내를 표시합니다.

MD/PDF/HWPX/DOCX의 모든 변형을 구현한 범용 문서 렌더러는 아닙니다. 추출하지 못한 정보를 추정해 채우지 않습니다. 암호화 또는 잘못된 파일은 오류를 표시하고, 일부 추출은 `partial`, 텍스트 부족은 `insufficient`로 반환합니다.

## 지원 범위

| 형식 | 읽는 내용 | 제한 및 별도 확인 사항 |
| --- | --- | --- |
| MD | UTF-8, BOM이 있는 UTF-16, UTF-8 실패 시 CP949/EUC-KR 해석 안내; Markdown 원문 텍스트 | 연결 이미지·외부 주소를 내려받지 않습니다. HTML·스크립트를 실행하지 않습니다. 원본을 렌더링한 모양과 다를 수 있습니다. |
| DOCX | ZIP 저장/Deflate, 본문 문단, 표 셀, 각주·미주, 머리말·꼬리말, 기본 메타데이터 | XML 순서이며 쪽 나눔·다단 배치를 계산하지 않습니다. 삭제 이력은 제외하고 삽입 텍스트를 포함합니다. 주석·그림·수식 의미·OLE/altChunk 내용은 지원 범위 밖입니다. altChunk는 부분 추출로 표시합니다. |
| HWPX | `Contents/section*.xml` 구역의 문단과 표 셀, 기본 OPF 메타데이터 | 숫자 구역/XML 순서입니다. 도면·그림·수식의 의미, 화면 쪽 배치를 재현하지 않습니다. 본문 대신 미리보기 텍스트만 사용하는 동작은 하지 않습니다. |
| PDF | 비압축·Flate·ASCII85·ASCIIHex·RunLength 텍스트 스트림, 페이지 트리/상속 리소스, Font ToUnicode bfchar/bfrange, 압축 객체 스트림, Form XObject 텍스트, 일부 표준 인코딩과 ActualText | OCR/이미지 분석·글꼴 렌더링·전체 PDF 표준을 구현하지 않습니다. 다단·표·수식은 그리기 순서와 사람이 읽는 순서가 다를 수 있습니다. 복잡한 CMap·미지원 필터·깨진 구조는 누락/부분 추출을 표시합니다. |

PDF의 `Identity-H/V`를 Unicode라고 가정하지 않습니다. 확인 가능한 ToUnicode가 없으면 문자를 임의 변환하지 않고 누락을 표시합니다. 반면 `UniKS-UCS2-H` 등 명시적인 Unicode 입력 인코딩은 UTF-16BE로 읽으며, 한글 CP949 인코딩의 제한된 표준 이름도 처리합니다.

PDF에 숨은 텍스트 렌더링 모드(Tr 3/7), 선택 표시 레이어(OC/OCProperties), 대화형 양식 필드 또는 복수 저장 리비전이 있으면 부분 추출로 표시합니다. 숨은 OCR 텍스트와 현재 화면이 같다고 단정하지 않으며, 복수 리비전 파일의 최신 xref 권한을 완전히 검증한다고 주장하지 않습니다. 새로 저장한 정적 PDF와 대조해야 합니다.

메타데이터의 작성자·생성 프로그램명은 자체 신고 정보입니다. 진본성·작성 주체·AI 사용 여부의 증명이 아닙니다. PDF 주석과 첨부 문서는 본문 스트림과 분리된 자료이므로 분석 범위에 포함하지 않습니다.

## 추출 결과 계약

`SpecParsers.parse(file, {onProgress})`는 Promise를 반환합니다.

- `text`: 분석에 넘기는 정규화한 전체 텍스트.
- `blocks`: `id`, `text`, `start`, `end`, `label`, `kind`, `part`, PDF일 때 `page`. `start/end`는 이 `text`의 UTF-16 위치이며 원본 파일 바이트 위치가 아닙니다. `text.slice(start,end) === block.text`입니다.
- `metadata`: 형식, 파서 버전, 읽을 수 있는 경우 생성 프로그램·작성자 등.
- `warnings`: 생략 내용·부호 해석·복구 사항.
- `quality`: `status`, `reason`, `chars`, `usableChars`, `truncated`; PDF는 `pages`, `parsedPages`, `coverage`, `missingGlyphs` 추가.

`coverage`는 텍스트가 있는 것으로 읽힌 페이지 수/페이지 트리상의 전체 페이지 수입니다. 전체 의미·단어의 정확도나 도면 검증률을 뜻하지 않습니다. `good`도 전체 문서의 진본성 또는 완벽한 문자·레이아웃 복원을 인증하지 않습니다.

## 자원 제한과 입력 방어

| 항목 | 한도 또는 처리 |
| --- | --- |
| 파일 | 30 MiB |
| ZIP 항목 수 | 5,000개 |
| ZIP 개별 해제 크기 | 32 MiB |
| 전체 압축 해제 예산 | 100 MiB |
| 추출 본문 | 2,000,000 UTF-16 문자 또는 25,000개 블록 |
| PDF 페이지 트리 | 1,000쪽 |
| PDF 상위 객체 | 120,000개 |
| PDF CMap 항목 | 120,000개 |
| PDF 개별 어휘 분석 | 2,500,000 토큰 |
| ZIP 검사 | 중앙 디렉터리/로컬 헤더·CRC32·길이 확인, 중복/상위 경로/암호화/ZIP64/분할 압축 거부 |
| XML 검사 | DOCTYPE/ENTITY 선언 거부, 외부 관계 링크 실행/조회 없음 |
| PDF | JavaScript·동작·첨부 파일 실행 없음, 암호화 거부, 미지원 텍스트 매핑 경고 |

여기서 MiB는 1,048,576바이트입니다. 한도에 도달하면 오류나 부분 추출 상태를 반환합니다. 스캔 PDF에는 OCR을 수행하지 않으며, 빈 결과를 ‘AI 흔적 없음’으로 해석해서는 안 됩니다.

## 검증 이력과 한계 (v2 갱신)

`tests/legacy-v3/browser-parser-test-results.json`에 **실제 Chromium 엔진의 네이티브 `DOMParser`, `File`, `DecompressionStream`을 사용한 28개 파서 검사 통과** 기록을 포함했습니다. 별도의 XML 어댑터나 외부 파서 프로그램을 사용하지 않았으며 PDF/HWPX/DOCX/MD 합성 입력을 브라우저 가상 문서로 주입했습니다. `file://` URL을 직접 탐색한 검사는 보안 정책으로 차단되어 **실제 현장 PC에서 별도 확인해야 합니다**.

시험은 MD 인코딩, DOCX 표·변경 이력·저장 압축, HWPX 표·구역, PDF 압축·한글 문자 매핑·Form XObject·객체 스트림·간접 길이, 숨은 텍스트·레이어·저장 리비전, 암호화·손상·파일 크기·형식 거부를 다룹니다. 추출된 텍스트와 문단 오프셋 일치도 확인합니다. AI 작성 여부 탐지의 정확도를 검증한 것은 아닙니다.

배포 PC에서 `tests/parser-tests.html`을 브라우저로 열고 **자가점검 시작**을 누르면 기능 지원 여부를 확인할 수 있습니다. 이 페이지와 실제 `../js/parsers.js` 파일만 사용하며 설치 프로그램·시험 라이브러리·인터넷이 필요하지 않습니다. 테스트 결과가 화면에 성공으로 표시되는 시점은 사용자가 실제 실행한 이후입니다.

`tests/parser-fixtures/synthetic-minimal.hwpx`는 XML 추출을 검증하기 위해 만든 **합성 자료**입니다. 한컴에서 작성하거나 한컴 응용프로그램으로 호환성을 검증한 실제 HWPX 내보내기 파일이 아니며, 폭넓은 실무 문서 호환성은 추가 확인 대상입니다.

## 형식 자료

아래 공개 자료의 형식 정의를 참고했습니다. 앱은 이 주소에 연결하지 않습니다.

1. 한컴테크, 「한/글 문서 파일 형식: HWPX 포맷 구조 살펴보기」: https://tech.hancom.com/hwpxformat/
2. Microsoft Learn, 「Structure of a WordprocessingML document」: https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document
3. Microsoft Learn, 「Working with paragraphs」: https://learn.microsoft.com/en-us/office/open-xml/word/working-with-paragraphs
4. Adobe, 「ToUnicode Mapping File Tutorial」 (PDF Association 보관본): https://pdfa.org/norm-refs/5411.ToUnicode.pdf

