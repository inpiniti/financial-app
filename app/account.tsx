// 계좌 화면 — 상단바 "계좌" 버튼으로 진입. KIS 키/계좌번호 연결, 연결된 계좌의 잔고 요약, 거래 모드 안내.
// 2026-08-12에 옛 설정 화면(계좌연결|매매파라미터 두 섹션 + 하단 메뉴)을 계좌/설정 두 화면으로 쪼갠 결과다 —
// 매매 파라미터는 app/settings.tsx가 맡는다. 하단 메뉴는 양쪽 모두 없앴다(상단바에서 바로 들어온다).
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { ListRow } from '../components/ListRow';
import { Panel } from '../components/Panel';
import { inquireOverseasBalance, type OverseasBalanceSummary } from '../kis/balance';
import { getAccessToken } from '../kis/token';
import { secureTokenStorage } from '../lib/secureTokenStorage';
import { formatKrw, formatSignedKrw, formatSignedPercent, pnlColor } from '../lib/format';
import { formatAccountNo, loadKisSettings, parseAccountNo, saveKisSettings } from '../lib/kisSettings';
import { resetUsdKrwCache } from '../lib/usdKrw';

type TokenStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'success'; expiresAt: number }
  | { kind: 'failure'; reason: string };

/** 잔고 요약 로드 상태 — 키가 없으면 아예 조회하지 않는다(패널 자체를 감춘다). */
type BalanceState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; summary: OverseasBalanceSummary }
  | { kind: 'failure'; reason: string };

// 실전(LIVE) 전용 — 모의 전환 옵션은 2026-07-30 제거 (loadAppSettings가 'live'로 강제).
const ENVIRONMENT = 'live' as const;

function formatHHmm(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 잔고 요약 한 줄 — 금액은 output3의 원화 환산값을 그대로 쓴다(별도 환산 없음). */
function SummaryRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <ListRow
      title={<Text className="text-sm text-[#4e5968]">{label}</Text>}
      trailing={
        <Text className="text-base font-bold" style={{ color: color ?? '#191f28' }}>
          {value}
        </Text>
      }
    />
  );
}

export default function AccountScreen() {
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  // 저장된 AppSecret 실제 값은 화면에 노출하지 않는다 — 입력칸은 비워 두고 배지로만 "저장돼 있어요"를 알린다.
  // 사용자가 빈 칸으로 둔 채 저장하면(재입력 안 함) 기존 저장값을 그대로 유지한다.
  const [hasSavedAppSecret, setHasSavedAppSecret] = useState(false);
  const [savedAppSecret, setSavedAppSecret] = useState('');
  const [accountNoInput, setAccountNoInput] = useState('');

  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [balance, setBalance] = useState<BalanceState>({ kind: 'idle' });

  // 새로 입력했으면 그 값을, 비워 뒀고 이전에 저장돼 있었으면 기존 값을 그대로 쓴다(덮어쓰기는 재입력할 때만).
  const effectiveAppSecret = appSecret.trim() || (hasSavedAppSecret ? savedAppSecret : '');

  /** 저장된 키로 잔고 요약을 읽는다 — 키가 없으면 조용히 idle로 둔다(연결 전에는 계좌 패널을 안 그린다). */
  const loadBalance = useCallback(async () => {
    const kisSettings = await loadKisSettings();
    if (!kisSettings) {
      setBalance({ kind: 'idle' });
      return;
    }
    setBalance({ kind: 'loading' });
    try {
      const credentials = { appKey: kisSettings.appKey, appSecret: kisSettings.appSecret };
      const token = await getAccessToken(ENVIRONMENT, credentials, { storage: secureTokenStorage });
      const res = await inquireOverseasBalance(ENVIRONMENT, credentials, token.accessToken, {
        account: { cano: kisSettings.cano, acntPrdtCd: kisSettings.acntPrdtCd },
      });
      setBalance({ kind: 'ready', summary: res.output3 });
    } catch (e) {
      setBalance({ kind: 'failure', reason: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    (async () => {
      const kisSettings = await loadKisSettings();
      if (kisSettings) {
        setAppKey(kisSettings.appKey);
        // AppSecret은 입력칸에 값을 채우지 않는다(노출 금지) — 배지로 저장 여부만 알린다.
        setSavedAppSecret(kisSettings.appSecret);
        setHasSavedAppSecret(true);
        setAccountNoInput(formatAccountNo(kisSettings));
      }
      await loadBalance();
    })();
  }, [loadBalance]);

  const handleSave = async () => {
    const account = parseAccountNo(accountNoInput);
    if (!appKey.trim() || !effectiveAppSecret || !account) {
      Alert.alert('알림', 'AppKey·AppSecret·계좌번호(8-2 형식)를 모두 채워 주세요.');
      return;
    }

    setSaving(true);
    try {
      await saveKisSettings({ appKey: appKey.trim(), appSecret: effectiveAppSecret, ...account });
      // 저장 성공 — 이후 재입력 없이도 배지가 최신 저장값을 가리키게 갱신한다.
      setSavedAppSecret(effectiveAppSecret);
      setHasSavedAppSecret(true);
      setAppSecret('');
      // 계좌가 바뀌면 환율 캐시(잔고 응답에서 뽑은 값)도 다른 계좌 것이 된다 — 버리고 다시 받게 한다.
      resetUsdKrwCache();
      Alert.alert('알림', '계좌 정보를 저장했어요.');
      await loadBalance();
    } finally {
      setSaving(false);
    }
  };

  /**
   * 토큰 발급 + 실계좌 조회로 검증한다.
   * 이전에는 getAccessToken을 그냥 불렀는데, 캐시가 유효하면 서버를 아예 안 부르고 캐시를 돌려주는 함수라
   * 서버가 이미 폐기한 토큰에도 "연결됐어요"가 떴다(2026-08-11). 그래서 ① forceRefresh로 반드시 새로 받고,
   * ② 시세가 아니라 잔고조회로 확인한다 — 시세는 토큰이 죽어도 통과하는 경우가 있어 검증이 안 된다.
   */
  const handleIssueToken = async () => {
    if (!appKey.trim() || !effectiveAppSecret) {
      Alert.alert('알림', 'AppKey·AppSecret을 먼저 입력하고 저장해 주세요.');
      return;
    }
    const account = parseAccountNo(accountNoInput);
    if (!account) {
      Alert.alert('알림', '계좌번호(8-2 형식)를 먼저 입력해 주세요.');
      return;
    }

    setTokenStatus({ kind: 'checking' });
    try {
      const credentials = { appKey: appKey.trim(), appSecret: effectiveAppSecret };
      const token = await getAccessToken(ENVIRONMENT, credentials, {
        storage: secureTokenStorage,
        forceRefresh: true,
      });
      const res = await inquireOverseasBalance(ENVIRONMENT, credentials, token.accessToken, { account });
      setTokenStatus({ kind: 'success', expiresAt: token.expiresAt });
      // 방금 받아 온 응답을 그대로 쓴다 — 검증 직후에 같은 조회를 한 번 더 할 이유가 없다.
      setBalance({ kind: 'ready', summary: res.output3 });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setTokenStatus({ kind: 'failure', reason });
    }
  };

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="계좌" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        <Panel title="계좌 연결">
          <View className="px-5 pb-5">
            <Text className="mb-1 text-xs text-[#8b95a1]">AppKey</Text>
            <TextInput
              value={appKey}
              onChangeText={setAppKey}
              placeholder="KIS AppKey"
              placeholderTextColor="#8b95a1"
              autoCapitalize="none"
              autoCorrect={false}
              className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">AppSecret</Text>
              {hasSavedAppSecret && (
                <View className="rounded-full bg-[#e6f4ea] px-2 py-0.5">
                  <Text className="text-[11px] font-semibold text-[#03b26c]">저장돼 있어요</Text>
                </View>
              )}
            </View>
            <TextInput
              value={appSecret}
              onChangeText={setAppSecret}
              placeholder={hasSavedAppSecret ? '●●●●●● 저장돼 있어요 · 바꾸려면 새로 입력하세요' : 'KIS AppSecret'}
              placeholderTextColor="#8b95a1"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />

            <Text className="mb-1 text-xs text-[#8b95a1]">계좌번호 (8-2 형식)</Text>
            <TextInput
              value={accountNoInput}
              onChangeText={setAccountNoInput}
              placeholder="예: 12345678-01"
              placeholderTextColor="#8b95a1"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              className="mb-2 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />

            <Pressable
              onPress={handleSave}
              disabled={saving}
              className="mt-4 items-center justify-center rounded-2xl bg-[#3182f6] active:opacity-80"
              style={{ minHeight: 52 }}
            >
              <Text className="text-base font-semibold text-white">{saving ? '저장 중이에요…' : '저장하기'}</Text>
            </Pressable>

            <Pressable
              onPress={handleIssueToken}
              className="mt-2 items-center justify-center rounded-2xl bg-[#191f28] active:opacity-80"
              style={{ minHeight: 52 }}
            >
              <Text className="text-base font-semibold text-white">
                {tokenStatus.kind === 'checking' ? '발급 중이에요…' : '토큰 발급'}
              </Text>
            </Pressable>

            {tokenStatus.kind === 'success' && (
              <View className="mt-3 items-center rounded-2xl bg-[#e6f4ea] py-2">
                <Text className="text-sm font-medium text-[#03b26c]">
                  계좌 조회까지 확인했어요 · 만료 {formatHHmm(tokenStatus.expiresAt)}
                </Text>
              </View>
            )}
            {tokenStatus.kind === 'failure' && (
              <View className="mt-3 rounded-2xl bg-[#fdecee] px-3 py-2">
                <Text className="text-sm text-[#f04452]">연결하지 못했어요: {tokenStatus.reason}</Text>
              </View>
            )}
          </View>
        </Panel>

        {/* 계좌가 연결됐을 때만 — 키가 없으면(idle) 패널 자체를 그리지 않는다. */}
        {balance.kind !== 'idle' && (
          <Panel
            title="계좌"
            headerRight={
              <Pressable onPress={loadBalance} hitSlop={8} className="active:opacity-60">
                <Text className="text-xs font-semibold text-[#3182f6]">새로고침</Text>
              </Pressable>
            }
          >
            {balance.kind === 'loading' && (
              <View className="px-5 pb-4">
                <Text className="text-sm text-[#8b95a1]">잔고를 불러오고 있어요…</Text>
              </View>
            )}
            {balance.kind === 'failure' && (
              <View className="px-5 pb-4">
                <Text className="text-sm text-[#f04452]">잔고를 불러오지 못했어요: {balance.reason}</Text>
              </View>
            )}
            {balance.kind === 'ready' && (
              <>
                <SummaryRow label="총자산" value={formatKrw(balance.summary.tot_asst_amt)} />
                <SummaryRow label="평가금액" value={formatKrw(balance.summary.evlu_amt_smtl)} />
                <SummaryRow label="매입금액" value={formatKrw(balance.summary.pchs_amt_smtl)} />
                <SummaryRow
                  label="평가손익"
                  value={formatSignedKrw(balance.summary.evlu_pfls_amt_smtl)}
                  color={pnlColor(balance.summary.evlu_pfls_amt_smtl)}
                />
                <SummaryRow
                  label="평가수익률"
                  value={formatSignedPercent(balance.summary.evlu_erng_rt1, 2)}
                  color={pnlColor(balance.summary.evlu_erng_rt1)}
                />
                <SummaryRow label="예수금" value={formatKrw(balance.summary.tot_dncl_amt)} />
                <View className="px-5 pb-4 pt-1">
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    해외 체결기준 잔고예요. 외화 금액은 당일 최초고시환율로 원화 환산한 값이라 실제 환전액과는
                    차이가 있어요.
                  </Text>
                </View>
              </>
            )}
          </Panel>
        )}

        <Panel title="거래 모드">
          <View className="px-5 pb-5">
            <Text className="text-sm text-[#4e5968]">
              실전(LIVE) 전용이에요 — 모의투자는 KIS가 시세·순위 API를 지원하지 않아 쓸 수 없어요.
            </Text>
          </View>
        </Panel>
      </ScrollView>
    </View>
  );
}
