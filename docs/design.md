# UI·모션 설계 노트 (2026-11-13)

## 조사한 레퍼런스와 가져온 것

| 출처 | 가져온 것 |
|---|---|
| Strong / Hevy (운동 기록 앱) | 세트를 표의 한 줄로 기록하고 체크로 완료, 지난 기록을 같은 줄에 미리 표시, 체크하면 휴식 타이머 자동 시작, 휴식 ±15초 조정 |
| Liftosaur (오픈소스 PWA, Preact+TS+Tailwind) | 세트마다 지난 결과 표시, 원판 계산, 첫 세트 기준 워밍업, Tailwind 의미 기반 색 토큰 |
| Emil Kowalski 디자인 엔지니어링 스킬 (github.com/emilkowalski/skills) | 기본 easing은 ease-out 계열 커스텀 곡선, UI 전환 300ms 이하, 서랍은 iOS식 곡선, 버튼 누름 scale(0.97), scale(0)에서 시작하지 않기, transform/opacity만 애니메이션, 자주 하는 동작일수록 짧게 |
| View Transitions API (Chrome 111+, Android 포함) | 탭 전환을 번들 추가 없이 짧은 크로스페이드로 |
| AutoAnimate (@formkit/auto-animate) | 세트 줄·운동 카드가 바뀔 때 자동 재배치 애니메이션, 동작 줄이기 설정 자동 준수 |

## 토큰

- 배경 흑연 `#131519`, 카드 `#1c1f25`, 올림면 `#262a32`, 선 `#32363f`
- 글자 초크 `#eeece6`, 보조 `#9ca1ab`
- 주 행동·진행: 경기용 15kg 원판 노랑 `#f2c230` (그 외 용도로 쓰지 않음)
- 상태: 완료 초록 `#42b06f`, 상한 초과 빨강 `#e5533f`, 안내 파랑 `#4f8be6` — 항상 글자와 함께
- 서체: 한글 UI는 Pretendard, 중량·반복·퍼센트 숫자는 원판에 찍힌 숫자처럼 Barlow Condensed

## 모션

| 대상 | 방식 | 시간 |
|---|---|---|
| 버튼 누름 | scale(0.97) | 160ms ease-out |
| 세트 완료 | 체크 표시 0.8→1 + 줄 배경 초록 잔광 | 200ms / 500ms |
| 하단 시트 | 아래에서 올라옴, 손잡이 끌어서 닫기 | 360ms 서랍 곡선 / 닫힘 200ms |
| 탭 전환 | View Transition 크로스페이드 | 160ms |
| 목록 변화 | AutoAnimate | 기본값 |
| 휴식 진행 | 막대 linear (계속 움직이는 것은 linear) | 1초 단위 |
| 홈 게이지 | 처음 열 때 한 번 차오름 (화면의 유일한 연출) | 700ms ease-out |

`prefers-reduced-motion: reduce`이면 모두 끄고 즉시 상태만 바꾼다.

## 2026-11 정리: 참고한 스킬과 채택한 규칙

| 참고 | 채택한 것 | 채택하지 않은 것 |
|---|---|---|
| Motion (motion.dev) | 세트 행·카드의 자리 이동(layout), 세트 진행 막대, 토스트 등장·옆으로 밀어 닫기. `LazyMotion`+`MotionConfig reducedMotion="user"` | 스크롤 연출 |
| anime.js | 없음. Motion과 역할이 겹쳐 애니메이션 도구는 하나만 쓴다 | 전체 |
| emil-design-eng | 사용자 동작에만 움직임, 300ms 미만, 강한 ease-out, 자주 쓰는 동작은 짧게 | 장식용 연출 |
| Hallmark | 카드 안에 카드 금지, 가운뎃점 메타 문자열 금지, 장식용 상태 점 금지, 왼쪽 색 줄무늬 금지 | 랜딩 페이지 규칙 |
| taste-skill | 버튼·카드·태그 모양을 한 가지씩만, 상자 깊이 2단까지, 44px 터치 영역 | 랜딩 페이지·사진·WebGL 규칙 |
| UI UX Pro Max | 4/8px 간격 리듬, 눌림 피드백, 색만으로 상태 구분 금지 | 스타일 추천(운동 앱에 주황 강조 등) |
| web-design-guidelines (Vercel) | 알림 aria-live, 아이콘 aria-hidden, 숫자 tabular-nums, 링크처럼 보이는 텍스트 버튼 금지 | Title Case(한국어에 해당 없음) |
| bklit ui | 차트 규칙(장식 층은 하나, 배경은 조용히, 한 계열에 효과를 겹치지 않음) | 컴포넌트 설치(shadcn·visx 의존성이 커서) |
