# 큐리 v2 안내 스프라이트

## 추가 자산

- 파일: `assets/quri-v2-guide-6frames.webp`
- 실제 해상도: 1536 × 1024 픽셀
- 구성: 3열 × 2행, 셀당 512 × 512 픽셀, 여섯 개의 새로운 자세
- 투명도: RGBA 알파 보존. 단색 배경에 합성하여 투명 영역과 셀 경계를 육안 확인했다.
- 변환: 생성된 PNG를 ImageMagick으로 WebP 품질 94, 알파 품질 100으로 변환했다. 기존 자산은 덮어쓰지 않았다.
- 크기: 335,482바이트
- 상세 좌표: `assets/quri-v2-sprites.json`
- 제작: 2026-11-22, 내장 이미지 생성 도구. 외부 API 키를 사용하지 않았다.

| 자세 | 열 | 행 | 안내에 사용할 상황 |
| --- | --- | --- | --- |
| welcome | 0 | 0 | 시작·환영 |
| upload | 1 | 0 | 문서 업로드·자료 정리 |
| compare | 2 | 0 | 문서 간 대조·통지 당시 판본 확인 |
| thoughtful | 0 | 1 | 확인할 자료·보류·오류 안내 |
| explain | 1 | 1 | 진단 항목·판단 근거 설명 |
| complete | 2 | 1 | 검토 결과 정리·완료 |

## 표시 방법

정사각형 요소에 `background-size: 300% 200%`를 적용한다. 가로 위치는 `0% / 50% / 100%`, 세로 위치는 `0% / 100%`이다. 96–256 CSS 픽셀 표시를 권장한다. 문서와 판정의 상태는 항상 텍스트로도 설명한다. 완료 자세는 작업 단계의 완료를 뜻하며 출원에 하자가 없음을 뜻하지 않는다. 동작 감소 설정에서는 정적인 자세를 사용한다.

## 제작 프롬프트

기존 `inspector-hero-4frames.webp`와 `review-states-6frames.webp`를 캐릭터 식별과 재질의 참조로 제공했다. 다음 프롬프트의 3072 × 2048은 요청값이며 실제 산출물은 위의 1536 × 1024이다. 인위적인 확대 없이 원래 해상도로 배포한다.

> Use case: stylized-concept. Asset type: production-ready high-resolution transparent sprite atlas for a professional Korean patent review HTML app called QURI. Create a new sheet using the attached existing robot sheets ONLY as identity and material references. Keep EXACTLY the same adorable premium 3D robot identity: ivory cream rounded head and armor, glossy black face display, expressive luminous cyan eyes, teal shoulder accents and ear rings, dark charcoal hands and boots, one warm amber bulb antenna, small magnifier-shaped cyan chest emblem, proportions of an intelligent friendly assistant. The robot is now a kind AI review team leader guiding an examiner, not a policeman. Produce exactly SIX full-body poses laid out in a mathematically regular 3-column by 2-row sprite grid on transparent alpha. Request canvas 3072 by 2048, each cell 1024 by 1024. Every robot and all props entirely inside its own cell with 10% clear padding; equal visual scale, consistent centered placement and feet baseline; no crossing between cells. Top row left to right: 1) welcoming, gentle wave and open hand; 2) receiving a small tidy stack of cream documents into a teal folder, friendly smile; 3) calmly comparing two papers, eyes attentive. Bottom row left to right: 4) thoughtful, one hand at chin and other hand holding a small magnifier, no text or punctuation bubble; 5) kindly explaining, pointing at a cream clipboard with one amber highlighted line, open reassuring expression; 6) completed checklist, holding a tidy clipboard with a small teal tick symbol and friendly thumbs-up. Fine polished ceramic and metal material detail, soft studio illumination, clean sharp silhouettes, professional warm personality. IMPORTANT background truly transparent, no floor, no gradient, no backdrop, no opaque checkerboard, no excessive glow. No words, letters, numbers, captions, frame lines, watermarks, badges or logos. Do not regenerate any existing pose sheet directly; make these six new distinctive gestures while preserving the QURI face and identity. This is a reusable UI asset, not a poster.
