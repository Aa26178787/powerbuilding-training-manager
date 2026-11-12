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
