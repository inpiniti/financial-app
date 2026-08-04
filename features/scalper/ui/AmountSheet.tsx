// 자동 단타 설정 시트 — 마틴게일 on/off + 금액 필드(세션 확장 plan §2-5, 마틴 옵션화 2026-08-05).
//  · 마틴 켬: 시작금액·최대금액·최소 속도 3필드(기존).
//  · 마틴 끔: 금액·최소 속도 2필드. 금액이 고정되고 세션 완주 판정도 하지 않는다.
// 검증은 autopilot.validateConfig 단일 소스를 그대로 쓴다.
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '../../../components/BottomSheet';
import { ToggleRow } from '../../../components/ToggleRow';
import { isMartingaleOn, validateConfig, type AutoPilotConfig } from '../autopilot';

export interface AmountSheetProps {
  visible: boolean;
  /** 현재 설정 — 폼 초기값(없으면 빈 폼, 최소 속도만 기본 1). */
  initial: AutoPilotConfig | null;
  onClose: () => void;
  /** 반환값이 문자열이면 에러 문구(시트 유지), null이면 성공(상위가 닫는다). */
  onSubmit: (config: AutoPilotConfig) => string | null;
}

export function AmountSheet({ visible, initial, onClose, onSubmit }: AmountSheetProps) {
  const [start, setStart] = useState('');
  const [max, setMax] = useState('');
  const [minRate, setMinRate] = useState('1');
  const [martingale, setMartingale] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setStart(initial ? String(initial.startAmountUsd) : '');
      setMax(initial ? String(initial.maxAmountUsd) : '');
      setMinRate(initial ? String(initial.minTickRate) : '1');
      setMartingale(initial ? isMartingaleOn(initial) : true);
      setError(null);
    }
  }, [visible, initial]);

  /** 마틴을 다시 켤 때 최대금액이 시작금액 이하로 남아 있으면 비운다 — 첫 수익에 즉시 세션이 완주해 버린다. */
  const handleToggleMartingale = (next: boolean) => {
    setMartingale(next);
    if (next && Number(max) <= Number(start)) setMax('');
  };

  const handleSubmit = () => {
    // 마틴 끔: 최대금액을 시작금액과 같은 값으로 정규화해 저장한다(불변식 유지 + 다시 켤 때 프리필).
    // 마틴 켬: martingale 키를 아예 넣지 않는다 — 저장 포맷을 기존 v2 그대로 유지하기 위해서다.
    const config: AutoPilotConfig = martingale
      ? {
          startAmountUsd: Number(start),
          maxAmountUsd: Number(max),
          minTickRate: Number(minRate),
        }
      : {
          startAmountUsd: Number(start),
          maxAmountUsd: Number(start),
          minTickRate: Number(minRate),
          martingale: false,
        };
    const invalid = validateConfig(config);
    if (invalid) {
      setError(invalid);
      return;
    }
    const rejected = onSubmit(config);
    if (rejected) setError(rejected);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="p-6" style={{ paddingBottom: 32 }}>
        <Text className="mb-3 text-lg font-bold text-[#191f28]">자동 단타 설정</Text>

        <ToggleRow
          title="마틴게일"
          description="손실이 나면 금액 2배, 수익이 나면 절반으로 조정해요"
          value={martingale}
          onValueChange={handleToggleMartingale}
          className="mb-3 flex-row items-center justify-between rounded-2xl bg-[#f7f9fc] px-3 py-2 active:opacity-80"
        />

        <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
          {martingale
            ? '세션은 시작금액으로 시작해요. 수익이 나면 절반, 손실이 나면 2배로 조정되다가 최대금액에 도달한 뒤 수익으로 마무리되면 세션을 끝내고 처음부터 다시 시작해요.'
            : '설정한 금액으로 계속 반복해요. 손익에 따라 금액이 바뀌지 않고 세션도 저절로 끝나지 않아요 — 정지할 때까지 이어서 돌아요.'}
        </Text>

        <Text className="mb-1 text-xs text-[#8b95a1]">{martingale ? '시작금액(USD)' : '금액(USD)'}</Text>
        <TextInput
          value={start}
          onChangeText={setStart}
          keyboardType="decimal-pad"
          placeholder="예: 100"
          placeholderTextColor="#8b95a1"
          className="mb-3 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />

        {martingale && (
          <>
            <Text className="mb-1 text-xs text-[#8b95a1]">
              최대금액(USD) — 여기 도달 후 수익으로 끝나면 세션 종료
            </Text>
            <TextInput
              value={max}
              onChangeText={setMax}
              keyboardType="decimal-pad"
              placeholder="예: 400"
              placeholderTextColor="#8b95a1"
              className="mb-3 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
          </>
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
