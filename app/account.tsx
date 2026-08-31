// 계좌 화면 — 상단바 "계좌" 버튼으로 진입. KIS 키/계좌번호 연결, 연결된 계좌의 잔고 요약, 거래 모드 안내.
// 2026-08-12에 옛 설정 화면(계좌연결|매매파라미터 두 섹션 + 하단 메뉴)을 계좌/설정 두 화면으로 쪼갠 결과다 —
// 매매 파라미터는 app/settings.tsx가 맡는다. 하단 메뉴는 양쪽 모두 없앴다(상단바에서 바로 들어온다).
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { BackHeader } from '../components/BackHeader';
import { ListRow } from '../components/ListRow';
import { Panel } from '../components/Panel';
import { inquireOverseasBalance, type OverseasBalanceSummary } from '../kis/balance';
import { inquirePsAmount } from '../kis/psamount';
import { getAccessToken } from '../kis/token';
import { secureTokenStorage } from '../lib/secureTokenStorage';
import { formatKrw, formatSignedKrw, formatSignedPercent, formatUsd, pnlColor } from '../lib/format';
import { clearApprovedAccountNo, loadApprovedAccountNo } from '../lib/gateStorage';
import { formatAccountNo, loadKisSettings, parseAccountNo, saveKisSettings } from '../lib/kisSettings';
import { resetUsdKrwCache } from '../lib/usdKrw';
import {
  getApprovalInfo,
  reissueApprovalKey,
  subscribeApprovalInfo,
  type ApprovalInfo,
} from '../features/scalper/ui/managerProvider';

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

/** 매수 가능 금액(2026-08-29 데스크탑에서 이식, KIS 매수가능금액조회) — 조회 실패는 null(행을 감춘다). */
interface BuyableInfo {
  /** 한투 앱 "외화" 기준 주문가능금액(USD) — ovrs_ord_psbl_amt. */
  usdOnly: number | null;
  /** 한투 앱 "통합"(원화 환전 포함) 기준 주문가능금액(USD) — frcr_ord_psbl_amt1. */
  unified: number | null;
}

/**
 * 매수 가능 금액 조회 — 금액 자체는 종목과 무관하지만 API가 종목·단가를 요구해 대표값(NASD·AAPL·$1)으로 묻는다.
 * 잔고 요약과 별개 API(현금 기준)라 실패해도 잔고 패널은 그려야 한다 — 실패는 null로 삼킨다.
 */
async function fetchBuyable(
  credentials: { appKey: string; appSecret: string },
  accessToken: string,
  account: { cano: string; acntPrdtCd: string },
): Promise<BuyableInfo> {
  try {
    const output = await inquirePsAmount(ENVIRONMENT, credentials, accessToken, {
      account,
      ovrsExcgCd: 'NASD',
      ordUnpr: 1,
      itemCd: 'AAPL',
    });
    const num = (v: string | undefined) => {
      const n = Number.parseFloat(v ?? '');
      return Number.isFinite(n) ? n : null;
    };
    return { usdOnly: num(output.ovrs_ord_psbl_amt), unified: num(output.frcr_ord_psbl_amt1) };
  } catch {
    return { usdOnly: null, unified: null };
  }
}

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

/**
 * 실시간(웹소켓) 접속키 패널(2026-08-28) — 지금 소켓이 쓰는 접속키와 발급 시각을 그대로 보여 주고, 버튼으로 새로 발급받아
 * 재접속한다. 접속키는 앱을 켤 때마다 새로 받지만(managerProvider), "정말 새 키인지·재활용인지"를 사용자가 눈으로 확인할
 * 길이 없었다(MAX SUBSCRIBE OVER 진단 중 제보). 트레이딩 탭을 연 적이 없으면 매니저가 없어 키도 없다.
 */
function ApprovalKeyPanel() {
  const [info, setInfo] = useState<ApprovalInfo | null>(() => getApprovalInfo());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => subscribeApprovalInfo(setInfo), []);

  const handleReissue = useCallback(async () => {
    const before = getApprovalInfo()?.approvalKey ?? null;
    setBusy(true);
    setNote(null);
    try {
      const next = await reissueApprovalKey();
      if (!next) {
        setNote('트레이딩 탭을 먼저 열어야 접속키가 만들어져요.');
      } else {
        setNote(next.approvalKey === before ? 'KIS가 같은 키를 돌려줬어요(재활용).' : '새 키를 받아 재접속했어요.');
      }
    } catch (err) {
      setNote(`발급 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Panel
      title="실시간 접속키"
      headerRight={
        <Pressable onPress={handleReissue} disabled={busy} hitSlop={8} className="active:opacity-60">
          <Text className="text-xs font-semibold" style={{ color: busy ? '#8b95a1' : '#3182f6' }}>
            {busy ? '발급 중…' : '새로 발급 · 재접속'}
          </Text>
        </Pressable>
      }
    >
      <View className="px-5 pb-4">
        {info === null ? (
          <Text className="text-sm text-[#8b95a1]">아직 없어요 — 트레이딩 탭을 열면 발급돼요.</Text>
        ) : (
          <>
            <Text className="text-xs text-[#191f28]" style={{ fontVariant: ['tabular-nums'] }} selectable>
              {info.approvalKey}
            </Text>
            <Text className="mt-1 text-xs text-[#8b95a1]">
              발급 {new Date(info.issuedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </Text>
          </>
        )}
        {note !== null && <Text className="mt-2 text-xs text-[#4e5968]">{note}</Text>}
        <Text className="mt-2 text-xs leading-5 text-[#8b95a1]">
          앱을 켤 때마다 새로 받는 키예요. 새로 발급하면 지금 소켓을 끊고 새 키로 다시 붙어요(구독은 자동 복원).
        </Text>
      </View>
    </Panel>
  );
}

export default function AccountScreen() {
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  // 저장된 AppSecret 실제 값은 화면에 노출하지 않는다 — 입력칸은 비워 두고 배지로만 "저장돼 있어요"를 알린다.
  // 사용자가 빈 칸으로 둔 채 저장하면(재입력 안 함) 기존 저장값을 그대로 유지한다.
  const [hasSavedAppSecret, setHasSavedAppSecret] = useState(false);
  const [savedAppSecret, setSavedAppSecret] = useState('');
  // 계좌번호는 이 화면에서 못 고친다 — 처음 화면(게이트)에서 통과한 계좌번호가 그대로 원본이다.
  // 바꾸려면 상단바 오른쪽 "계좌 변경"으로 게이트로 돌아가 다시 입력해야 한다.
  const [gateAccountNo, setGateAccountNo] = useState('');
  // 키가 이미 저장돼 있으면(=연결 완료) "계좌 연결" 패널을 감춘다.
  const [connected, setConnected] = useState(false);

  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [balance, setBalance] = useState<BalanceState>({ kind: 'idle' });
  const [buyable, setBuyable] = useState<BuyableInfo>({ usdOnly: null, unified: null });

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
      const account = { cano: kisSettings.cano, acntPrdtCd: kisSettings.acntPrdtCd };
      const [res, buyableInfo] = await Promise.all([
        inquireOverseasBalance(ENVIRONMENT, credentials, token.accessToken, { account }),
        fetchBuyable(credentials, token.accessToken, account),
      ]);
      setBalance({ kind: 'ready', summary: res.output3 });
      setBuyable(buyableInfo);
    } catch (e) {
      setBalance({ kind: 'failure', reason: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    (async () => {
      const [kisSettings, approved] = await Promise.all([loadKisSettings(), loadApprovedAccountNo()]);
      const gateAccount = approved ? parseAccountNo(approved) : null;
      setGateAccountNo(gateAccount ? formatAccountNo(gateAccount) : (approved ?? ''));

      if (kisSettings) {
        setAppKey(kisSettings.appKey);
        // AppSecret은 입력칸에 값을 채우지 않는다(노출 금지) — 배지로 저장 여부만 알린다.
        setSavedAppSecret(kisSettings.appSecret);
        setHasSavedAppSecret(true);
        setConnected(true);

        // 게이트에서 다른 계좌로 다시 로그인했으면 저장된 KIS 계좌도 따라간다 — 게이트가 원본이다.
        if (gateAccount && (gateAccount.cano !== kisSettings.cano || gateAccount.acntPrdtCd !== kisSettings.acntPrdtCd)) {
          await saveKisSettings({ ...kisSettings, ...gateAccount });
          resetUsdKrwCache();
        }
      }
      await loadBalance();
    })();
  }, [loadBalance]);

  /** 상단바 "계좌 변경" — 게이트에 저장된 통과 계좌를 지우고 처음 화면(계좌번호 입력)으로 되돌린다. */
  const handleSwitchAccount = () => {
    Alert.alert('계좌 변경', '처음 화면으로 돌아가 계좌번호부터 다시 입력할게요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '변경할게요',
        style: 'destructive',
        onPress: async () => {
          await clearApprovedAccountNo();
          resetUsdKrwCache();
          router.replace('/');
        },
      },
    ]);
  };

  const handleSave = async () => {
    const account = parseAccountNo(gateAccountNo);
    if (!appKey.trim() || !effectiveAppSecret || !account) {
      Alert.alert('알림', 'AppKey·AppSecret을 모두 채워 주세요. 계좌번호는 처음 화면에서 로그인한 계좌를 써요.');
      return;
    }

    setSaving(true);
    try {
      await saveKisSettings({ appKey: appKey.trim(), appSecret: effectiveAppSecret, ...account });
      // 저장 성공 — 이후 재입력 없이도 배지가 최신 저장값을 가리키게 갱신한다.
      setSavedAppSecret(effectiveAppSecret);
      setHasSavedAppSecret(true);
      setConnected(true);
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
    const account = parseAccountNo(gateAccountNo);
    if (!account) {
      Alert.alert('알림', '계좌번호를 확인하지 못했어요. 상단 "계좌 변경"으로 처음 화면에서 다시 로그인해 주세요.');
      return;
    }

    setTokenStatus({ kind: 'checking' });
    try {
      const credentials = { appKey: appKey.trim(), appSecret: effectiveAppSecret };
      const token = await getAccessToken(ENVIRONMENT, credentials, {
        storage: secureTokenStorage,
        forceRefresh: true,
      });
      const [res, buyableInfo] = await Promise.all([
        inquireOverseasBalance(ENVIRONMENT, credentials, token.accessToken, { account }),
        fetchBuyable(credentials, token.accessToken, account),
      ]);
      setTokenStatus({ kind: 'success', expiresAt: token.expiresAt });
      // 방금 받아 온 응답을 그대로 쓴다 — 검증 직후에 같은 조회를 한 번 더 할 이유가 없다.
      setBalance({ kind: 'ready', summary: res.output3 });
      setBuyable(buyableInfo);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setTokenStatus({ kind: 'failure', reason });
    }
  };

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader
        title="계좌"
        right={
          <Pressable
            onPress={handleSwitchAccount}
            hitSlop={8}
            className="items-center justify-center px-3 py-3 active:opacity-60"
            style={{ minHeight: 44 }}
            accessibilityRole="button"
            accessibilityLabel="계좌 변경"
          >
            <Ionicons name="swap-horizontal" size={22} color="#191f28" />
          </Pressable>
        }
      />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        {/* 연결이 끝나 있으면(키 저장됨 + 잔고 조회 정상) 이 패널은 감춘다 — 잔고가 안 불러와질 때만 다시 나온다. */}
        {(!connected || balance.kind === 'failure') && (
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

            <Text className="mb-1 text-xs text-[#8b95a1]">계좌번호</Text>
            <TextInput
              value={gateAccountNo}
              editable={false}
              placeholder="처음 화면에서 로그인한 계좌"
              placeholderTextColor="#8b95a1"
              className="rounded-2xl bg-[#f2f4f6] px-4 py-3 text-base text-[#8b95a1]"
            />
            <Text className="mt-2 text-xs leading-4 text-[#8b95a1]">
              처음 화면에서 로그인한 계좌예요. 바꾸려면 오른쪽 위 계좌 변경을 눌러 주세요.
            </Text>

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
        )}

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
                {/* 연결 패널을 감췄을 때도 어느 계좌인지는 보여야 한다. */}
                <SummaryRow label="계좌번호" value={gateAccountNo || '-'} />
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
                {buyable.usdOnly !== null && (
                  <SummaryRow label="매수 가능(외화)" value={formatUsd(buyable.usdOnly, 2)} />
                )}
                {buyable.unified !== null && (
                  <SummaryRow label="매수 가능(통합)" value={formatUsd(buyable.unified, 2)} />
                )}
                <View className="px-5 pb-4 pt-1">
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    해외 체결기준 잔고예요. 외화 금액은 당일 최초고시환율로 원화 환산한 값이라 실제 환전액과는
                    차이가 있어요. 매수 가능 금액은 현금 기준(미수 제외)이에요 — 외화는 가진 달러만, 통합은 원화
                    환전분까지 합한 값이에요.
                  </Text>
                </View>
              </>
            )}
          </Panel>
        )}

        <ApprovalKeyPanel />

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
