// 자동 단타 설정 시트 — 진입금액·동시 그리드 수·최소 속도(다중 그리드 2026-08-05).
//
// ⚠ 마틴게일(손실 2배·수익 절반) 토글과 최대금액 필드는 이 화면에서 내렸다.
//   다중 그리드에서는 사이클이 동시에 여러 개 끝나므로 "어느 금액을 2배 할지"가 정의되지 않고,
//   그리드 자체가 −w 물타기로 수량을 배로 늘리기 때문에 진입금액까지 배증하면 노출이 두 겹으로 폭주한다.
//   그래서 진입은 **항상 여기서 정한 고정 금액**이고, 세션은 성과 집계 단위로만 남는다.
//   (저장 포맷 하위호환을 위해 martingale:false·maxAmountUsd=진입금액으로 정규화해 저장한다.)
// 검증은 autopilot.validateConfig 단일 소스를 그대로 쓴다.
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '../../../components/BottomSheet';
import {
  DEFAULT_MAX_GRIDS,
  MAX_GRIDS_LIMIT,
  maxGridsOf,
  validateConfig,
  type AutoPilotConfig,
} from '../autopilot';

export interface AmountSheetProps {
  visible: boolean;
  /** 현재 설정 — 폼 초기값(없으면 빈 폼, 최소 속도만 기본 1). */
  initial: AutoPilotConfig | null;
  onClose: () => void;
  /** 반환값이 문자열이면 에러 문구(시트 유지), null이면 성공(상위가 닫는다). */
  onSubmit: (config: AutoPilotConfig) => string | null;
}

export function AmountSheet({ visible, initial, onClose, onSubmit }: AmountSheetProps) {
  const [amount, setAmount] = useState('');
  const [grids, setGrids] = useState(String(DEFAULT_MAX_GRIDS));
  const [minRate, setMinRate] = useState('1');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setAmount(initial ? String(initial.startAmountUsd) : '');
      setGrids(String(maxGridsOf(initial)));
      setMinRate(initial ? String(initial.minTickRate) : '1');
      setError(null);
    }
  }, [visible, initial]);

  const handleSubmit = () => {
    const startAmountUsd = Number(amount);
    const config: AutoPilotConfig = {
      startAmountUsd,
      // 마틴게일을 쓰지 않으므로 최대금액은 진입금액과 같은 값으로 정규화한다(불변식 유지).
      maxAmountUsd: startAmountUsd,
      minTickRate: Number(minRate),
      martingale: false,
      maxConcurrentGrids: Number(grids),
    };
    const invalid = validateConfig(config);
    if (invalid) {
      setError(invalid);
      return;
    }
    const rejected = onSubmit(config);
    if (rejected) setError(rejected);
  };

  const gridCount = maxGridsOf({ maxConcurrentGrids: Number(grids) });
  const parsedAmount = Number(amount);
  const exposure = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount * gridCount : null;

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="p-6" style={{ paddingBottom: 32 }}>
        <Text className="mb-3 text-lg font-bold text-[#191f28]">자동 단타 설정</Text>

        <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
          변곡점이 잡힐 때마다 한 종목씩 진입하고, 진입한 종목은 ±폭 그리드가 이어받아 관리해요. 이미 보유 중인
          종목은 다시 사지 않고, 그리드가 익절되면 그 자리에 새 종목이 들어와요.
        </Text>

        <Text className="mb-1 text-xs text-[#8b95a1]">진입금액(USD) — 종목 하나를 살 때 쓰는 금액</Text>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="예: 100"
          placeholderTextColor="#8b95a1"
          className="mb-3 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />

        <Text className="mb-1 text-xs text-[#8b95a1]">
          동시 그리드 수 (1~{MAX_GRIDS_LIMIT}) — 한 번에 관리할 종목 개수
        </Text>
        <TextInput
          value={grids}
          onChangeText={setGrids}
          keyboardType="number-pad"
          placeholder={`기본 ${DEFAULT_MAX_GRIDS}`}
          placeholderTextColor="#8b95a1"
          className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />
        {exposure !== null && (
          <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
            첫 진입에만 최대 ${exposure.toFixed(2)}가 들어가요. 그리드가 물타기(−폭 매수)를 하면 종목당 금액이
            더 늘어날 수 있어요.
          </Text>
        )}

        <Text className="mb-1 text-xs text-[#8b95a1]">최소 속도(틱/초) — 이보다 조용한 종목은 감시하지 않아요</Text>
        <TextInput
          value={minRate}
          onChangeText={setMinRate}
          keyboardType="decimal-pad"
          placeholder="기본 1"
          placeholderTextColor="#8b95a1"
          className="mb-2 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />

        {error && <Text className="mb-2 text-xs text-[#f04452]">{error}</Text>}

        <View className="mt-4 flex-row" style={{ gap: 8 }}>
          <Pressable onPress={onClose} className="flex-1 items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80">
            <Text className="text-base font-semibold text-[#4e5968]">닫기</Text>
          </Pressable>
          <Pressable onPress={handleSubmit} className="flex-1 items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80">
            <Text className="text-base font-semibold text-white">설정하기</Text>
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
}
