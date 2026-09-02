/**
 * 포지션 관리자 — 종목 1개의 진입 후 관리(보유 → 판정 → 매매/주문 → 체결 반영 → 정산)를 하나의 깊은 모듈로 든다.
 * 오토파일럿은 이 인터페이스에 인계(arm)·신호·틱·폴·해제만 넘기고, 돌아오는 결과값으로 정산·격리·해제만 한다.
 *
 *   인터페이스 `PositionManager` (오토파일럿이 알아야 하는 전부)
 *     arm(seed)                        — 인계: 포지션을 확정하고 관리를 시작(OCO는 두 주문을 건다)
 *     onSignal(signal, price)          — 봉 마감 신호 1개 판정 → 문턱을 넘기면 매매 시작(비동기)
 *     tick({ canStart })               — 매초: 서킷 heartbeat · 진행 중 매매 추격 · 손절 틱 판정(canStart일 때만)
 *     poll()                           — 주기 폴 → { holding } | { sold, record } | { isolated, reason }
 *     rotateSession?(label)            — 세션 전환(정규장↔주간): 쉬는 주문이 있는 구현만(OCO) 재등록
 *     release()                        — 관리를 놓는다(추격 중 매매 최선껏 취소, 이후 새 매매 없음)
 *     label / gaugeView / busy / restingOrders / isolated / faultText — 화면·Stop 문구용 읽기
 *
 *   어댑터(구현) — 모드마다 하나. 우선순위·스위치 판정은 `resolvePositionMode` **한 곳**이다(롤백 = 스위치 한 줄).
 *     RulePositionManager    — 규칙(PositionRule)+매매(Execution). 추세 청산(+서킷 데코레이터) / 변곡점 조건부 그리드.
 *     OcoGridPositionManager — 매도그리드(core/grid): OCO 두 지정가를 항상 걸어 두는 옛 경로(ADR 0002 보존).
 *
 * 청산 사유(SELL_SIGNAL/STOP_LOSS/CIRCUIT/MANUAL)는 매도를 **시작한 자리**에서 한 번 정하고 정산까지 그대로 든다.
 */
import { makeTradeRecord, type ExitReason, type SignalSnapshot, type TradeRecord } from '../../core/cycle';
import { CircuitExitRule, type CircuitEvent } from '../../core/circuit';
import { ConditionalGrid, type ConditionalDecision, type ConditionalGridView, type ConditionalPosition } from '../../core/conditional';
import type { Signal } from '../../core/detector';
import { Execution, type ClockLike, type ExecutionResult } from '../../core/execution';
import { Grid, REBRACKET_RETRY_MS, type BuyLegStatus, type GridPollResult } from '../../core/grid';
import {
  ModelExitRule,
  ModelSymmetricExitRule,
  MODEL_EXIT_CONFIG,
  MODEL_EXIT_SYMMETRIC,
  MODEL_SYMMETRIC_EXIT_CONFIG,
  MODEL_TP_HOLD,
  type ModelExitConfig,
  type ModelSymmetricExitConfig,
} from '../../core/model/exitRule';
import { loadModel } from '../../core/model';
import { MARTINGALE_CONFIG, MartingaleRule, type MartingaleConfig } from '../../core/martingale';
import { TrendExitRule } from '../../core/trend/exitRule';
import { CIRCUIT_MODE } from './circuitMode';
import { createExecutionPort } from './executionPort';
import { createGridOrderPort } from './gridOrderPort';
import { MARTINGALE_MODE } from './martingaleMode';
import { MODEL_MODE } from './modelMode';
import { TREND_MODE } from './trendMode';
import type { ScalperBroker } from './types';

// ---------------------------------------------------------------------------
// 모드 스위치·설정 (한 곳)
// ---------------------------------------------------------------------------

/**
 * 매도 관리 그리드(OCO)로 진입 후 청산을 대체할지(D5). 실제 활성화는 이 상수 **그리고** grid 설정 주입.
 * 추세·변곡점이 켜져 있으면 그쪽이 우선한다(resolvePositionMode).
 */
export const GRID_EXIT = true;

/**
 * 변곡점+그리드 조합(2026-08-15 도메인 문서)으로 포지션 관리를 대체할지. 실제 활성화는 이 상수 **그리고** inflection 설정 주입.
 * false로 두면 OCO 그리드로 **한 줄 롤백**된다. 추세가 켜져 있으면 추세가 우선한다.
 */
export const INFLECTION_GRID = true;

/** 외부(수동) 청산 재확인 주기(ms) — 추세 관리에서 잔고를 다시 읽는 간격(2회 연속 없음이면 MANUAL 정산). */
export const MANUAL_EXIT_CHECK_MS = 120_000;

/**
 * 청산 매도 발주가에 쓸 1호가의 신선도 한계(ms) — OrderPortAdapter.quoteStaleMs와 같은 값.
 * 이보다 오래된 호가는 쓰지 않고 판정가(체결가)로 폴백한다.
 */
export const EXIT_QUOTE_STALE_MS = 10_000;

/**
 * 시세 정지 판정(ms) — 마지막 체결 틱이 이보다 오래됐으면 WS가 죽었거나 구독이 거절된 것으로 보고
 * REST 현재가 폴백(fetchRestPrice)으로 청산 감시를 잇는다(2026-09-01 — 2026-08-28 전 종목 구독 거절
 * 실사고가 보유 중에 재현되면 익절·손절·마감 청산이 전부 멈추던 구멍).
 */
export const PRICE_STALE_MS = 20_000;
/** REST 현재가 폴백 조회 최소 간격(ms) — 종목당. 유량 방어(flow 250ms 간격과 별개의 자기 절제). */
export const REST_PRICE_PROBE_MS = 10_000;

/**
 * 청산 매도 발주가 거절됐을 때의 재시도 백오프(ms) — 기본 10초, 연속 거절마다 2배, 상한 60초.
 * 세션 간극(주문 API가 닫힌 ET 20~21시·03~04시)에는 거절이 정상적으로 이어지므로 격리(FAULT)로
 * 올리지 않고 최대 1분에 1번만 다시 두드린다(예전엔 1초마다 무한 재발주 — 유량 잠식, 2026-09-01).
 */
export const EXIT_RETRY_BASE_MS = 10_000;
export const EXIT_RETRY_MAX_MS = 60_000;
/** 청산 발주 실패 이벤트 스로틀(ms) — 첫 실패는 즉시, 이후 같은 상황 반복은 10분에 1번. */
export const EXIT_FAIL_LOG_THROTTLE_MS = 600_000;

/**
 * 추세 → 그리드 → 매매(2026-08-18 도메인 문서) 설정 — 현재 조절 항목 없음(규칙 전부 문서 고정값).
 * **주입 자체가 활성화 신호**다(TREND_MODE AND 주입).
 */
export interface TrendGridConfig {
  readonly kind?: 'trend';
  /** 손절 낙폭(소수) — 현재가 ≤ 평단×(1−p)면 봉 마감 없이 즉시 전량 매도. 0이면 끔. */
  readonly stopLossPct: number;
}

/**
 * 추세 설정의 단일 출처 — managerProvider가 주입한다.
 * 손절 −5%(2026-08-18 EJH −13% 사고 뒤) → −7%(2026-08-19 첫날 재현) → **0(끔, 2026-08-21 사용자 확정)**.
 * 순수 상태기계 전환(docs/분석/2026-08-21_4선-상태기계-검증.md): 5분봉 3일 재현에서 손절 유무 차이가 +$95.53 vs +$97.34로
 * 미미했고, 08-18에는 손절이 노이즈에 찍혀 오히려 −$10 손해였다 → "규칙은 4선 상태기계 하나"로 단순화.
 * ⚠ 대가: 봉 마감 전 수직 붕괴를 못 받는다(무손절 재현 최악 1건 −39%). 되돌리려면 이 값만 0.07로.
 */
export const TREND_CONFIG: TrendGridConfig = { kind: 'trend', stopLossPct: 0 };

/**
 * 모델 청산 설정 — **주입 자체가 활성화 신호**다(MODEL_MODE AND 주입).
 * 값은 백테스트 기하 그대로다. 바꾸면 검증 숫자가 그 설정에 대한 근거가 아니게 된다.
 * 두 기하를 다 담는다 — 실제 선택은 MODEL_EXIT_SYMMETRIC(core/model/exitRule) 스위치:
 *  · 대칭(현행, 2026-09-01): 익절 +3% · 손절 −3% · 최장 120분 — ±3% 대칭 라벨 재학습과 세트
 *  · 트레일(롤백): 트레일 −5% + 하드 −2% (docs/analysis/2026-08-24_청산-연구.md) — +5/−2 모델과 세트
 */
export interface ModelGridConfig extends ModelExitConfig, ModelSymmetricExitConfig {
  readonly kind?: 'model';
}

/** 모델 설정의 단일 출처 — managerProvider가 주입한다. */
export const MODEL_CONFIG: ModelGridConfig = { kind: 'model', ...MODEL_EXIT_CONFIG, ...MODEL_SYMMETRIC_EXIT_CONFIG };

/**
 * ±3% 단타 모드 설정(구 배수 물타기 시험 — 2026-08-27 ADR 0006, 2026-09-01 물타기 제거 ADR 0007) —
 * **주입 자체가 활성화 신호**다(MARTINGALE_MODE AND 주입). 값: 익절 +3% / 손절 −3% / 마감 청산 19:55 ET.
 * 진입은 프리·정규·애프터만(주간거래 제외 — isMartingaleEntryBar), 물타기·상한 없음.
 */
export interface MartingaleGridConfig extends MartingaleConfig {
  readonly kind?: 'martingale';
}

export const MARTINGALE_POSITION_CONFIG: MartingaleGridConfig = { kind: 'martingale', ...MARTINGALE_CONFIG };

/** 조건부 그리드 문턱 — 문서 §5 고정값(+2%/−3%)을 managerProvider가 주입한다. */
export interface InflectionGridConfig {
  /** 매도 수익 문턱(소수, 0.02=+2%). */
  sellProfitPct: number;
  /** 물타기 낙폭 문턱(소수, 0.03=−3%). */
  buyDropPct: number;
}

/**
 * 조합 문턱의 단일 출처 — 문서 §5 고정값(설정 탭 없음). managerProvider가 이 값을 주입하고,
 * 설정 화면의 "변곡점 그리드(고정값)" 안내도 같은 값을 읽는다(하드코딩 이중화로 어긋나지 않게).
 */
export const INFLECTION_THRESHOLDS: InflectionGridConfig = { sellProfitPct: 0.02, buyDropPct: 0.03 };

/** 그리드 설정 — 매수폭·매도폭·매수배율. 설정 탭(매매 파라미터)에서 조절한다. */
export interface GridExitConfig {
  /** 매수폭(물타기 간격, 소수). buyPrice=P×(1−buyWidth). 넓을수록 올인이 늦다. */
  buyWidth: number;
  /** 매도폭(익절 목표, 소수). sellPrice=P×(1+sellWidth). 좁을수록 반등 요구가 작다. */
  sellWidth: number;
  /** 매수 배율(기본 1). 매수수량 = floor(N×배율), 매도는 항상 N 전량. */
  buyMultiplier: number;
}

/** 진입 후 관리 설정 묶음 — 어느 모드가 켜지는지는 resolvePositionMode가 정한다. 주입 자체가 활성화 신호. */
export interface PositionManagementConfig {
  /** OCO 매도그리드(롤백 보존). 설정 탭에서 바뀌면 다음 인계부터 새 값. */
  grid?: GridExitConfig;
  /** 변곡점 조건부 그리드 문턱(롤백 보존). */
  inflection?: InflectionGridConfig;
  /** 추세 청산 규칙(롤백 보존). */
  trend?: TrendGridConfig;
  /** 모델 청산 규칙(현행) — +5%/−2%/120분. */
  model?: ModelGridConfig;
  /** 배수 물타기 시험 모드(2026-08-27) — 켜면 모델보다 우선한다. */
  martingale?: MartingaleGridConfig;
}

export type PositionMode = 'martingale' | 'model' | 'trend' | 'inflection' | 'oco';

/**
 * 모드 판정 — **유일한** 자리. 우선순위 물타기 시험 > 모델 > 추세 > 변곡점 조합 > OCO 그리드, 각각 스위치 상수 AND 설정 주입.
 * null이면 진입 후 관리자가 없다(RunCycle의 옛 SELL 신호 청산 경로 — 하네스 하위호환).
 */
export function resolvePositionMode(cfg: PositionManagementConfig | undefined): PositionMode | null {
  if (!cfg) return null;
  if (MARTINGALE_MODE && cfg.martingale !== undefined) return 'martingale';
  if (MODEL_MODE && cfg.model !== undefined) return 'model';
  if (TREND_MODE && cfg.trend !== undefined) return 'trend';
  if (INFLECTION_GRID && cfg.inflection !== undefined) return 'inflection';
  if (GRID_EXIT && cfg.grid !== undefined) return 'oco';
  return null;
}

// ---------------------------------------------------------------------------
// 인터페이스
// ---------------------------------------------------------------------------

/**
 * 진입 후 포지션 규칙 계약 — 조건부 그리드(변곡점 조합)와 추세 청산 규칙(서킷 데코레이터 포함)이 구조적으로 만족한다.
 * RulePositionManager의 배선(신호 판정 → 매매 → 폴 → 정산)은 이 계약만 본다.
 */
export interface PositionRule {
  readonly view: ConditionalGridView;
  decide(signal: Signal, price: number): ConditionalDecision | null;
  /** 틱(현재가) 판정 — 봉·신호 없이 가격만으로 나가는 결정(추세 손절선). 미구현이면 틱 판정 없음. */
  onPrice?(price: number): ConditionalDecision | null;
  shouldAbort(side: 'buy' | 'sell', price: number): boolean;
  setPosition(position: ConditionalPosition): void;
}

/** 현재가 읽기 — 슬롯이 없으면(입양 포지션) null. */
export interface PriceView {
  price: number | null;
  lastTradeAt: number | null;
  /** 오늘 최저·최고(틱 기준) — 추세 게이지의 양끝. 아직 없으면 null. */
  dayLow?: number | null;
  dayHigh?: number | null;
}

/** 게이지(화면) 데이터 — 오토파일럿이 ticker·faultText를 얹어 AutoPilotGridView로 낸다. */
export interface PositionGaugeView {
  /** 평단가 P(물타기하면 낮아진다). */
  avgPrice: number;
  /** 게이지 아래끝 — 주문선(매수 지정가/조건선) 또는 오늘 최저가(rangeKind='dayRange'). */
  buyPrice: number;
  /** 게이지 위끝 — 주문선(매도 지정가/조건선) 또는 오늘 최고가. */
  sellPrice: number;
  /** 최근 틱 현재가 — 화살표 위치용. 아직 없으면 null. */
  currentPrice: number | null;
  holdingQty: number;
  buyMultiplier: number;
  /** 관리 중인가(OCO: 두 주문 ARMED, 규칙형: 항상 true). */
  gridActive: boolean;
  /** 매수 다리 현금 판정(OCO) — 규칙형은 'full'. */
  buyLegStatus: BuyLegStatus;
  /** 게이지 양끝의 의미 — 'orders'=주문선/조건선, 'dayRange'=오늘 최저/최고(추세 — 주문선이 없다, 2026-08-18). */
  rangeKind?: 'orders' | 'dayRange';
  /**
   * 진입(인계) 후 관측된 최고/최저 체결가(2026-09-02, 게이지 참고 마커) — 규칙형 관리자만 채운다.
   * 시작값은 평단이고 이후 틱·게이지 조회 때 갱신된다. 관측 없으면 undefined.
   */
  sinceEntryHigh?: number;
  sinceEntryLow?: number;
}

export type PositionPollResult =
  | { kind: 'holding' }
  | { kind: 'sold'; record: TradeRecord }
  | { kind: 'isolated'; reason: string };

export type ArmResult = { ok: true } | { ok: false; reason: string };

export interface PositionManager {
  readonly ticker: string;
  /** 문구용 이름 — '추세 관리' · '변곡점 그리드' · '그리드'. */
  readonly label: string;
  /** 인계 — 진입 체결(있으면) 또는 잔고에서 읽은 포지션으로 관리를 시작한다. 실패 사유는 오토파일럿이 인터록/포기 판단. */
  arm(seed: ConditionalPosition | null): Promise<ArmResult>;
  gaugeView(): PositionGaugeView;
  /** 진행 중 매매가 있거나 발주 중 — 신호 거절·Stop 문구용. */
  readonly busy: boolean;
  /** 계좌에 **쉬고 있는 지정가**가 있는가(OCO 두 다리) — Stop이 즉시 놓을지(false) 사이클 완주를 기다릴지(true) 가른다. */
  readonly restingOrders: boolean;
  readonly isolated: boolean;
  readonly faultText: string | null;
  onSignal(signal: Signal, price: number): void;
  /**
   * 사용자 요청 전량 매도(2026-08-22) — 신호를 기다리지 않고 지금 보유 수량 전부를 매매로 넘긴다.
   * 매매는 평소와 똑같이 **체결될 때까지 현재가로 정정하며 따라간다**(취소선 없음). 청산 사유는 USER_SELL.
   * 시작했으면 true, 이미 매매 중이거나 팔 수량이 없어 아무것도 하지 않았으면 false.
   * 규칙 문턱을 통과하는 게 아니라 **덮어쓰는** 경로라, 자동 판정이 없는 어댑터(OCO)에는 없다(옵셔널).
   */
  sellNow?(price: number): boolean;
  tick(opts: { canStart: boolean }): Promise<void>;
  poll(): Promise<PositionPollResult>;
  /** 세션 전환 — 쉬는 주문을 새 세션으로 재등록한다(OCO만). 아무것도 안 했으면 null. */
  rotateSession?(label: string): Promise<PositionPollResult | null>;
  release(): void;
}

/** 모든 어댑터가 공유하는 의존성 — 오토파일럿이 종목 1개 단위로 만든다. */
export interface PositionManagerDeps {
  ticker: string;
  broker: ScalperBroker;
  clock: ClockLike;
  /** 최신 현재가·마지막 체결 시각·오늘 고저 — 슬롯이 없으면 null을 돌려준다. */
  price: () => PriceView | null;
  /**
   * 최신 1호가(체결가 페이로드의 PBID/PASK) — 청산 매도 발주·추격가를 매수1호가로 크로스하는 데 쓴다
   * (2026-09-01 — 마지막 체결가 지정가는 급락 중 호가 위에 걸려 1초에 한 칸씩 쫓아 내려가며 슬리피지
   * −0.9%p를 만들었다: docs/분석/2026-08-27_청산-슬리피지-첫-실측과-방향.md). 미주입·null이면 판정가 폴백.
   */
  quote?: () => { bid1: number; ask1: number; at: number } | null;
  /**
   * REST 현재가 폴백(2026-09-01) — WS 틱이 PRICE_STALE_MS 이상 끊겼을 때 청산 감시를 잇는다.
   * 실패·미주입이면 null(기존처럼 판정 정지 — 폴백이 없다는 사실은 이벤트로 남는다).
   */
  fetchRestPrice?: () => Promise<number | null>;
  /**
   * 이 종목의 최신 모델 판정(2026-09-02, 래칫 청산) — 스캐너가 매 봉 슬롯에 밀어 넣는 값(prob·판정 시각).
   * 모델 모드의 익절 보류(MODEL_TP_HOLD)가 익절 터치 순간 이걸 읽는다. 미주입·null이면 보류 없이 기존대로 판다.
   */
  modelVerdict?: () => { prob: number | null; at: number } | null;
  /** 정규장 판정(서킷 heartbeat 입력). */
  regularSession: (nowMs: number) => boolean;
  /** 매수가능금액 사전 조회(물타기 매수) — null/미지정/throw면 판정 없이 진행(fail-open). */
  fetchBuyableUsd?: (price: number) => Promise<number | null>;
  /** 진입 실측(우리가 산 포지션) — 입양이면 null. 정산 기록의 entryTs·entrySnapshot. */
  entry: { entryTs: number; entrySnapshot: SignalSnapshot } | null;
  /** 잔고에서 주워 온 포지션인가 — 인계 문구(등록/인계)용. */
  adopted: boolean;
  feeRate?: number;
  /** 비동기 발주 직전 최종 게이트 — false면 이번 매매를 시작하지 않는다(오토파일럿 Stop/FAULT/정산 완료). */
  mayStart?: () => boolean;
  onEvent?: (text: string) => void;
  /** OCO 전용 — 매수 다리 지연(ms, ADR 0002). */
  buyLegDelayMs?: number;
  /** OCO 전용 — 이 그리드 몫의 가용 현금(동시 그리드 수로 나눈 값). 조회 실패면 null(판정 생략). */
  fetchAvailableCash?: (buyPrice: number) => Promise<number | null>;
}

/**
 * 팩토리 — 모드에 맞는 어댑터를 만든다. 모드 판정은 resolvePositionMode, 규칙·설정 조립은 여기 — 오토파일럿은 어느 쪽도 모른다.
 * 규칙형은 seed가 있어야 규칙을 만들 수 있어 arm 시점에 규칙을 조립한다(arm 전에는 seed 없음).
 */
export function makePositionManager(
  mode: PositionMode,
  cfg: PositionManagementConfig,
  deps: PositionManagerDeps,
): PositionManager {
  switch (mode) {
    case 'martingale': {
      const mg = cfg.martingale!;
      const up = (mg.tpPct * 100).toFixed(0);
      const dn = (mg.stopLossPct * 100).toFixed(0);
      return new RulePositionManager(deps, {
        label: '±3% 관리',
        gauge: 'orders', // 위끝 = 익절 목표가(평단 +3%), 아래끝 = 손절선(평단 −3%).
        manualExitCheckMs: MANUAL_EXIT_CHECK_MS,
        build: (seed) => {
          const rule = new MartingaleRule(seed, { config: mg, clock: deps.clock });
          return {
            rule,
            priceExit: (price) => {
              const kind = rule.exitKind;
              if (kind === 'SESSION_END') {
                // line 없음 — 마감 청산은 가격 조건선이 아니라 시각 조건이다. 익절가를 넣으면
                // 슬리피지 계측(exitSnapshot.line 대비 체결가)이 왜곡된다(2026-09-01 수정).
                return { reason: 'SESSION_END' as ExitReason, text: '마감 청산 · 확장세션 마감 전이라 남은 수량을 전량 매도해요' };
              }
              if (kind === 'STOP_LOSS') {
                return {
                  reason: 'STOP_LOSS' as ExitReason,
                  text: `손절 · 현재가 ${price.toFixed(2)} ≤ 평단 −${dn}%(${rule.stopPrice.toFixed(2)}) — 물타기 없이 전량 매도해요`,
                  line: rule.stopPrice,
                };
              }
              return {
                reason: 'TAKE_PROFIT' as ExitReason,
                text: `익절 · 현재가 ${price.toFixed(2)} ≥ 평단 +${up}%(${rule.targetPrice.toFixed(2)}) — 전량 매도해요`,
                line: rule.targetPrice,
              };
            },
            armText: `${seed.qty}주 · 평단 ${seed.avgPrice.toFixed(2)} · 익절 ${rule.targetPrice.toFixed(2)}(+${up}%) · 손절 ${rule.stopPrice.toFixed(2)}(−${dn}%) — 물타기 없어요(2026-09-01) · ${Math.floor(mg.closeAtMin / 60)}:${String(mg.closeAtMin % 60).padStart(2, '0')} ET 마감 청산`,
          };
        },
      });
    }
    case 'model': {
      const model = cfg.model!;
      if (MODEL_EXIT_SYMMETRIC) {
        // ±3% 대칭 청산(2026-09-01) — 모델 라벨(+3% vs −3%, 120분)과 같은 기하. 물타기 없음.
        const up = (model.tpPct * 100).toFixed(0);
        const dn = (model.stopLossPct * 100).toFixed(0);
        return new RulePositionManager(deps, {
          label: '모델 ±3% 관리',
          gauge: 'orders', // 위끝 = 익절 목표가(평단 +3%), 아래끝 = 손절선(평단 −3%).
          manualExitCheckMs: MANUAL_EXIT_CHECK_MS,
          build: (seed) => {
            const entryAtMs = deps.entry?.entryTs ?? deps.clock.now();
            // 익절 보류+래칫(2026-09-02) — 보류 문턱은 model.json 동봉값(학습 분포 상위 10%). 구 모델 파일이거나
            // 판정 공급이 없으면(입양 등) hold 미주입 → 기존 ±3% 단일 밴드 그대로(fail-safe).
            const holdThr = MODEL_TP_HOLD ? loadModel().hold_threshold : undefined;
            const verdict = deps.modelVerdict;
            const rule = new ModelSymmetricExitRule(seed, {
              ...model,
              entryAtMs,
              clock: deps.clock,
              hold:
                holdThr !== undefined && Number.isFinite(holdThr) && verdict !== undefined
                  ? { threshold: holdThr, verdict }
                  : undefined,
            });
            const circuit = new CircuitExitRule(rule, { act: CIRCUIT_MODE });
            return {
              rule: circuit,
              circuit,
              priceExit: (price) => {
                const kind = rule.exitKind;
                if (kind === 'TIMEOUT') {
                  return {
                    reason: 'TIMEOUT' as ExitReason,
                    text: `시간 청산 · 진입 후 ${model.maxHoldMin}분이 지나 남은 수량을 전량 매도해요`,
                  };
                }
                if (kind === 'SESSION_END') {
                  return { reason: 'SESSION_END' as ExitReason, text: '장 마감 · 남은 수량을 전량 매도해요' };
                }
                if (kind === 'STOP_LOSS') {
                  // 래칫 뒤에는 하단이 평단 위일 수 있다(이익 잠금) — 문구는 밴드 기준으로 쓴다.
                  return {
                    reason: 'STOP_LOSS' as ExitReason,
                    text: `손절 · 현재가 ${price.toFixed(2)} ≤ 밴드 하단 ${rule.stopPrice.toFixed(2)}(앵커 −${dn}%${rule.rungs > 0 ? ` · 래칫 ${rule.rungs}계단` : ''}) — 전량 매도해요`,
                    line: rule.stopPrice,
                  };
                }
                return {
                  reason: 'TAKE_PROFIT' as ExitReason,
                  text: `익절 · 현재가 ${price.toFixed(2)} ≥ 밴드 상단 ${rule.targetPrice.toFixed(2)}(앵커 +${up}%${rule.rungs > 0 ? ` · 래칫 ${rule.rungs}계단 뒤 확률 꺾임` : ''}) — 전량 매도해요`,
                  line: rule.targetPrice,
                };
              },
              armText: `${seed.qty}주 · 평단 ${seed.avgPrice.toFixed(2)} · 익절 ${rule.targetPrice.toFixed(2)}(+${up}%) · 손절 ${rule.stopPrice.toFixed(2)}(−${dn}%) · 최장 ${model.maxHoldMin}분 보유 — 익절선에서 모델이 아직 좋으면(상위 10%) 팔지 않고 밴드를 +${up}% 위로 올려 달아요(래칫) · 물타기 없어요`,
            };
          },
        });
      }
      // 트레일 −5% + 하드 −2%(롤백 보존, 2026-08-24 청산 연구) — +5/−2 라벨 모델과 세트로만 의미가 있다.
      const trail = (model.trailPct * 100).toFixed(0);
      const dn = (MODEL_EXIT_CONFIG.stopLossPct * 100).toFixed(0); // 대칭 기하의 stopLossPct(0.03)와 필드가 겹쳐 상수를 직접 읽는다.
      return new RulePositionManager(deps, {
        label: '모델 관리',
        gauge: 'orders', // 게이지 위끝=진입 후 고점, 아래끝=지금 매도선. 추세와 달리 그릴 선이 있다.
        manualExitCheckMs: MANUAL_EXIT_CHECK_MS,
        build: (seed) => {
          // 청산은 백테스트 기하 그대로 — 트레일 −5% + 하드 손절 −2%, 익절 상한 없음. 물타기 없음.
          const entryAtMs = deps.entry?.entryTs ?? deps.clock.now();
          const rule = new ModelExitRule(seed, { trailPct: model.trailPct, stopLossPct: MODEL_EXIT_CONFIG.stopLossPct, entryAtMs, clock: deps.clock });
          // 서킷 데코레이터 — CIRCUIT_MODE=false면 관측(이벤트)만.
          const circuit = new CircuitExitRule(rule, { act: CIRCUIT_MODE });
          return {
            rule: circuit,
            circuit,
            priceExit: (price) => {
              const kind = rule.exitKind;
              // 매도선·고점은 판정 직후 값 — 슬리피지 계측(exitSnapshot.line)용. 매도 틱은 고점을 갱신하지 않으므로 판정 시점 값 그대로다.
              const line = rule.stopPrice;
              const peak = rule.peakPrice;
              if (kind === 'TRAIL') {
                return {
                  reason: 'TRAIL' as ExitReason,
                  text: `트레일링 매도 · 고점 ${peak.toFixed(2)} 대비 −${trail}%(${line.toFixed(2)})에 닿아 전량 매도해요`,
                  line,
                  peak,
                };
              }
              if (kind === 'SESSION_END') {
                return { reason: 'SESSION_END' as ExitReason, text: '장 마감 · 남은 수량을 전량 매도해요', peak };
              }
              return {
                reason: 'STOP_LOSS' as ExitReason,
                text: `손절선 도달 · 현재가 ${price.toFixed(2)} ≤ 평단 대비 −${dn}% — 전량 매도해요`,
                line,
                peak,
              };
            },
            armText: `${seed.qty}주 · 평단 ${seed.avgPrice.toFixed(2)} · 손절 ${rule.hardStopPrice.toFixed(
              2,
            )}(−${dn}%) · 오르면 고점 대비 −${trail}%로 매도선이 따라 올라가요 — 익절 상한·물타기 없어요`,
          };
        },
      });
    }
    case 'trend': {
      const trend = cfg.trend!;
      return new RulePositionManager(deps, {
        label: '추세 관리',
        gauge: 'dayRange',
        manualExitCheckMs: MANUAL_EXIT_CHECK_MS,
        stopLossPct: trend.stopLossPct,
        build: (seed) => {
          // 추세 → 그리드 → 매매 — 규칙은 추세 도메인(TrendExitRule): 분봉5선 꺾임에 전량 매도, 물타기 없음.
          const rule = new TrendExitRule(seed, { stopLossPct: trend.stopLossPct });
          // 서킷 데코레이터(2026-08-19) — CIRCUIT_MODE=false면 관측(이벤트)만, true면 서킷 상태에서 ma5 무시·정지 중 지정가 매도.
          const circuit = new CircuitExitRule(rule, { act: CIRCUIT_MODE });
          const stop = rule.stopLossPrice;
          return {
            rule: circuit,
            circuit,
            armText: `${seed.qty}주 · 평단 ${seed.avgPrice.toFixed(2)} — 종가가 분봉5선 아래로 닫히면 전량 매도해요(문턱 없음)${
              stop === null ? '' : ` · 손절선 ${stop.toFixed(2)}(−${(trend.stopLossPct * 100).toFixed(0)}%)`
            }`,
          };
        },
      });
    }
    case 'inflection': {
      const inflection = cfg.inflection!;
      return new RulePositionManager(deps, {
        label: '변곡점 그리드',
        gauge: 'orders',
        build: (seed) => {
          const grid = new ConditionalGrid({ position: seed, entryQty: seed.qty, config: inflection });
          const v = grid.view;
          return {
            rule: grid,
            armText: `${v.qty}주 · 평단 ${v.avgPrice.toFixed(2)} · 매도선 ${v.sellLine.toFixed(2)}(+${(inflection.sellProfitPct * 100).toFixed(1)}%) · 매수선 ${v.buyLine.toFixed(2)}(−${(inflection.buyDropPct * 100).toFixed(1)}%) — 주문은 변곡점 신호 때만 나가요`,
          };
        },
      });
    }
    case 'oco':
      return new OcoGridPositionManager(deps, cfg.grid!);
    default:
      throw new Error(`unknown position mode: ${String(mode satisfies never)}`);
  }
}

// ---------------------------------------------------------------------------
// 어댑터 1 — 규칙 + 매매 (추세 / 변곡점)
// ---------------------------------------------------------------------------

export interface RulePositionManagerOptions {
  label: string;
  gauge: 'orders' | 'dayRange';
  /** 수동청산(앱 밖 매도) 재확인 주기(ms) — 미지정이면 감지하지 않는다(변곡점 모드). */
  manualExitCheckMs?: number;
  /** 손절 % — 손절 틱 이벤트 문구용(없으면 0). */
  stopLossPct?: number;
  /**
   * seed(수량·평단)로 규칙을 조립한다 — arm 때 한 번. armText는 인계 이벤트 본문(종목·등록/인계 접두는 관리자가 붙인다).
   * priceExit은 **틱 판정(onPrice)이 매도를 결정했을 때** 청산 사유·문구를 정한다. 미지정이면 추세의
   * 손절선 문구(STOP_LOSS)를 쓴다 — 추세엔 틱 판정이 손절선 하나뿐이라 분기가 필요 없었다.
   */
  build: (seed: ConditionalPosition) => {
    rule: PositionRule;
    circuit?: CircuitExitRule;
    /** line·peak = 판정 시점 매도선·고점(있으면) — 정산 기록 exitSnapshot에 실려 슬리피지 계측의 기준이 된다. */
    priceExit?: (price: number) => { reason: ExitReason; text: string; line?: number; peak?: number };
    armText: string;
  };
}

export class RulePositionManager implements PositionManager {
  readonly ticker: string;
  readonly label: string;
  readonly restingOrders = false;
  private readonly deps: PositionManagerDeps;
  private readonly opts: RulePositionManagerOptions;
  private rule: PositionRule | null = null;
  private circuit: CircuitExitRule | undefined;
  /** 틱 판정 매도의 사유·문구 결정자(모드별) — build가 준다. 없으면 추세의 손절선 문구. */
  private priceExit: ((price: number) => { reason: ExitReason; text: string; line?: number; peak?: number }) | undefined;

  private exec: Execution | null = null;
  private execSide: 'buy' | 'sell' | null = null;
  /** 매매 시작(비동기 발주)이 진행 중 — 같은 종목에 두 번 걸지 않기 위한 가드. */
  private starting = false;
  /** 진행 중 매도를 시작한 사유 — 정산 기록의 exitReason. 매도가 끝나거나 취소되면 null. */
  private pendingExitReason: ExitReason | null = null;
  /** 매도를 결정한 순간의 스냅샷(판정가·매도선·고점·시각) — 정산 기록 exitSnapshot. 슬리피지 계측(2026-08-26). */
  private pendingExitSnapshot: SignalSnapshot | null = null;
  private _isolated: string | null = null;
  private released = false;
  /** 다음 잔고 재확인 시각(ms)과 연속 "잔고 없음" 관측 수(2회 연속이어야 MANUAL). undefined면 감지 안 함. */
  private manualCheckAt: number | undefined;
  private manualMisses = 0;

  /** 진입(인계) 후 최고/최저 체결가(2026-09-02, 게이지 마커) — arm 때 평단으로 시작, 틱·게이지 조회 때 갱신. */
  private sinceEntryHigh: number | null = null;
  private sinceEntryLow: number | null = null;

  // ── 청산 발주 거절 재시도(2026-09-01) ──
  /** 이 시각 전에는 새 청산 매도를 시작하지 않는다(거절 백오프). */
  private exitRetryNotBefore = 0;
  /** 연속 청산 발주 거절 수(성공·체결이 나면 0). 백오프 지수의 밑. */
  private exitFailStreak = 0;
  /** 청산 발주 실패 이벤트 마지막 기록 시각(스로틀). */
  private lastExitFailLogAt = Number.NEGATIVE_INFINITY;
  /** 발주 거절 + 잔고 없음으로 확정된 외부 청산 — 다음 폴이 sold로 회수한다. */
  private pendingExternalExit: TradeRecord | null = null;

  // ── 시세 정지 REST 폴백(2026-09-01) ──
  /** 다음 REST 현재가 조회 허용 시각(ms). */
  private nextRestProbeAt = 0;
  /** 시세 정지 안내를 이미 냈는가 — 살아나면 리셋(복구도 알린다). */
  private staleNoticed = false;

  constructor(deps: PositionManagerDeps, opts: RulePositionManagerOptions) {
    this.deps = deps;
    this.opts = opts;
    this.ticker = deps.ticker;
    this.label = opts.label;
  }

  /** 테스트·단독 사용 — 규칙을 직접 꽂아 만든다(팩토리의 build 대신). */
  static withRule(deps: PositionManagerDeps, rule: PositionRule, opts: Omit<RulePositionManagerOptions, 'build'> & { circuit?: CircuitExitRule }): RulePositionManager {
    const pm = new RulePositionManager(deps, { ...opts, build: () => ({ rule, circuit: opts.circuit, armText: '' }) });
    pm.rule = rule;
    pm.circuit = opts.circuit;
    pm.manualCheckAt = opts.manualExitCheckMs === undefined ? undefined : deps.clock.now() + opts.manualExitCheckMs;
    return pm;
  }

  async arm(seed: ConditionalPosition | null): Promise<ArmResult> {
    if (!seed || seed.qty <= 0 || !(seed.avgPrice > 0)) {
      return { ok: false, reason: `포지션을 확인할 수 없어 ${this.label}를 시작하지 못했어요` };
    }
    const built = this.opts.build(seed);
    this.rule = built.rule;
    this.circuit = built.circuit;
    this.priceExit = built.priceExit;
    this.sinceEntryHigh = seed.avgPrice;
    this.sinceEntryLow = seed.avgPrice;
    this.manualCheckAt =
      this.opts.manualExitCheckMs === undefined ? undefined : this.deps.clock.now() + this.opts.manualExitCheckMs;
    this.event(`${this.label} ${this.deps.adopted ? '등록' : '인계'} · ${built.armText}`);
    return { ok: true };
  }

  // ---- 읽기 ----

  get view(): ConditionalGridView {
    return this.ruleOrThrow().view;
  }

  /** 진입 후 최고/최저 갱신 — 틱(1초)과 게이지 조회(고빈도 폴) 양쪽에서 부른다. */
  private trackExtremes(price: number | null | undefined): void {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return;
    if (this.sinceEntryHigh === null || price > this.sinceEntryHigh) this.sinceEntryHigh = price;
    if (this.sinceEntryLow === null || price < this.sinceEntryLow) this.sinceEntryLow = price;
  }

  gaugeView(): PositionGaugeView {
    const v = this.ruleOrThrow().view;
    const pv = this.deps.price();
    this.trackExtremes(pv?.price);
    // 추세 관리는 주문선이 없다(sellLine=buyLine=평단) — 양끝을 오늘 최저·최고(틱 HIGH/LOW)로 대신 그린다.
    // 고저가 아직 없으면 평단으로 폴백(게이지가 평단 한 점으로 접힌다 — 첫 틱이 오면 펴진다).
    const dayRange = this.opts.gauge === 'dayRange';
    return {
      avgPrice: v.avgPrice,
      buyPrice: dayRange ? Math.min(pv?.dayLow ?? v.avgPrice, v.avgPrice) : v.buyLine,
      sellPrice: dayRange ? Math.max(pv?.dayHigh ?? v.avgPrice, v.avgPrice) : v.sellLine,
      rangeKind: dayRange ? 'dayRange' : 'orders',
      currentPrice: pv?.price ?? null,
      holdingQty: v.qty,
      buyMultiplier: 1,
      gridActive: true,
      buyLegStatus: 'full',
      sinceEntryHigh: this.sinceEntryHigh ?? undefined,
      sinceEntryLow: this.sinceEntryLow ?? undefined,
    };
  }

  get busy(): boolean {
    return this.exec !== null || this.starting;
  }

  get isolated(): boolean {
    return this._isolated !== null;
  }

  get faultText(): string | null {
    return this._isolated;
  }

  // ---- 입력 ----

  /**
   * 봉 마감 신호 1개 판정 — 문턱을 넘긴 신호만 매매로 넘어간다.
   * 매매가 진행 중이면 새 판단을 받지 않는다(주문은 항상 1개 — 매매 도메인 문서 §3).
   */
  onSignal(signal: Signal, price: number): void {
    if (!this.rule || this.isolated || this.released || this.busy) return;
    const decision = this.rule.decide(signal, price);
    if (!decision) return;
    this.begin(decision, price, decision.side === 'sell' ? 'SELL_SIGNAL' : null);
  }

  /**
   * 사용자 요청 전량 매도 — 규칙 판정을 건너뛰고 보유 수량 전부를 매매로 넘긴다(2026-08-22).
   * 게이트는 자동 경로와 같다(격리·해제·매매 중이면 안 받는다). 수량은 **전량**이며 문턱·취소선은 없다.
   */
  sellNow(price: number): boolean {
    if (!this.rule || this.isolated || this.released || this.busy) return false;
    const qty = this.rule.view.qty;
    if (!(qty > 0) || !Number.isFinite(price) || price <= 0) return false;
    this.event(`사용자 요청 · 전량 ${qty}주 매도를 시작해요 — 체결될 때까지 매수1호가로 따라가요`);
    this.begin({ side: 'sell', qty }, price, 'USER_SELL');
    return true;
  }

  /**
   * 매초 틱 — 서킷 heartbeat(매매 유무와 무관) → 진행 중 매매 추격 → (매매가 없고 canStart면) 손절 틱 판정.
   * canStart=false(오토파일럿이 RUNNING이 아님)면 새 매매는 시작하지 않고 진행 중 매매 추격만 한다.
   */
  async tick(opts: { canStart: boolean }): Promise<void> {
    if (!this.rule || this.isolated) return;
    const view = this.deps.price();
    const canStart = opts.canStart && !this.released;
    if (this.circuit && view) {
      const nowMs = this.deps.clock.now();
      const hb = this.circuit.heartbeat({
        nowMs,
        price: view.price,
        lastTradeAt: view.lastTradeAt,
        regularSession: this.deps.regularSession(nowMs),
      });
      for (const ev of hb.events) this.event(circuitEventText(ev));
      if (hb.events.some((ev) => ev.kind === 'HALT') && this.manualCheckAt !== undefined) this.manualCheckAt = 0; // 정지 감지 → 잔고 재확인 앞당김(수동 매도 인지).
      if (hb.decision && view.price !== null && !this.busy && canStart) {
        this.begin(hb.decision, view.price, hb.reason === 'CIRCUIT' ? 'CIRCUIT' : 'STOP_LOSS');
        return;
      }
    }
    // 판정가 — WS 틱이 살아 있으면 그대로(동기 — 여기서 await를 넣으면 폴과의 인터리빙이 바뀌어
    // Execution.busy에 걸린다), 정지 상태(stale)일 때만 REST 현재가로 잇는다(2026-09-01 stale guard).
    const now = this.deps.clock.now();
    const live =
      view !== null && view.price !== null && view.lastTradeAt !== null && now - view.lastTradeAt <= PRICE_STALE_MS;
    let price: number | null;
    if (live) {
      if (this.staleNoticed) {
        this.staleNoticed = false;
        this.event('실시간 시세가 다시 들어와요 — REST 감시를 끝내고 틱 기준으로 돌아가요');
      }
      price = view.price;
    } else if (!this.deps.fetchRestPrice) {
      price = view?.price ?? null; // 폴백 미배선(옛 하네스) — 기존 동작 그대로(낡은 틱이라도 쓴다).
    } else {
      price = await this.probeRestPrice(now);
    }
    this.trackExtremes(price);
    if (this.exec !== null) {
      // 진행 중 매도 추격은 매수1호가로 — 급락 중 체결가는 호가 위라 지정가가 안 붙는다(진입의 매도1호가 크로스와 대칭).
      if (price !== null) await this.exec.onPrice(this.execSide === 'sell' ? this.exitOrderPrice(price) : price);
      return;
    }
    // 틱 판정 — 매매가 없을 때만. 신호 경로(onSignal)와 같은 게이트·점유 규칙.
    // 추세는 손절선 하나, 모델은 익절·손절·시간 세 갈래다(사유·문구는 build가 준 priceExit이 정한다).
    if (!this.busy && canStart && price !== null && this.deps.clock.now() >= this.exitRetryNotBefore) {
      const decision = this.rule.onPrice?.(price) ?? null;
      if (decision) {
        const exit = this.priceExit?.(price) ?? {
          reason: 'STOP_LOSS' as ExitReason,
          text: `손절선 도달 · 현재가 ${price.toFixed(2)} ≤ 평단 대비 −${((this.opts.stopLossPct ?? 0) * 100).toFixed(0)}% — 봉 마감을 기다리지 않고 전량 매도해요`,
        };
        this.event(exit.text);
        this.begin(decision, price, exit.reason, { line: exit.line, peak: exit.peak });
      }
    }
  }

  /**
   * 시세 정지(stale) 시 REST 현재가 폴백 — REST_PRICE_PROBE_MS 간격으로만 조회하고, 진입·복구를 이벤트로
   * 알린다. 2026-08-28 전 종목 구독 거절 실사고가 보유 중에 나면 청산이 통째로 멈추던 구멍(2026-09-01).
   */
  private async probeRestPrice(now: number): Promise<number | null> {
    if (now < this.nextRestProbeAt) return null; // 조회 간격 사이 — 낡은 틱으로 판정하지 않는다.
    this.nextRestProbeAt = now + REST_PRICE_PROBE_MS;
    let rest: number | null = null;
    try {
      rest = (await this.deps.fetchRestPrice?.()) ?? null;
    } catch {
      rest = null;
    }
    if (!this.staleNoticed) {
      this.staleNoticed = true;
      this.event(
        rest !== null && rest > 0
          ? `실시간 시세가 끊겼어요 — REST 현재가(${rest.toFixed(2)})로 익절·손절 감시를 이어가요`
          : '실시간 시세가 끊겼고 REST 현재가도 못 받았어요 — 청산 판정이 멈춰 있어요, 계좌를 확인해 주세요',
      );
    }
    return rest !== null && Number.isFinite(rest) && rest > 0 ? rest : null;
  }

  /** 청산 매도 발주·추격가 — 신선한 매수1호가(bid1)가 있으면 크로스, 없으면 판정가 그대로. */
  private exitOrderPrice(fallback: number): number {
    const q = this.deps.quote?.() ?? null;
    if (q !== null && q.bid1 > 0 && this.deps.clock.now() - q.at <= EXIT_QUOTE_STALE_MS) return q.bid1;
    return fallback;
  }

  /** 주기 폴 — 진행 중 매매의 체결/취소를 확정한다. 매매가 없으면 수동청산 재확인만. */
  async poll(): Promise<PositionPollResult> {
    if (this.isolated) return { kind: 'isolated', reason: this._isolated! };
    if (!this.rule) return { kind: 'holding' };
    if (this.pendingExternalExit !== null) {
      // 발주 거절 + 잔고 없음 — 앱 밖에서 이미 청산된 포지션이다(2026-09-01). 재시도 없이 정산으로 회수한다.
      const record = this.pendingExternalExit;
      this.pendingExternalExit = null;
      return { kind: 'sold', record };
    }
    const exec = this.exec;
    if (!exec) return this.checkManualExit();
    const r = await exec.poll();
    switch (r.kind) {
      case 'fault':
        return this.isolate(r.reason);
      case 'cancelled': {
        const side = this.execSide ?? exec.side;
        const snap = this.pendingExitSnapshot;
        this.clearExec();
        this.event(
          `${side === 'sell' ? '매도' : '매수'} 추격 취소 · 평단 대비 문턱이 깨져 다음 판정을 기다려요${
            r.result.filledQty > 0 ? ` (부분 체결 ${r.result.filledQty}주 반영)` : ''
          }`,
        );
        if (r.result.filledQty > 0) return this.refreshPosition(side, r.result, side === 'sell' ? 'SELL_SIGNAL' : null, snap);
        return { kind: 'holding' };
      }
      case 'done': {
        const side = this.execSide ?? exec.side;
        const reason = this.pendingExitReason ?? 'SELL_SIGNAL';
        const snap = this.pendingExitSnapshot;
        this.clearExec();
        if (side === 'sell') return this.settleSell(r.result, reason, snap);
        const refreshed = await this.refreshPosition(side, r.result, null, null);
        if (refreshed.kind !== 'holding') return refreshed;
        const v = this.rule.view;
        this.event(`매수 체결 · ${r.result.filledQty}주 · 평단 $${v.avgPrice.toFixed(2)} · ${v.qty}주 보유`);
        return { kind: 'holding' };
      }
      default:
        return { kind: 'holding' };
    }
  }

  /** 관리를 놓는다 — 추격 중이던 매매 주문은 최선껏 취소(결과는 기다리지 않는다), 이후 새 매매는 시작하지 않는다. */
  release(): void {
    this.released = true;
    void this.exec?.release();
  }

  // ---- 내부 ----

  private ruleOrThrow(): PositionRule {
    if (!this.rule) throw new Error(`${this.ticker} 포지션 관리자가 아직 인계되지 않았어요(arm 전)`);
    return this.rule;
  }

  /** 슬롯 점유(starting)를 동기로 먼저 확정하고 발주는 비동기로 — 발주 중 겹친 신호가 이중 매매가 되지 않게. */
  private begin(
    decision: ConditionalDecision,
    price: number,
    exitReason: ExitReason | null,
    exitInfo: { line?: number; peak?: number } = {},
  ): void {
    this.starting = true;
    this.pendingExitReason = decision.side === 'sell' ? exitReason : null;
    // 매도 결정 순간을 남긴다 — 체결가와의 차이(슬리피지)·지연이 여기서 잰다. 매수(물타기)는 기록하지 않는다.
    this.pendingExitSnapshot =
      decision.side === 'sell'
        ? {
            price,
            slope: 0,
            accel: 0,
            ts: this.deps.clock.now(),
            ...(exitInfo.line !== undefined ? { line: exitInfo.line } : {}),
            ...(exitInfo.peak !== undefined ? { peak: exitInfo.peak } : {}),
            ...(exitReason !== null ? { kind: exitReason } : {}),
          }
        : null;
    void this.startExec(decision, price);
  }

  /** 매매 개시 — 물타기 매수는 현금 사전 판정을 거친다(조회 실패는 통과 — fail-open, 기존 원칙). */
  private async startExec(decision: ConditionalDecision, price: number): Promise<void> {
    const rule = this.rule!;
    try {
      if (decision.side === 'buy') {
        const needed = decision.qty * price;
        let buyable: number | null = null;
        try {
          buyable = (await this.deps.fetchBuyableUsd?.(price)) ?? null;
        } catch {
          buyable = null;
        }
        if (buyable !== null && buyable < needed) {
          this.event(`매수 생략 · 현금 부족(필요 $${needed.toFixed(2)} > 주문가능 $${buyable.toFixed(2)}) — 다음 판정을 기다려요`);
          return;
        }
      }
      if (this.isolated || this.released || (this.deps.mayStart && !this.deps.mayStart())) return;
      // 서킷 매도(정지 중 지정가): 시작가는 결정의 limitPrice, 추격은 정지 뒤 첫 체결이 관측된 뒤에만(chaseGate).
      const limit = decision.side === 'sell' && decision.limitPrice !== undefined ? decision.limitPrice : null;
      const chaseAfter = decision.side === 'sell' ? (decision.chaseAfterTradeAt ?? null) : null;
      const exec = new Execution({
        port: createExecutionPort(this.deps.broker, this.ticker),
        clock: this.deps.clock,
        side: decision.side,
        qty: decision.qty,
        // 취소선 — 규칙의 문턱 부정을 술어로 주입한다(매매는 판단하지 않는다).
        shouldAbort: (p) => rule.shouldAbort(decision.side, p),
        chaseGate: chaseAfter === null ? undefined : () => (this.deps.price()?.lastTradeAt ?? 0) > chaseAfter,
      });
      // 매도 시작가 = 매수1호가 크로스(신선할 때) — 진입(매도1호가 크로스)과 대칭. 청산 슬리피지 실측의 구조 원인 수정(2026-09-01).
      await exec.start(limit ?? (decision.side === 'sell' ? this.exitOrderPrice(price) : price));
      if (exec.state === 'FAULT') {
        this.pendingExitReason = null; // 손절·서킷 매도가 발주에 실패하면 다음 틱이 다시 판정한다.
        if (decision.side === 'sell') {
          await this.handleExitPlacementFailure(exec.faultText ?? '주문 거절', price);
        } else {
          this.event(`매수 발주 실패 · ${exec.faultText ?? '주문 거절'} — 다음 신호에서 다시 시도해요`);
        }
        return;
      }
      this.exitFailStreak = 0;
      this.exitRetryNotBefore = 0;
      this.exec = exec;
      this.execSide = decision.side;
      this.event(
        `${decision.side === 'sell' ? '전량 매도' : '매수'} 매매 시작 · ${decision.qty}주 @ ${(exec.orderPrice ?? price).toFixed(2)} ${
          limit !== null ? '(정지 중 지정가 · 재개 단일가에 소화, 미체결이면 재개 뒤 추격)' : decision.side === 'sell' ? '(매수1호가 추격)' : '(현재가 추격)'
        }`,
      );
    } finally {
      this.starting = false;
    }
  }

  private clearExec(): void {
    this.exec = null;
    this.execSide = null;
    this.pendingExitReason = null;
    this.pendingExitSnapshot = null;
  }

  /**
   * 청산 매도 발주 거절 처리(2026-09-01) — 예전엔 이벤트 한 줄 뒤 다음 틱(1초)마다 무한 재발주였다.
   *  ① 잔고를 즉시 확인한다 — 보유가 없으면(앱 밖 매도·전량 체결 미인지가 거절 원인) 재시도 대신
   *     외부 청산(MANUAL)으로 정산을 예약한다(2026-09-01 사용자 확정: "보유하지 않은 건 판매 완료로 인식").
   *  ② 보유가 그대로면 백오프(10초, 연속 거절마다 2배, 최대 60초) 뒤 다음 틱 판정이 다시 시도한다.
   *     세션 간극(주문 API가 닫힌 ET 20~21시·03~04시)의 연속 거절은 정상이라 격리(FAULT)로 올리지 않는다.
   *  ③ 이벤트는 첫 실패 즉시, 반복은 10분에 1번(로그 스팸 방지).
   */
  private async handleExitPlacementFailure(reason: string, price: number): Promise<void> {
    this.exitFailStreak += 1;
    const backoff = Math.min(EXIT_RETRY_BASE_MS * 2 ** (this.exitFailStreak - 1), EXIT_RETRY_MAX_MS);
    const now = this.deps.clock.now();
    this.exitRetryNotBefore = now + backoff;
    // 잔고 확인 — 조회 실패(throw)는 판단하지 않는다(백오프 후 재시도). "행 없음(null)"만 이미 정리됨의 근거다.
    let checked = false;
    let pos: ConditionalPosition | null = null;
    try {
      pos = await this.deps.broker.fetchPosition();
      checked = true;
    } catch {
      checked = false;
    }
    if (checked && (pos === null || pos.qty <= 0)) {
      const v = this.rule!.view;
      this.pendingExternalExit = makeTradeRecord({
        ticker: this.ticker,
        qty: v.qty,
        entryPrice: v.avgPrice,
        exitPrice: price > 0 ? price : v.avgPrice,
        entry: this.deps.entry,
        exitReason: 'MANUAL',
        feeRate: this.deps.feeRate,
        now,
      });
      this.event(`매도 발주가 거절됐고 잔고에도 없어요 — 앱 밖에서 이미 정리된 것으로 보고 정산해요 (사유: ${reason})`);
      return;
    }
    if (this.exitFailStreak === 1 || now - this.lastExitFailLogAt >= EXIT_FAIL_LOG_THROTTLE_MS) {
      this.lastExitFailLogAt = now;
      this.event(`매도 발주 실패 · ${reason} — ${Math.round(backoff / 1000)}초 뒤 다시 시도해요 (연속 ${this.exitFailStreak}회)`);
    }
  }

  /**
   * 체결/부분 체결 후 포지션 갱신 — 정본은 KIS 잔고(fetchPosition), 폴백은 체결 합산(가중평균).
   * 잔고가 0이면(취소 전 부분 매도가 사실상 전량) 정산 경로로 넘긴다.
   */
  private async refreshPosition(
    side: 'buy' | 'sell',
    result: ExecutionResult,
    exitReason: ExitReason | null,
    exitSnapshot: SignalSnapshot | null = null,
  ): Promise<PositionPollResult> {
    const rule = this.rule!;
    const prev = rule.view;
    // 체결가 미실측 폴백 — 현재가(슬롯) 우선, 없으면 조건선. 추세 규칙은 조건선=평단이라 현재가가 없으면 손익 0으로 남는다.
    const fillPrice = result.fillPrice ?? this.deps.price()?.price ?? (side === 'buy' ? prev.buyLine : prev.sellLine);
    const merged: ConditionalPosition =
      side === 'buy'
        ? {
            qty: prev.qty + result.filledQty,
            avgPrice: (prev.qty * prev.avgPrice + result.filledQty * fillPrice) / (prev.qty + result.filledQty),
          }
        : { qty: prev.qty - result.filledQty, avgPrice: prev.avgPrice };
    const pos = await this.fetchPosition();
    const next = pos && pos.qty > 0 && pos.avgPrice > 0 ? pos : merged;
    if (next.qty <= 0) return this.settleSell(result, exitReason ?? 'SELL_SIGNAL', exitSnapshot);
    rule.setPosition(next);
    return { kind: 'holding' };
  }

  /**
   * 매도 정산 — 평단→체결가 손익으로 TradeRecord를 합성한다.
   * 추론 체결(체결가 미실측)은 잔고로 먼저 검증한다 — 세션 일괄 취소가 "목록 부재→전량체결"로
   * 오판되면 없는 매도를 정산하고 관리를 놓게 되므로(Grid의 일괄 취소 방어와 같은 이유).
   */
  private async settleSell(
    result: ExecutionResult,
    exitReason: ExitReason,
    exitSnapshot: SignalSnapshot | null = null,
  ): Promise<PositionPollResult> {
    const v = this.rule!.view;
    if (!result.priceConfirmed) {
      const pos = await this.fetchPosition();
      if (pos !== null && pos.qty >= v.qty) {
        return this.isolate('매도 체결로 추론됐지만 잔고가 그대로예요 — 일괄 취소 의심, 계좌를 확인해 주세요');
      }
    }
    const record = makeTradeRecord({
      ticker: this.ticker,
      qty: result.filledQty > 0 ? result.filledQty : v.qty,
      entryPrice: v.avgPrice,
      exitPrice: result.fillPrice ?? this.deps.price()?.price ?? v.sellLine,
      entry: this.deps.entry,
      exitReason,
      exitSnapshot,
      feeRate: this.deps.feeRate,
      now: this.deps.clock.now(),
    });
    return { kind: 'sold', record };
  }

  /**
   * 외부(수동·한투앱) 청산 인지 — 매매가 없을 때 주기적으로 잔고를 재확인해, 2회 연속 "보유 없음"이면
   * MANUAL 사유로 정산한다(서킷 도메인 문서 §6). 1회로 끊지 않는 이유: 진입 직후 잔고 반영 지연·조회 일시 실패.
   * 체결가는 주문체결내역(TTTS3035R)이 일부 계좌에서 APTR0058로 거절되므로(kis/nccs.ts) 마지막 현재가로 기록한다.
   */
  private async checkManualExit(): Promise<PositionPollResult> {
    if (this.manualCheckAt === undefined || this.starting || this.released) return { kind: 'holding' };
    const now = this.deps.clock.now();
    if (now < this.manualCheckAt) return { kind: 'holding' };
    this.manualCheckAt = now + (this.opts.manualExitCheckMs ?? 0);
    let pos: ConditionalPosition | null;
    try {
      pos = await this.deps.broker.fetchPosition();
    } catch {
      return { kind: 'holding' }; // 조회 실패는 판단하지 않는다(다음 주기).
    }
    const rule = this.rule!;
    if (pos !== null && pos.qty > 0) {
      this.manualMisses = 0;
      if (pos.avgPrice > 0 && pos.qty !== rule.view.qty) rule.setPosition(pos); // 외부 부분 매도·추가 매수 반영.
      return { kind: 'holding' };
    }
    this.manualMisses += 1;
    if (this.manualMisses < 2) return { kind: 'holding' };
    if (this.busy || this.released) return { kind: 'holding' };
    const v = rule.view;
    const exitPrice = this.deps.price()?.price ?? v.avgPrice;
    const record = makeTradeRecord({
      ticker: this.ticker,
      qty: v.qty,
      entryPrice: v.avgPrice,
      exitPrice,
      entry: this.deps.entry,
      exitReason: 'MANUAL',
      feeRate: this.deps.feeRate,
      now: this.deps.clock.now(),
    });
    this.event(`잔고에서 사라졌어요 — 앱 밖(수동) 매도로 보고 정산해요 · 체결가 미확인(현재가 ${exitPrice.toFixed(2)} 기준 기록)`);
    return { kind: 'sold', record };
  }

  private async fetchPosition(): Promise<ConditionalPosition | null> {
    try {
      return await this.deps.broker.fetchPosition();
    } catch {
      return null;
    }
  }

  private isolate(reason: string): PositionPollResult {
    this._isolated = reason;
    return { kind: 'isolated', reason };
  }

  private event(text: string): void {
    this.deps.onEvent?.(`${this.ticker} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// 어댑터 2 — OCO 매도그리드 (core/grid, 롤백 보존 · ADR 0002)
// ---------------------------------------------------------------------------

export class OcoGridPositionManager implements PositionManager {
  readonly ticker: string;
  readonly label = '그리드';
  private readonly deps: PositionManagerDeps;
  private readonly cfg: GridExitConfig;
  private readonly grid: Grid;
  private armed = false;
  private _isolated: string | null = null;

  constructor(deps: PositionManagerDeps, cfg: GridExitConfig) {
    this.deps = deps;
    this.ticker = deps.ticker;
    // ★ 여기서 읽는 값이 이 그리드의 폭·배율로 고정된다(Grid 생성자가 캡처) — 설정 변경은 다음 그리드부터.
    this.cfg = { buyWidth: cfg.buyWidth, sellWidth: cfg.sellWidth, buyMultiplier: cfg.buyMultiplier };
    this.grid = new Grid({
      port: createGridOrderPort(deps.broker, deps.ticker),
      clock: deps.clock,
      config: this.cfg,
      // 조회 실패(null/throw)는 그리드가 판정 생략으로 처리한다(주문 거절은 rejected 격리가 받는다).
      fetchAvailableCash: async (buyPrice) => (await deps.fetchAvailableCash?.(buyPrice)) ?? null,
      // 급락 방어 — 매수 다리는 잠깐 쉬었다가 min(평단, 현재가) 앵커로(ADR 0002). 입양 포지션(slot=null)은 현재가가 없어 평단 앵커로 폴백.
      buyLegDelayMs: deps.buyLegDelayMs ?? 0,
      getCurrentPrice: () => deps.price()?.price ?? null,
    });
  }

  /** 진입 체결(폴백) 또는 잔고(D1)에서 평단·수량을 읽어 두 지정가를 건다. FAULT면 실패 사유를 돌려준다. */
  async arm(seed: ConditionalPosition | null): Promise<ArmResult> {
    await this.grid.arm(seed ?? undefined);
    if (this.grid.state === 'FAULT') return { ok: false, reason: this.grid.faultText ?? '그리드 발주 실패' };
    this.armed = true;
    const v = this.grid.view;
    const delay = this.deps.buyLegDelayMs ?? 0;
    const buyText =
      v.buyLegStatus === 'pending'
        ? `매수 ${Math.round(delay / 1000)}초 뒤 현재가 기준 −${(this.cfg.buyWidth * 100).toFixed(1)}%`
        : `매수 $${v.buyPrice}(−${(this.cfg.buyWidth * 100).toFixed(1)}%)`;
    this.event(
      `그리드 관리 ${this.deps.adopted ? '등록' : '인계'} · ${v.holdingQty}주 · 평단 $${v.avgPrice.toFixed(2)} · ${buyText} · 매도 $${v.sellPrice}(+${(this.cfg.sellWidth * 100).toFixed(1)}%)`,
    );
    return { ok: true };
  }

  gaugeView(): PositionGaugeView {
    const v = this.grid.view;
    return {
      avgPrice: v.avgPrice,
      buyPrice: v.buyPrice,
      sellPrice: v.sellPrice,
      currentPrice: this.deps.price()?.price ?? null,
      holdingQty: v.holdingQty,
      buyMultiplier: v.buyMultiplier,
      gridActive: v.gridActive,
      buyLegStatus: v.buyLegStatus,
    };
  }

  get busy(): boolean {
    return false;
  }

  /** 두 지정가가 계좌에 쉬고 있다 — Stop은 사이클 완주를 기다린다(옛 경로 그대로). */
  get restingOrders(): boolean {
    return this.armed;
  }

  get isolated(): boolean {
    return this._isolated !== null;
  }

  get faultText(): string | null {
    return this._isolated;
  }

  /** OCO는 신호를 보지 않는다 — 청산은 오직 +w 지정가 체결로만(D5). */
  onSignal(): void {}

  /** 틱 판정 없음 — 주문이 이미 걸려 있다. */
  async tick(): Promise<void> {}

  /** 매도 체결→정산, 매수 체결→리브래킷(이벤트), fault→격리. */
  async poll(): Promise<PositionPollResult> {
    if (this.isolated) return { kind: 'isolated', reason: this._isolated! };
    if (!this.armed) return { kind: 'holding' };
    return this.mapResult(await this.grid.poll());
  }

  /**
   * 세션 전환(정규장↔주간거래) — ARMED 그리드의 미체결 두 다리를 새 세션 API 계열로 재등록한다. KIS는 세션이 끝나면
   * 미체결을 일괄 취소하므로 옛 주문을 그대로 두면 ① 체결될 수 없는 주문을 하염없이 기다리고 ② "목록 부재→전량체결" 오판이 난다.
   * 재등록 전에 폴 1회로 경계 직전 체결을 먼저 정산한다(방금 난 체결을 취소·재발주로 덮지 않게).
   */
  async rotateSession(label: string): Promise<PositionPollResult | null> {
    if (!this.armed || this.isolated) return null;
    const polled = await this.poll();
    if (polled.kind !== 'holding' || this.grid.state !== 'ARMED') return polled;
    this.event(`세션 전환(${label}) — 그리드 주문을 새 세션으로 재등록해요`);
    return this.mapResult(await this.grid.reissueBrackets());
  }

  /** 쉬는 지정가는 취소하지 않는다(옛 경로 그대로 — Stop 문구가 "계좌에 남아 있어요"로 안내). */
  release(): void {}

  private mapResult(result: GridPollResult): PositionPollResult {
    switch (result.kind) {
      case 'sold':
        return {
          kind: 'sold',
          record: makeTradeRecord({
            ticker: this.ticker,
            qty: result.qty,
            entryPrice: result.avgPrice,
            exitPrice: result.exitPrice,
            entry: this.deps.entry,
            exitReason: 'SELL_SIGNAL',
            feeRate: this.deps.feeRate,
            now: this.deps.clock.now(),
          }),
        };
      case 'rebracket': {
        const v = this.grid.view;
        const head = result.cause === 'reissue' ? '그리드 주문 재등록' : '그리드 리브래킷';
        this.event(
          `${head} · 평단 $${result.position.avgPrice.toFixed(2)} · ${result.position.qty}주${
            v.buyLegStatus === 'reduced'
              ? ' · 현금에 맞춰 매수 수량을 줄였어요'
              : v.buyLegStatus === 'skippedCash'
                ? ' · 현금이 부족해 매수는 생략하고 매도만 걸었어요'
                : v.buyLegStatus === 'rejected'
                  ? ' · 매수 주문이 거절돼 매도만 걸었어요'
                  : v.buyLegStatus === 'pending'
                    ? ` · 매수는 ${Math.round((this.deps.buyLegDelayMs ?? 0) / 1000)}초 뒤 현재가 기준으로 걸어요`
                    : ''
          }`,
        );
        return { kind: 'holding' };
      }
      case 'rebracketDeferred':
        // FAULT가 아니다 — 세션 간극(주문 API 닫힘)이 흔한 원인이라 그리드가 스스로 재시도한다.
        this.event(`그리드 재발주가 접수되지 않았어요 — ${result.reason} · ${REBRACKET_RETRY_MS / 1000}초 후 다시 시도해요`);
        return { kind: 'holding' };
      case 'fault':
        this._isolated = result.reason;
        return { kind: 'isolated', reason: result.reason };
      default:
        return { kind: 'holding' };
    }
  }

  private event(text: string): void {
    this.deps.onEvent?.(`${this.ticker} ${text}`);
  }
}

/** 서킷 관측 이벤트 문구 — 관측 단계(CIRCUIT_MODE=false)의 핵심 산출물이라 수치를 다 적는다(plan §5 미결 검증용). */
export function circuitEventText(ev: CircuitEvent): string {
  switch (ev.kind) {
    case 'HALT': {
      const r = ev.record;
      const dir = r.dir > 0 ? '상킷' : r.dir < 0 ? '하킷' : '보합';
      const win = r.windowSec === null ? '첫 정지' : `재개 창 ${r.windowSec.toFixed(0)}초`;
      return `정지 감지 #${ev.count} · ${dir} · 직전가 ${r.price.toFixed(2)} · ${win} · 직전 3분 체결 ${ev.activeTicks}건 · 하킷 연속 ${ev.consecutiveDown}${
        ev.inCircuit ? ' · 서킷 상태(ma5 청산 보류)' : ''
      }`;
    }
    case 'RESUME':
      return `재개 · 첫 체결 ${ev.price.toFixed(2)} (갭 ${(ev.gapPct * 100).toFixed(1)}%) · 정지 ${Math.round(ev.haltedMs / 1000)}초${
        ev.inCircuit ? ' · 서킷 상태 유지' : ''
      }`;
    case 'CIRCUIT_RELEASED':
      return '서킷 상태 해제 · 재개 뒤 5분 정지 없음 — ma5 청산으로 돌아가요';
    case 'SELL':
      return `${ev.reason === 'CIRCUIT' ? '하킷 2연속' : '정지 직전가가 손절선 이하'} → ${
        ev.acted ? '정지 중 지정가 매도' : '(관측 모드) 매도 조건 충족 — 주문은 내지 않아요'
      } · 지정가 ${ev.limitPrice.toFixed(2)} (직전가 ${ev.haltPrice.toFixed(2)} −12%)`;
    default:
      return '서킷 이벤트';
  }
}
