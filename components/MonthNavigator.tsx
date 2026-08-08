// 공용 년·월 네비게이터 — "‹이전달  2026년 8월  다음달›" 형태의 풀폭 바.
// 좌/우 "이전달"/"다음달"은 한 달씩 이동, 가운데 "2026년"/"8월"을 각각 누르면 공통 BottomSheet가 올라와
// 년도(올해부터 과거 20개)·월(1~12)을 고른다 (.claude/skills/app-ui-style — 선택 UI는 바텀시트).
// 미래(다음 달 이후)로는 이동/선택할 수 없다 — 우측 화살표 비활성, 시트에서도 미래 월은 흐리게 잠근다.
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BottomSheet } from './BottomSheet';
import { ListRow } from './ListRow';

export interface MonthNavigatorProps {
  year: number;
  /** 1~12 */
  month: number;
  /** 선택 가능한 상한(보통 현재 년·월) — 이보다 미래로는 이동할 수 없다. */
  maxYear: number;
  maxMonth: number;
  /** 년도 시트에 보여줄 개수 — maxYear부터 과거로. 기본 20. */
  yearsBack?: number;
  onChange: (year: number, month: number) => void;
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export function MonthNavigator({ year, month, maxYear, maxMonth, yearsBack = 20, onChange }: MonthNavigatorProps) {
  const [openSheet, setOpenSheet] = useState<'year' | 'month' | null>(null);

  const years = Array.from({ length: yearsBack }, (_, i) => maxYear - i);
  const atMax = year === maxYear && month === maxMonth;

  const clampToMax = (y: number, m: number): [number, number] =>
    y === maxYear && m > maxMonth ? [y, maxMonth] : [y, m];

  const movePrev = () => {
    if (month === 1) onChange(year - 1, 12);
    else onChange(year, month - 1);
  };
  const moveNext = () => {
    if (atMax) return;
    if (month === 12) onChange(year + 1, 1);
    else onChange(year, month + 1);
  };

  return (
    <View className="mb-2 flex-row items-center justify-between bg-white px-2 py-1">
      <Pressable
        onPress={movePrev}
        className="flex-row items-center justify-center px-2 active:opacity-60"
        style={{ minHeight: 44 }}
        accessibilityRole="button"
        accessibilityLabel="이전 달"
      >
        <Ionicons name="chevron-back" size={16} color="#4e5968" />
        <Text className="text-[13px] font-semibold text-[#4e5968]">이전달</Text>
      </Pressable>

      <View className="flex-row items-center">
        <Pressable
          onPress={() => setOpenSheet('year')}
          className="items-center justify-center rounded-xl px-2 active:bg-[#f2f4f6]"
          style={{ minHeight: 44 }}
          accessibilityRole="button"
          accessibilityLabel="년도 선택"
        >
          <Text className="text-lg font-bold text-[#191f28]">{year}년</Text>
        </Pressable>
        <Pressable
          onPress={() => setOpenSheet('month')}
          className="items-center justify-center rounded-xl px-2 active:bg-[#f2f4f6]"
          style={{ minHeight: 44 }}
          accessibilityRole="button"
          accessibilityLabel="월 선택"
        >
          <Text className="text-lg font-bold text-[#191f28]">{month}월</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={moveNext}
        disabled={atMax}
        className="flex-row items-center justify-center px-2 active:opacity-60"
        style={{ minHeight: 44, opacity: atMax ? 0.25 : 1 }}
        accessibilityRole="button"
        accessibilityLabel="다음 달"
      >
        <Text className="text-[13px] font-semibold text-[#4e5968]">다음달</Text>
        <Ionicons name="chevron-forward" size={16} color="#4e5968" />
      </Pressable>

      <BottomSheet visible={openSheet === 'year'} onClose={() => setOpenSheet(null)} heightRatio={0.6}>
        <Text className="px-5 pb-2 pt-1 text-base font-bold text-[#191f28]">년도 선택</Text>
        <ScrollView>
          {years.map((y) => (
            <ListRow
              key={y}
              title={`${y}년`}
              onPress={() => {
                const [ny, nm] = clampToMax(y, month);
                onChange(ny, nm);
                setOpenSheet(null);
              }}
              trailing={y === year ? <Ionicons name="checkmark" size={20} color="#3182f6" /> : undefined}
            />
          ))}
        </ScrollView>
      </BottomSheet>

      <BottomSheet visible={openSheet === 'month'} onClose={() => setOpenSheet(null)} heightRatio={0.6}>
        <Text className="px-5 pb-2 pt-1 text-base font-bold text-[#191f28]">월 선택</Text>
        <ScrollView>
          {MONTHS.map((m) => {
            const locked = year === maxYear && m > maxMonth;
            return (
              <View key={m} style={{ opacity: locked ? 0.35 : 1 }}>
                <ListRow
                  title={`${m}월`}
                  onPress={
                    locked
                      ? undefined
                      : () => {
                          onChange(year, m);
                          setOpenSheet(null);
                        }
                  }
                  trailing={m === month ? <Ionicons name="checkmark" size={20} color="#3182f6" /> : undefined}
                />
              </View>
            );
          })}
        </ScrollView>
      </BottomSheet>
    </View>
  );
}
