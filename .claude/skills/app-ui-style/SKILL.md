---
name: app-ui-style
description: financial-app의 화면/컴포넌트를 만들거나 수정할 때 반드시 사용 — 토스 모바일 문법(풀폭 패널+촘촘한 리스트) 강제
---

# financial-app UI 스타일 — 풀폭 패널 + 촘촘한 리스트

토스 실제 화면 문법. "좌우 여백(mx-4) + 라운딩 + 그림자"의 떠 있는 카드를 만들지 않는다.

내비게이션 구조: 하단 탭 바 없이 홈(단타)+Stack 화면 전환 + 화면 내부 고정 하단 메뉴(조회·설정 각각) 구조다 — OS 탭바 대신 각 화면 내부의 `BottomMenu`로 서브 섹션을 전환한다.

## 규칙

1. **패널(섹션)은 풀폭** — 좌우 여백 0, 라운딩 없음, 그림자 없음(`shadow-sm` 금지, `rounded-*` 금지).
   패널 사이는 얇은 회색 배경 갭(`marginBottom: 8~10`, 부모 배경이 비쳐 보임)으로만 구분한다. 테두리(border)로 구분하지 않는다.
2. **패널 내부 리스트 행은 간격 0** — 행마다 카드로 감싸지 않는다. 행 자체 패딩(수평 20 = `px-5`, 수직 12~14 = `py-[13px]`)만으로 밀도를 낸다.
   행 사이 구분선은 기본적으로 없다. 필요하면 아주 연한 선(`border-[#f2f4f6]`)만 허용한다.
3. 패널 상단에 작은 섹션 타이틀(좌측, bold 15pt)을 둘 수 있고, 우측에 보조 액션/텍스트(회색)를 둘 수 있다.
4. **새 화면에서 카드·리스트를 직접 만들지 말고 아래 공용 컴포넌트를 쓴다.**

## 공용 컴포넌트 (강제 사용)

| 컴포넌트 | 경로 | 용도 |
|---|---|---|
| `Panel` | `components/Panel.tsx` | 풀폭 흰 배경 섹션. `title?` / `headerRight?` / `children`. 화면을 꽉 채우는 단일 패널은 `style={{ flex: 1, marginBottom: 0 }}`로 갭을 덮어쓴다. |
| `ListRow` | `components/ListRow.tsx` | 촘촘한 행. `leading?` / `title` / `subtitle?` / `trailing?` / `onPress?`. `onPress`가 있으면 눌렸을 때 배경이 `#f7f9fc`로 바뀐다. |
| `TickerAvatar` | `components/TickerAvatar.tsx` | 종목 이니셜 원형 아바타 — `ListRow`의 `leading`으로 쓴다. |
| `BottomSheet` | `components/BottomSheet.tsx` | 딤 페이드 + 패널 슬라이드업 시트. **radius·애니메이션을 건드리지 않는다** — 시트는 이 규칙과 별개다. |
| `SelectBox` | `components/SelectBox.tsx` | 선택 UI 공용 필드. 선택 UI는 반드시 `SelectBox`(바텀시트) 사용 — 데스크탑식 드롭다운·가로 칩 나열 금지. |

새 리스트 화면은 항상 `<Panel><FlatList renderItem={... <ListRow .../> ...} /></Panel>` 형태로 짠다.
`ListRow`가 표현 못 하는 부가 요소(예: 행 아래 취소 버튼)가 필요하면 `ListRow`를 얇은 래퍼 `View`로 감싸고 그 아래 요소를 추가하되, 좌우 패딩은 `px-5`로 맞춘다.

## 색 토큰

| 역할 | 값 |
|---|---|
| 배경(페이지, 패널 갭) | `#f2f4f6` |
| 패널/서피스 | `#ffffff` |
| 텍스트 primary | `#191f28` |
| 텍스트 secondary | `#4e5968` |
| 텍스트 tertiary | `#8b95a1` |
| 포인트 | `#3182f6` |
| **이익(상승)** | `#f04452` (국내 증권 관례 — toss-design 기본 색보다 이 값이 우선) |
| **손실(하락)** | `#3182f6` |

손익 색은 항상 `lib/format.ts`의 `pnlColor()`를 통해서만 정한다 — 화면마다 직접 삼항연산으로 배정하지 않는다(과거 가격/등락 스왑 버그 재발 방지).

## 예시

```tsx
import { Panel } from '../../components/Panel';
import { ListRow } from '../../components/ListRow';
import { TickerAvatar } from '../../components/TickerAvatar';

<Panel title="보유종목">
  <FlatList
    data={positions}
    renderItem={({ item }) => (
      <ListRow
        leading={<TickerAvatar ticker={item.pdno} />}
        title={item.pdno}
        subtitle={item.prdt_name}
        trailing={<ProfitText amount={item.evlu_pfls_amt2} rate={item.evlu_pfls_rt1} />}
      />
    )}
  />
</Panel>
```

## 아이콘

아이콘은 `@expo/vector-icons`의 Ionicons만 사용한다 — 이모지 금지(빈 상태·배지·버튼 등 화면 어디에도). 액션 텍스트 버튼(카드 하단 "댓글/차트/호가"류)은 아이콘 14~16 + 라벨 + 포인트색(`#3182f6`) 조합으로 통일한다.

## 하지 말 것

- `mx-4` + `rounded-2xl`/`rounded-[20px]` + `shadow-sm` 조합으로 행/카드를 만드는 것
- 리스트 행 사이에 `mb-3` 같은 간격을 주는 것(행은 패널 안에서 붙어 있어야 한다)
- 화면마다 손익 색을 직접 계산하는 것 — `pnlColor()`만 쓴다
- `BottomSheet`의 radius·애니메이션 값을 이 규칙에 맞춰 바꾸는 것(시트는 예외)
