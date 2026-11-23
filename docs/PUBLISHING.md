# GitHub Pages 공개·배포 안내

이 저장소는 별도 빌드 없이 HTML·CSS·JavaScript를 제공하는 정적 사이트다. 현재 `CNAME`의 도메인은 `aireviewer.moip.ai.kr`이며, 도메인 설정은 이 파일과 GitHub Pages 설정을 함께 관리한다.

## 1. 게시 설정

저장소 **Settings → Pages → Build and deployment**에서 다음 구성을 사용한다.

| 항목 | 값 |
| --- | --- |
| Source | Deploy from a branch |
| Branch | `main` |
| Folder | `/(root)` |
| Custom domain | `aireviewer.moip.ai.kr` |
| Enforce HTTPS | 인증서가 준비되면 활성화 |

기존 브랜치 게시 구성을 유지한다. 추가된 `Validate public site` 워크플로는 검사 전용이며 별도의 Pages 배포를 만들지 않는다. 실제 배포는 GitHub의 `pages build and deployment` 실행에서 확인한다.

루트의 빈 `.nojekyll`은 Jekyll의 파일 변환을 건너뛰도록 한다. CSS·스크립트·이미지는 상대 경로를 사용하므로 사용자 지정 도메인의 루트 및 `/AI_Reviewer/` 같은 프로젝트 경로에 배치할 수 있다. GitHub 기본 주소는 `https://EQAI-MOIP.github.io/AI_Reviewer/`이며 사용자 지정 도메인이 적용되면 그 도메인으로 이동할 수 있다.

GitHub 공식 문서: [게시 소스 구성](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [정적 사이트와 .nojekyll](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).

## 2. 공개 사이트와 로컬 실행의 차이

| 기능 | 공개 사이트 | 로컬 실행 도우미 |
| --- | --- | --- |
| 화면·규칙·합성 예시 | 사용 가능 | 사용 가능 |
| 파일 추가·텍스트 추출·원문 대조 | 브라우저에서 처리 | 브라우저에서 처리 |
| 사건 불러오기·사건/보고서 저장 | 사용 가능 | 사용 가능 |
| API 연결 전 예비 점검 | 브라우저에서 처리 | 브라우저에서 처리 |
| LLM AI 진단 | 제공자의 CORS 허용 등 직접 연결 조건 필요 | 로컬 중계 또는 직접 연결 |
| KIPRIS Plus 조회 | 제공자의 CORS 허용 등 직접 연결 조건 필요 | 로컬 중계 또는 직접 연결 |
| `server.js` 및 `/api/session`, `/api/relay` | 실행되지 않음 | Node.js가 실행 중일 때 사용 |

GitHub Pages는 서버 프로그램을 실행하는 호스팅이 아니다. `server.js`를 저장소에 올리는 것만으로 공개 API 중계 서버가 생기지 않는다. 브라우저에서 외부 연결이 차단되면 CORS 제한인지, API 키·상품 권한·모델 ID 문제인지 연결 결과를 확인한다. 키를 URL에 붙이거나 브라우저 보안 기능을 끄는 방법으로 해결하지 않는다.

로컬 연결은 저장소 전체를 내려받은 뒤 Node.js 22 이상에서 `node server.js`를 실행하고, 표시되는 `http://127.0.0.1:8765` 주소로 앱을 연다. 공개 사이트가 사용자의 로컬 실행 도우미에 자동 접속하는 방식은 사용하지 않는다. 앱의 자동 연결 모드는 로컬 주소에서만 도우미를 확인한다.

API의 실제 요청 허용 여부·모델 지원 범위·요금은 제공자 설정에 따라 달라진다. 합성 응답을 이용한 자동 시험만으로 운영 API나 실제 업무 문서의 판독 정확도를 검증한 것으로 표시하지 않는다.

## 3. 자료와 API 키

업무 문서, API 키, 추출문과 진단 결과는 저장소에 업로드하지 않는다. 화면에서 추가한 파일은 현재 탭의 메모리에서 다루며, 외부 LLM 분석을 실행하면 설정한 제공자에게 전달된다. 사건/보고서 저장은 사용자의 다운로드 폴더로 파일을 내려받는 기능이다.

공개 사이트에는 공용 API 키가 포함되지 않는다. 사용자는 자신이 사용할 제공자의 주소·모델·키를 입력한다. 저장소의 `.gitignore`는 `.env`, `APIKEY.md` 등의 실수로 인한 추가를 줄이기 위한 보조 장치이며, 이미 추적 중인 파일을 소급하여 제거하지 않는다.

## 4. 변경 후 검사

Node.js 22 이상에서 다음 명령을 실행한다. 앱 사용에는 npm 설치가 필요하지 않다.

```bash
node scripts/check-site.cjs
node scripts/version-assets.cjs
node scripts/version-assets.cjs --check
node --test tests/*.test.cjs
node scripts/checksums.cjs
node scripts/checksums.cjs --check
```

`check-site.cjs`는 HTML의 실행 자원과 CSS 이미지 경로가 존재하는지, 프로젝트 경로에서도 쓸 수 있는 상대 경로인지, JavaScript와 동봉 JSON의 구문이 유효한지 검사한다. `version-assets.cjs`는 `index.html`의 로컬 스크립트와 스타일시트 주소에 해당 파일의 SHA-256 앞 12자리를 `v` 쿼리로 붙인다. 파일 내용이 바뀌면 요청 주소도 바뀌어 새 화면과 이전 스크립트가 섞이는 캐시 문제를 줄인다. 상대 경로와 기존 쿼리·URL 조각은 유지하고 외부 주소는 수정하거나 요청하지 않는다. `--check`는 파일을 수정하지 않고 해시가 최신인지 확인한다.

체크섬 도구는 Git이 추적하거나 추가할 수 있는 파일을 대상으로 `SHA256SUMS.txt`를 만든다. 체크섬 파일 자체는 제외한다. 소스를 최종 수정한 뒤 **자원 버전 갱신 → 체크섬 갱신** 순서로 실행한다. CI는 오래된 자원 해시나 체크섬을 오류로 처리한다.

`Validate public site` 워크플로는 main 푸시, main 대상 PR, 수동 실행에서 같은 검사를 수행한다. Node.js 22와 Python 3.12를 사용하며 API 키나 실문서를 요구하지 않는다. Python은 HWPX·DOCX XML 시험의 어댑터에만 사용된다. 선택적 네이티브 브라우저 시험은 기본 CI에 포함되지 않으며 시험 결과에서 건너뜀으로 표시된다.

현재 브랜치 게시에서는 이 검사와 Pages 배포가 독립적으로 실행되므로 검사 실패가 배포를 자동 차단하지 않는다. 자동 차단이 필요하면 저장소 관리자가 PR 필수 검사 규칙을 구성하거나, 별도 변경으로 검사 후 배포하는 Actions 방식으로 전환한다.

## 5. 게시 후 확인

1. Actions에서 해당 커밋의 `Validate public site`와 `pages build and deployment` 결과를 확인한다.
2. 실제 사이트에서 새로고침하고 예시 열기, 화면 이동, 서류 추가·삭제, 사건/보고서 저장을 확인한다.
3. 개발자 도구에서 정적 파일 404, JavaScript 예외, 공개 사이트의 `/api/session` 요청이 없는지 확인한다.
4. 좁은 화면과 키보드 이동에서 메뉴·버튼·입력란이 가려지지 않는지 확인한다.
5. 이전 화면이 계속 보이면 브라우저 캐시를 새로 고친다. 도메인 연결이 실패하면 Pages 설정의 DNS·인증서 상태를 확인한다.

운영 중 문제가 생기면 문제 커밋을 되돌리는 새 커밋을 만들어 게시 이력을 유지한다. API 키와 업무 문서를 이슈나 오류 화면 캡처에 포함하지 않는다.
