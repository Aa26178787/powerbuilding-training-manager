# V1.9 B안: Conventional 구조와 보조 운동 슬롯 (SRS 추가분)

구현: `src/domain/slots.ts`(Category·Slot·근육 이름), `src/domain/defaults.ts`(라이브러리·B안 프리셋), `src/application/slots.ts`(선택·교체·집계), `src/application/library.ts`, `src/application/migrate.ts`. 테스트: `src/tests/v19b.test.ts`.

## 1. 데드리프트

| 요일 | 운동 | 처방 | 진행 |
|---|---|---|---|
| 화 | Competition Conventional Deadlift (`conv_dl`) | Top 1×4 @7~8, Backoff 4×4 첫 세트 @7, 상한 8 | Top+Backoff, +2.5kg, RTS e1RM × k |
| 금 | Paused Conventional Deadlift (`paused_conv`) | 3×3~5 @6.5~7.5, 상한 8(처음 3×4) | Double Progression, +2.5kg |
| 금 | Romanian Deadlift | 2×8~10 @6.5~7.5, 상한 8 | Double Progression |

- 금요일 순서: Paused Conventional → RDL → 나머지.
- Sumo 기록을 Conventional e1RM으로 환산하지 않는다. Conventional 기록(예전 금요일 기록 포함, 같은 `conv_dl`)이 있으면 그 기록을, 없으면 가벼운 세트 보정을 쓴다.
- Paused Conventional은 Conventional과 중량·진행을 따로 둔다(환산 계수 없음, 첫 사용 때 보정). 정지 위치·시간은 라이브러리에서 바꾼다(기본: 바닥에서 약 2cm 이상 뜬 위치, 1초).
- Paused Conventional·RDL의 RPE가 상한을 넘으면 기존 세트 간 조정 로직이 감량·조기 종료를 제안한다.
- Sumo(`comp_sumo`): 기본 루틴에서 빠짐. 운동·기록·계수·e1RM은 그대로 남고, 프로그램 편집 → 고정 운동에서 다시 넣을 수 있다.

## 2. 슬롯 구조

- 프로그램 항목(`SlotPrescription`)은 슬롯과 처방(세트·반복·RPE·진행 방식)을 가진다. 실제 운동은 슬롯 배정(`ExerciseAssignment`, `settings.slotAssignments`)을 따른다.
- 운동을 바꿔도 처방은 그대로이며, 작업 중량·장비·기록·진행(`ExerciseProgression` = 운동 id별 `exStates`)은 운동마다 따로다. 머신 사이에 환산 계수를 쓰지 않는다.
- 예전 운동을 다시 고르면 그 운동의 마지막 진행 상태를 그대로 쓴다.
- `PerformedSet.exerciseId`는 항상 실제로 한 운동이다.
- 고정 운동: Squat, Paused Bench, Conventional, Paused Conventional, Stop-and-go, High-bar, Larsen, Dips·Pull-up Strength, RDL.
- 슬롯: Upper Chest, Horizontal Pull, Lateral Delt, Posterior Delt, Triceps, Knee Extension, Knee Flexion, Abs, 그리고 Lower Chest(Dips Volume), Vertical Pull(Pull-up Volume). 사용자 슬롯 추가 가능. 슬롯을 만들어도 세트는 늘지 않는다.

| 예전 운동 | 슬롯 | 기본 선택 | 주간 세트 |
|---|---|---|---|
| Incline DB Press | Upper Chest | Incline Chest Press Machine | 2 |
| Chest-supported Row | Horizontal Pull | Linear Row | 9 |
| Cable Lateral Raise | Lateral Delt | Cable Lateral Raise | 7 |
| Reverse Pec Deck | Posterior Delt | Reverse Pec Deck | 3 |
| Overhead Cable Extension | Triceps | Overhead Cable Extension | 2 |
| Leg Extension | Knee Extension | Leg Extension | 3 |
| Seated Leg Curl | Knee Flexion | Seated Leg Curl | 5 |
| Hanging Leg Raise | Abs | Hanging Leg Raise | 6 |

## 3. 운동 바꾸기

- 오늘 화면의 슬롯 카드에서 "운동 변경". 세트를 시작하기 전이든 중간이든 가능.
- 완료한 세트가 있으면 그 세트는 원래 운동에 남고, 남은 세트만 같은 슬롯·같은 처방의 새 처방 묶음으로 옮긴다.
- "앞으로도 이 운동으로"를 켜면 슬롯 배정을 바꾸고, 다음 날 이후 아직 손대지 않은 같은 슬롯 계획도 바꾼다.
- 고정 운동과 같은 운동이거나 같은 동작 계열이면 경고만 하고 자동으로 빼거나 바꾸지 않는다. 일부러 짝지은 Volume 처방(`relatedOf`)은 경고하지 않는다.

## 4. 라이브러리

Category → Slot → Exercise, 검색, 즐겨찾기. 운동 등록 항목: 이름, Category, Slot, 장비 유형, 증량 단위, 사용 가능한 중량 단위, 권장 반복수(선택), 주동근(1.0)·보조근(0.5), 좌우 단측 여부. 근육 가중치(`ExerciseMuscleWeight`)와 슬롯은 따로 저장한다.

## 5. 집계

- Movement Pattern: 실제 완료 세트 수(가중치 없음). 슬롯 처방은 슬롯 기준, 고정 운동은 운동의 패턴(Squat, Bench Press, Deadlift, Hip Hinge, Vertical Pull, Lower Chest).
- Muscle Group: 주동근 1.0 + 보조근 0.5 가중 유효 세트. Delts는 Anterior / Lateral / Posterior를 따로 센다.
- 두 지표는 합치지 않는다. 슬롯 달성은 운동을 바꿔도 슬롯 처방 기준으로 이어서 센다.
- 기록 화면: Slot History(부위별 수행), Exercise History(운동별 중량·반복).

## 6. 마이그레이션(한 번)

- 새 운동을 라이브러리에 추가하고, `conv_dl` 이름·역할만 바꾼다(id·기록·계수 유지).
- 최신 프로그램 버전을 변환해 새 버전으로 저장: 프로그램 시작 전이면 시작 주부터, 시작 후면 다음 주 월요일부터. 이번 주와 지난 계획·기록은 그대로.
- 수행 기록, 계수, ARM 데이터, Sumo 진행 상태는 바뀌지 않는다.
