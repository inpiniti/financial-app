// AutoPilot — 단타 관리자 (plan: 2026-07-31_단타-자동관리 + 2026-08-01_단타-세션-확장
//              + 2026-08-05_다중그리드).
//
// 단타 도메인의 중앙 관리자: 상태·금액(세션)·종목을 한 곳에서 관리한다.
//  · 리스트(FeedSlot들)는 전부 시세를 받지만, 변곡점 감시(detector)는
//    **최소 속도(minTickRate) 이상인 종목 중** 틱/초 상위 최대 3개에만 부착(자격자가 없으면 0개 — 진입 없음).
//  · RUN(매매 사이클)은 **동시에 여러 종목**이 가능하다(maxConcurrentGrids, 기본 3).
//    종목마다 RunCycle + OrderPortAdapter + Grid를 따로 만들고, 이미 보유·진입 중인 종목은
//    감시 후보에서 제외한다 — 즉 진입 뒤에도 변곡점 감시는 멈추지 않고 계속 돈다.
//  · 진입금액은 **설정한 고정 금액(config.startAmountUsd)**이다. 세션의 마틴게일 금액
//    (session.amountUsd)은 진입 수량 계산에 쓰지 않는다 — 세션과 그리드는 따로 움직인다.
//    (그리드가 스스로 물타기로 수량을 늘리므로, 진입금액까지 배증하면 노출이 두 겹으로 폭주한다.)
//  · 세션: 시작금액으로 개시, 사이클마다 수익 절반(하한 $1)·손실 2배(상한 없음)로 조정 —
//    이제는 **성과 집계·세션 완주 판정 전용** 회계다(진입 수량과 무관).
//  · 현금 부족(매수가능금액 < 필요금액):
//      보유 그리드가 하나도 없으면 → PAUSED(사람이 재개/초기화 선택, 사용자 확정 §4-3)
//      보유 그리드가 있으면      → 그 진입만 포기하고 신규 진입만 잠시 쉰다(기존 그리드는 계속 관리).
//
// 안전장치는 ScalperInstance와 같은 원칙: 매수 전 프리플라이트, FAULT 인터록(사용자 Stop으로만 해제),
// 미체결 무한 대기(취소는 사용자 Stop 경로에서만). FAULT는 **전역**이다 — 한 종목이라도 주문 신뢰가
// 깨지면 전체를 동결한다(부분 동결은 계좌 상태 추론을 사람이 못 하게 만든다).

import { RunCycle, type SignalSnapshot, type TradeRecord } from '../../core/cycle';
import type { Signal } from '../../core/detector';
import { Grid, type GridPollResult } from '../../core/grid';
import { FeedSlot, type SlotSignalContext } from './feedSlot';
import { OrderPortAdapter } from './orderPortAdapter';
import { createGridOrderPort } from './gridOrderPort';
import type {
  AdapterFault,
  ClockLike,
  InstanceFault,
  KeyValueStore,
  ScalperBroker,
  SchedulerLike,
} from './types';

export const AUTOPILOT_STORAGE_KEY = 'scalper:autopilot';

/** 감시 대상 수(자격자 중 상위 N) · 재평가 주기 · 히스테리시스 배율. */
export const WATCH_COUNT = 3;
export const RESELECT_INTERVAL_MS = 30_000;
export const HYSTERESIS_RATIO = 1.2;
/** 동시에 열 수 있는 그리드(포지션) 최대 개수의 기본값 — 설정 미지정 시. */
export const DEFAULT_MAX_GRIDS = 3;
/** 동시 그리드 개수의 상한 — WS 호가(R) 구독 예산과 현금 분할이 감당하는 선. */
export const MAX_GRIDS_LIMIT = 6;
/** 연속 매수 취소가 이 횟수에 닿으면 그 종목 매수를 잠시 쉰다. */
export const ABANDON_COOLDOWN_STREAK = 3;
/** 매수 취소 쿨다운 길이(ms). */
export const ABANDON_COOLDOWN_MS = 60_000;
/** 현금 부족(보유 그리드가 있어 PAUSED로 안 가는 경우)에 신규 진입을 쉬는 시간(ms). */
export const CASH_COOLDOWN_MS = 60_000;
/** 최소 속도 기본값(틱/초) — 0 설정 불가(> 0 강제, 사용자 확정 §4-6). */
export const DEFAULT_MIN_TICK_RATE = 1;
/**
 * 수익 반감의 하한(USD) — 시작금액과 무관하게 $1 밑으로는 안 내려간다(사용자 확정 §4-1).
 * 마틴게일을 켰을 때만 적용된다(끄면 금액 조정 자체가 없다).
 */
export const AMOUNT_FLOOR_USD = 1;

/**
 * 매도 관리 그리드로 진입 후 청산을 대체할지(D5). true면 진입 체결 후 관리를 ±w OCO 지정가 그리드가
 * 인계한다(변곡점 매도 신호 무시). false로 두면 기존 변곡점 청산 경로로 **한 줄 롤백**된다.
 * ⚠ 실제 활성화는 이 상수 **그리고** deps.gridConfig 주입이 모두 있어야 한다 —
 *    gridConfig가 없으면(기존 테스트 하네스) 항상 기존 청산 경로로 동작한다.
 */
export const GRID_EXIT = true;

/** 그리드 설정 — 폭(w)·매수배율(buyMultiplier). 설정 탭(매매 파라미터)에서 조절한다. */
export interface GridExitConfig {
  /** 폭 w(기본 0.10). buyPrice=P×(1−w), sellPrice=P×(1+w). */
  width: number;
  /** 매수 배율(기본 1). 매수수량 = floor(N×배율), 매도는 항상 N 전량. */
  buyMultiplier: number;
}

export type AutoPilotState = 'IDLE' | 'SCANNING' | 'ENTERING' | 'HOLDING' | 'EXITING' | 'PAUSED' | 'FAULT';

/** 사용자 설정 — 진입금액·최대금액·최소 속도(+마틴게일 on/off·동시 그리드 수). */
export interface AutoPilotConfig {
  /**
   * **종목당 진입금액(USD)** — 진입 수량은 항상 floor(이 금액 ÷ 현재가)다.
   * 세션 금액(마틴게일로 조정되는 session.amountUsd)은 진입에 관여하지 않는다.
   * (이름은 세션 개시금액과 겸용이라 startAmountUsd 그대로 둔다 — 저장 포맷 하위호환.)
   */
  startAmountUsd: number;
  maxAmountUsd: number;
  minTickRate: number;
  /**
   * 마틴게일(손실 2배·수익 절반·세션 완주 판정) 사용 여부. **미지정이면 켬** — 기존 저장값 하위호환.
   * 끄면 세션 금액이 절대 변하지 않고 세션 완주 판정도 하지 않는다.
   * ⚠ 다중 그리드 도입 이후 이 값은 **세션 회계에만** 영향을 준다 — 진입 수량은 항상 startAmountUsd 기준이다.
   */
  martingale?: boolean;
  /** 동시에 열 수 있는 그리드(포지션) 최대 개수. 미지정이면 DEFAULT_MAX_GRIDS. */
  maxConcurrentGrids?: number;
}

/**
 * 마틴게일 사용 여부 단일 판정. **명시적 false일 때만 끔**이다.
 * `?? true`가 아니라 `!== false`인 이유: 저장값이 손상돼 null·0·"false" 같은 값이 들어와도
 * 기존 동작(켬)으로 안전하게 폴백하기 위해서다.
 */
export function isMartingaleOn(config: Pick<AutoPilotConfig, 'martingale'>): boolean {
  return config.martingale !== false;
}

/** 동시 그리드 개수 단일 판정 — 미지정·손상값은 기본값으로, 상한은 MAX_GRIDS_LIMIT. */
export function maxGridsOf(config: Pick<AutoPilotConfig, 'maxConcurrentGrids'> | null | undefined): number {
  const raw = config?.maxConcurrentGrids;
  if (!Number.isFinite(raw) || (raw as number) < 1) return DEFAULT_MAX_GRIDS;
  return Math.min(Math.floor(raw as number), MAX_GRIDS_LIMIT);
}

/** 진행 중 세션 — Stop·FAULT·재시작에도 유지되고, 종료 조건 달성 때만 리셋된다. */
export interface SessionState {
  amountUsd: number;
  /** 세션 누적 실현손익(USD). */
  pnl: number;
  cycles: number;
  /** 현금 부족으로 일시정지된 세션 — 재개/초기화는 사람이 선택. */
  paused: boolean;
}

export interface AutoPilotEvent {
  at: number;
  text: string;
}

export interface AutoPilotView {
  readonly state: AutoPilotState;
  readonly config: AutoPilotConfig | null;
  readonly session: SessionState | null;
  /** 오늘(미국 장 기준일) 열린 세션 수. */
  readonly sessionCount: number;
  /** 변곡점 감시 중인 티커(자격자 중 상위 — 0~3개). 보유·진입 중 종목은 여기 없다. */
  readonly watched: readonly string[];
  /** 사이클(진입~그리드 관리)이 열려 있는 모든 티커. */
  readonly activeTickers: readonly string[];
  /** 하위호환 — activeTickers의 첫 종목(없으면 null). */
  readonly activeTicker: string | null;
  /** 동시 그리드 최대 개수(설정값). */
  readonly maxGrids: number;
  /** 오늘(미국 장 기준일) 전체 완료 사이클 수·누적 실현손익(세션과 무관). */
  readonly cycles: number;
  readonly cumPnl: number;
  readonly lastEvent: AutoPilotEvent | null;
  readonly lastFault: InstanceFault | null;
  /** 관리 중인 모든 그리드(진입 후 인계된 것만). 게이지 UI가 이 배열을 그대로 그린다. */
  readonly grids: readonly AutoPilotGridView[];
  /** 하위호환 — grids의 첫 그리드(없으면 null). */
  readonly grid: AutoPilotGridView | null;
}

/** 게이지 UI가 소비할 그리드 뷰(관리 중 종목 1개). */
export interface AutoPilotGridView {
  ticker: string;
  /** 평단가 P(그리드가 관리하는 평균 — 리브래킷하면 낮아진다). */
  avgPrice: number;
  /** 매수 지정가 P×(1−w). */
  buyPrice: number;
  /** 매도 지정가 P×(1+w). */
  sellPrice: number;
  /** 최근 틱 현재가 — 게이지 화살표 위치용. 아직 없으면 null. */
  currentPrice: number | null;
  /** 보유수량 N. */
  holdingQty: number;
  /** 매수 배율. */
  buyMultiplier: number;
  /** 그리드가 두 주문을 실제로 걸고 관리 중인가(ARMED). */
  gridActive: boolean;
}

export interface AutoPilotDeps {
  /** 현재 리스트의 FeedSlot들 — 매니저(배선)가 watchlist 기준으로 유지한다. */
  slots: () => readonly FeedSlot[];
  /** 사이클 진입/종료 시 watchlist 제거 유예 훅. */
  pin: (ticker: string) => void;
  unpin: (ticker: string) => void;
  /** 티커별 주문 게이트웨이(실서비스 createKisBroker, 테스트 가짜 심). */
  makeBroker: (ticker: string) => ScalperBroker;
  /**
   * 매도 관리 그리드 설정(폭·매수배율). **주입되면** 진입 체결 후 관리를 ±w OCO 그리드가 인계한다(D5·GRID_EXIT).
   * 미주입이면(기존 하네스) 기존 변곡점 청산 경로로 동작한다 — 하위호환·회귀 안전.
   */
  gridConfig?: GridExitConfig;
  /**
   * 매수가능금액(USD) 사전 조회 — 현금 부족 판정용. null 반환/미주입/throw면
   * 판정 없이 진행한다(주문 거절은 기존 FAULT 인터록이 받는다 — plan §2-4 폴백).
   */
  fetchBuyableUsd?: (ticker: string, price: number) => Promise<number | null>;
  clock: ClockLike;
  scheduler: SchedulerLike;
  storage: KeyValueStore;
  /** 사이클 종료 기록 — 매니저가 tradeStore에 연결. */
  onTrade?: (record: TradeRecord) => void;
  onEvent?: (event: AutoPilotEvent) => void;
  onFault?: (fault: InstanceFault) => void;
  /** 거래 수수료율(소수·편도, 0=끔) — 사이클 RunCycle로 넘겨 손익에서 차감한다. */
  feeRate?: number;
  /** 체결 폴링 주기(ms, 기본 2000 — 기존 인스턴스와 동일). */
  pollIntervalMs?: number;
  /** 매도 리프라이스 주기(ms, 기본 1000). 매수1호가가 바뀐 경우에만 정정을 낸다. */
  repriceIntervalMs?: number;
  /** 매수 미체결 자동 취소 대기(ms, 0=끔). 부분체결이면 취소하지 않는다. */
  buyCancelAfterMs?: number;
  reselectIntervalMs?: number;
  hysteresisRatio?: number;
  watchCount?: number;
}

/** 금액 조정 규칙(순수) — 수익 절반(하한 $1)·손실 2배(상한 없음)·본전 유지. */
export function nextAmountUsd(current: number, pnl: number): number {
  if (pnl > 0) return Math.max(current / 2, AMOUNT_FLOOR_USD);
  if (pnl < 0) return current * 2;
  return current;
}

/** 진입 수량(순수) — 금액÷가격 내림. 1 미만이면 0(진입 포기 신호). */
export function qtyForAmount(amountUsd: number, price: number): number {
  if (!Number.isFinite(amountUsd) || !Number.isFinite(price) || price <= 0) return 0;
  return Math.floor(amountUsd / price);
}

/**
 * 세션 종료 판정(순수) — AND 3조건, **금액 조정 전**의 이번 사이클 투입금액 기준(사용자 확정 §4-2).
 * 성과는 0 포함(≥ 0 — §4-8).
 */
export function shouldEndSession(
  cyclePnl: number,
  usedAmountUsd: number,
  sessionPnl: number,
  maxAmountUsd: number,
): boolean {
  return cyclePnl > 0 && usedAmountUsd >= maxAmountUsd && sessionPnl >= 0;
}

/**
 * 설정 검증(순수) — 0 < 시작 ≤ 최대, 최소 속도 > 0, 동시 그리드 ≥ 1. 문제 없으면 null, 있으면 사용자 문구.
 * 마틴게일을 끄면 최대금액이 의미가 없으므로 그 검사만 건너뛴다(= 규칙이 더 관대해진다).
 * ⚠ restore()가 이 함수로 저장값을 필터링하므로, 규칙을 **엄격하게** 바꾸면 기존 설정이 조용히 소실된다.
 *    그래서 maxConcurrentGrids는 미지정(undefined)을 허용한다 — 기존 v2 저장값이 살아남아야 한다.
 */
export function validateConfig(config: AutoPilotConfig): string | null {
  const martingaleOn = isMartingaleOn(config);
  if (!Number.isFinite(config.startAmountUsd) || config.startAmountUsd <= 0) {
    return martingaleOn
      ? '시작금액은 0보다 큰 달러 금액으로 입력해 주세요'
      : '금액은 0보다 큰 달러 금액으로 입력해 주세요';
  }
  if (martingaleOn && (!Number.isFinite(config.maxAmountUsd) || config.maxAmountUsd < config.startAmountUsd)) {
    return '최대금액은 시작금액 이상으로 입력해 주세요';
  }
  if (!Number.isFinite(config.minTickRate) || config.minTickRate <= 0) {
    return '최소 속도는 0보다 크게 입력해 주세요 (기본 1틱/초)';
  }
  if (config.maxConcurrentGrids !== undefined) {
    const n = config.maxConcurrentGrids;
    if (!Number.isFinite(n) || n < 1 || n > MAX_GRIDS_LIMIT) {
      return `동시 그리드 수는 1~${MAX_GRIDS_LIMIT} 사이로 입력해 주세요`;
    }
  }
  return null;
}

/** 미국 장 기준일(America/New_York 날짜, YYYY-MM-DD) — "오늘"의 기준(사용자 확정 §4-7). */
export function etDateOf(epochMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

/**
 * 종목 하나의 진행 중 사이클. 예전에는 AutoPilot이 이 상태를 통째로 필드로 들고 있었지만(단일 사이클),
 * 다중 그리드에서는 **종목마다 한 벌**이어야 한다 — 특히 buyingSince·abandonRequested·pendingSettle을
 * 전역으로 두면 A 종목의 미체결 시계가 B 종목의 자동 포기를 오발동시킨다.
 */
interface ActiveCycle {
  ticker: string;
  slot: FeedSlot;
  adapter: OrderPortAdapter;
  cycle: RunCycle;
  /** 이 사이클의 브로커 — 그리드 발주에 재사용한다(진입 어댑터와 같은 브로커). */
  broker: ScalperBroker;
  /** 매도 관리 그리드(진입 후 인계). 미인계면 null. */
  grid: Grid | null;
  /** 그리드가 두 주문을 실제로 발주했는가(arm 성공). */
  gridArmed: boolean;
  /** BUYING 진입 시각(자동 포기 경과 기점). */
  buyingSince: number | null;
  /** 이 주문에 자동 포기를 이미 요청했는가. */
  abandonRequested: boolean;
  /** RunCycle이 onTrade로 흘린 마지막 기록 — settle이 회수한다. */
  pendingSettle: TradeRecord | null;
  /** 그리드 arm이 진행 중 — 같은 종목에 두 번 걸지 않기 위한 가드. */
  arming: boolean;
}

interface PendingBuy {
  ctx: SlotSignalContext;
  tickRate: number;
}

interface PersistedV2 {
  version: 2;
  config: AutoPilotConfig | null;
  session: SessionState | null;
  daily: { date: string; sessionCount: number; cycles: number; cumPnl: number } | null;
}

type Listener = (view: AutoPilotView) => void;

export class AutoPilot {
  private readonly deps: AutoPilotDeps;
  private readonly pollIntervalMs: number;
  private readonly repriceIntervalMs: number;
  private readonly buyCancelAfterMs: number;
  private readonly reselectIntervalMs: number;
  private readonly hysteresisRatio: number;
  private readonly watchCount: number;

  /** start()~finishStop() 사이인가. 전역 state는 이 플래그·faulted·session.paused에서 파생된다. */
  private running = false;
  /** 전역 인터록 — 사용자 Stop으로만 해제. */
  private faulted = false;
  private config: AutoPilotConfig | null = null;
  private session: SessionState | null = null;
  private dailyDate: string | null = null;
  private sessionCount = 0;
  private watchedTickers: string[] = [];
  /**
   * 매도 관리 그리드 설정(폭·매수배율). deps에서 **초기값만** 받고 이후 setGridConfig로 갈아끼운다 —
   * 설정 탭에서 폭을 바꿔도 매니저 싱글턴이 캐시돼 옛 값으로 돌던 버그를 여기서 막는다.
   * ⚠ 이미 걸려 있는 Grid는 생성자에서 폭·배율을 캡처하므로 **다음에 새로 여는 그리드부터** 적용된다
   *   (돌고 있는 그리드의 폭을 바꾸려면 접수된 두 주문을 취소·재발주해야 한다 — 하지 않는다).
   */
  private gridConfig: GridExitConfig | undefined;
  /** 진행 중 사이클 — 티커당 하나, 최대 maxGrids개. */
  private readonly actives = new Map<string, ActiveCycle>();
  /** 프리플라이트~발주 확정 사이의 진입 후보 — 슬롯 점유를 여기서부터 계산한다(동시 신호 과진입 방지). */
  private readonly pendingBuys = new Map<string, PendingBuy>();
  /** 티커별 연속 취소 기록 — 사이클마다 종목이 바뀌므로 맵으로 둔다. */
  private readonly abandonState = new Map<string, { streak: number; until: number }>();
  /** 현금 부족으로 신규 진입을 쉬는 기한(보유 그리드가 있어 PAUSED로 가지 않은 경우). */
  private cashCooldownUntil = 0;
  private stopRequested = false;
  private cycles = 0;
  private cumPnl = 0;
  private lastEvent: AutoPilotEvent | null = null;
  private lastFault: InstanceFault | null = null;

  private pollTimer: unknown = null;
  /** 매도 리프라이스 타이머(폴 타이머와 함께 켜고 끈다). */
  private repriceTimer: unknown = null;
  /** 리프라이스 틱 재진입 방지. */
  private repriceTicking = false;
  private reselectTimer: unknown = null;
  private readonly listeners = new Set<Listener>();

  constructor(deps: AutoPilotDeps) {
    this.deps = deps;
    this.gridConfig = deps.gridConfig;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.repriceIntervalMs = deps.repriceIntervalMs ?? 1000;
    this.buyCancelAfterMs = deps.buyCancelAfterMs ?? 0;
    this.reselectIntervalMs = deps.reselectIntervalMs ?? RESELECT_INTERVAL_MS;
    this.hysteresisRatio = deps.hysteresisRatio ?? HYSTERESIS_RATIO;
    this.watchCount = deps.watchCount ?? WATCH_COUNT;
  }

  // ---- 구독/뷰 ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getView(): AutoPilotView {
    const activeTickers = [...this.actives.keys()];
    const grids = this.gridViews();
    return {
      state: this.state,
      config: this.config ? { ...this.config } : null,
      session: this.session ? { ...this.session } : null,
      sessionCount: this.sessionCount,
      watched: [...this.watchedTickers],
      activeTickers,
      activeTicker: activeTickers[0] ?? null,
      maxGrids: this.maxGrids,
      cycles: this.cycles,
      cumPnl: this.cumPnl,
      lastEvent: this.lastEvent,
      lastFault: this.lastFault,
      grids,
      grid: grids[0] ?? null,
    };
  }

  /**
   * 전역 상태(파생) — 배지 하나로 요약한다. 우선순위는 사람이 먼저 봐야 하는 순:
   * IDLE > FAULT > PAUSED > 진입 중 > 청산 중 > 보유 중 > 감시 중.
   * ⚠ 다중 그리드에서는 "보유 중"이어도 감시는 계속 돈다 — 배지는 요약일 뿐 감시 여부의 근거가 아니다.
   */
  private get state(): AutoPilotState {
    if (!this.running) return 'IDLE';
    if (this.faulted) return 'FAULT';
    if (this.session?.paused) return 'PAUSED';
    let entering = this.pendingBuys.size > 0;
    let exiting = false;
    let holding = false;
    for (const a of this.actives.values()) {
      switch (a.cycle.state) {
        case 'WATCH_BUY':
        case 'BUYING':
          entering = true;
          break;
        case 'SELLING':
          exiting = true;
          break;
        case 'HOLDING':
          holding = true;
          break;
        default:
          break;
      }
    }
    if (entering) return 'ENTERING';
    if (exiting) return 'EXITING';
    if (holding) return 'HOLDING';
    return 'SCANNING';
  }

  private get maxGrids(): number {
    return maxGridsOf(this.config);
  }

  /** 관리 중 그리드 뷰 — 그리드가 인계된 사이클만(진입 직후·비그리드 경로는 빠진다). */
  private gridViews(): AutoPilotGridView[] {
    const out: AutoPilotGridView[] = [];
    for (const active of this.actives.values()) {
      if (!active.grid) continue;
      const v = active.grid.view;
      out.push({
        ticker: active.ticker,
        avgPrice: v.avgPrice,
        buyPrice: v.buyPrice,
        sellPrice: v.sellPrice,
        currentPrice: active.slot.getView().price,
        holdingQty: v.holdingQty,
        buyMultiplier: v.buyMultiplier,
        gridActive: v.gridActive,
      });
    }
    return out;
  }

  /** 그리드 인계가 켜져 있는가 — 상수 롤백 스위치 AND 설정 주입. */
  private gridEnabled(): boolean {
    return GRID_EXIT && this.gridConfig !== undefined;
  }

  /**
   * 그리드 폭·매수배율 교체 — 설정 탭 저장 후 매니저가 부른다. **실행 중에도 안전하다.**
   * 이미 걸린 그리드는 자기 폭을 그대로 유지하고(주문이 이미 접수돼 있다), 다음 진입부터 새 값이 쓰인다.
   * 현재 값과 같으면 아무것도 하지 않는다(불필요한 이벤트·리렌더 방지).
   */
  setGridConfig(config: GridExitConfig | undefined): void {
    const prev = this.gridConfig;
    if (
      prev === config ||
      (prev !== undefined &&
        config !== undefined &&
        prev.width === config.width &&
        prev.buyMultiplier === config.buyMultiplier)
    ) {
      return;
    }
    this.gridConfig = config;
    if (config) {
      this.event(
        `그리드 설정 적용 · 폭 ±${(config.width * 100).toFixed(1)}% · 매수 배율 ${config.buyMultiplier}배 (다음 그리드부터)`,
      );
    }
    this.emit();
  }

  /** 현재 그리드 설정(읽기 전용) — UI 표시용. 그리드를 쓰지 않는 하네스면 undefined. */
  get gridSettings(): GridExitConfig | undefined {
    return this.gridConfig ? { ...this.gridConfig } : undefined;
  }

  // ---- 설정/영속화 ----

  /** 설정 변경 — IDLE에서만. 검증 실패 문구를 반환한다(성공 시 null). 진행 중 세션은 건드리지 않는다. */
  setConfig(config: AutoPilotConfig): string | null {
    if (this.state !== 'IDLE') return '설정은 정지 상태에서 바꿀 수 있어요';
    const error = validateConfig(config);
    if (error) return error;
    this.config = { ...config };
    // ★ 마틴 OFF에는 "다음 세션"이 없다(세션 완주 판정을 안 하므로). 진행 중 세션을 동기화하지 않으면
    //   세션 표시 금액이 영원히 예전 값으로 남는다. ON→OFF 전환 시 불어난 금액도 여기서 내려온다.
    //   setConfig는 IDLE에서만 통과하므로 진행 중 사이클·미체결 주문과 충돌하지 않는다.
    //   (OFF→ON은 동기화하지 않는다 — 마틴 진행 중 성과를 임의로 리셋하지 않기 위해.)
    if (!isMartingaleOn(this.config) && this.session) {
      this.session.amountUsd = this.config.startAmountUsd;
    }
    void this.persist();
    this.emit();
    return null;
  }

  /** 재시작 복원 — v2 설정·세션·일일 카운트. v1(baseAmountUsd)은 마이그레이션(plan §4-5). */
  async restore(): Promise<void> {
    const raw = await this.deps.storage.getItem(AUTOPILOT_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedV2> & { baseAmountUsd?: number };
      if (parsed.version === 2) {
        if (parsed.config && validateConfig(parsed.config) === null) this.config = parsed.config;
        if (parsed.session && Number.isFinite(parsed.session.amountUsd) && parsed.session.amountUsd > 0) {
          this.session = { ...parsed.session, paused: parsed.session.paused ?? false };
        }
        if (parsed.daily && typeof parsed.daily.date === 'string') {
          this.dailyDate = parsed.daily.date;
          this.sessionCount = parsed.daily.sessionCount ?? 0;
          this.cycles = parsed.daily.cycles ?? 0;
          this.cumPnl = parsed.daily.cumPnl ?? 0;
        }
      } else if (typeof parsed.baseAmountUsd === 'number' && parsed.baseAmountUsd > 0) {
        // v1 → v2: base → 시작금액, base×4 → 최대금액, 최소 속도 기본 1.
        this.config = {
          startAmountUsd: parsed.baseAmountUsd,
          maxAmountUsd: parsed.baseAmountUsd * 4,
          minTickRate: DEFAULT_MIN_TICK_RATE,
        };
        void this.persist();
      }
    } catch {
      // 손상된 저장값 — 무시.
    }
    this.rolloverDailyIfNeeded();
    this.emit();
  }

  private async persist(): Promise<void> {
    const data: PersistedV2 = {
      version: 2,
      config: this.config,
      session: this.session,
      daily:
        this.dailyDate === null
          ? null
          : { date: this.dailyDate, sessionCount: this.sessionCount, cycles: this.cycles, cumPnl: this.cumPnl },
    };
    await this.deps.storage.setItem(AUTOPILOT_STORAGE_KEY, JSON.stringify(data));
  }

  /** 미국 장 기준일이 바뀌었으면 일일 통계를 리셋한다(진행 중 세션이 있으면 그 세션이 오늘의 1번째). */
  private rolloverDailyIfNeeded(): void {
    const today = etDateOf(this.deps.clock.now());
    if (this.dailyDate === today) return;
    this.dailyDate = today;
    this.sessionCount = this.session ? 1 : 0;
    this.cycles = 0;
    this.cumPnl = 0;
  }

  // ---- 시작/정지 ----

  /** Run — 설정 필수. 세션이 없으면 시작금액으로 개시. 일시정지된 세션이면 PAUSED로 진입(사람이 선택). */
  start(): void {
    if (this.state !== 'IDLE') return;
    if (!this.config) {
      this.event('진입금액·최소 속도를 먼저 설정해 주세요');
      return;
    }
    this.stopRequested = false;
    this.faulted = false;
    this.cashCooldownUntil = 0;
    this.running = true;
    this.rolloverDailyIfNeeded();
    if (!this.session) {
      this.session = { amountUsd: this.config.startAmountUsd, pnl: 0, cycles: 0, paused: false };
      this.sessionCount += 1;
      const amount = `$${this.config.startAmountUsd.toFixed(2)}`;
      this.event(
        `세션 #${this.sessionCount} 시작 · ${isMartingaleOn(this.config) ? `${amount}부터` : `${amount} 고정`}`,
      );
    }
    if (this.session.paused) {
      // 현금 부족으로 멈췄던 세션 — 자동 재개하지 않는다(§4-3). 사람이 재개/초기화를 고른다.
      this.reselectTimer = this.deps.scheduler.setInterval(() => this.reselect(), this.reselectIntervalMs);
      this.event('현금 부족으로 멈춘 세션이 있어요 — 이어서 재개하거나 세션을 초기화해 주세요');
      this.emit();
      return;
    }
    this.reselect();
    this.reselectTimer = this.deps.scheduler.setInterval(() => this.reselect(), this.reselectIntervalMs);
    this.event(`자동 단타를 시작했어요 · 종목당 $${this.config.startAmountUsd.toFixed(2)} · 그리드 최대 ${this.maxGrids}개`);
    void this.persist();
    this.emit();
  }

  stop(): void {
    this.stopRequested = true;
    this.pendingBuys.clear();
    if (this.faulted) {
      // 인터록 해제 — 추가 주문·취소 없이 정리만(포지션은 계좌에서 수동 처리).
      for (const active of [...this.actives.values()]) {
        active.cycle.stop(); // FAULT→DONE(코어가 주문 없이 종료).
        this.teardownActive(active);
      }
      this.finishStop();
      return;
    }
    if (this.actives.size > 0) {
      for (const active of this.actives.values()) active.cycle.stop();
      // SELLING→DONE은 pollCycle이 진행 — settle에서 stopRequested를 보고 마지막 사이클에서 IDLE로 마감한다.
      void this.pollCycle();
      this.emit();
      return;
    }
    this.finishStop();
  }

  private finishStop(): void {
    if (!this.running) return;
    this.detachAll();
    this.stopPollTimer();
    if (this.reselectTimer !== null) {
      this.deps.scheduler.clearInterval(this.reselectTimer);
      this.reselectTimer = null;
    }
    this.lastFault = null;
    this.faulted = false;
    this.running = false;
    this.event('자동 단타를 정지했어요');
    void this.persist();
    this.emit();
  }

  // ---- PAUSED (현금 부족 — plan §2-4) ----

  /** 이어서 재개 — 같은 세션·같은 금액으로 감시 복귀(입금 후 사용자가 누른다). */
  resume(): void {
    if (this.state !== 'PAUSED' || !this.session) return;
    this.session.paused = false;
    this.cashCooldownUntil = 0;
    this.reselect();
    this.event('세션을 이어서 재개했어요');
    void this.persist();
    this.emit();
  }

  /** 세션 초기화하고 재개 — 현 세션을 버리고 시작금액으로 새 세션. */
  resetSession(): void {
    if (this.state !== 'PAUSED' || !this.config) return;
    this.rolloverDailyIfNeeded();
    this.session = { amountUsd: this.config.startAmountUsd, pnl: 0, cycles: 0, paused: false };
    this.sessionCount += 1;
    this.cashCooldownUntil = 0;
    this.reselect();
    this.event(`세션 #${this.sessionCount} 시작 · $${this.config.startAmountUsd.toFixed(2)}부터 (초기화)`);
    void this.persist();
    this.emit();
  }

  /**
   * 현금 부족으로 전면 정지 — **보유 그리드가 하나도 없을 때만** 부른다.
   * (그리드가 살아 있는데 여기 들어오면 폴 타이머가 꺼져 관리 중인 포지션이 방치된다.)
   */
  private enterPaused(reason: string): void {
    if (!this.session) return;
    this.session.paused = true;
    this.pendingBuys.clear();
    this.detachAll();
    this.stopPollTimer();
    this.event(reason);
    void this.persist();
    this.emit();
  }

  dispose(): void {
    this.stopPollTimer();
    if (this.reselectTimer !== null) {
      this.deps.scheduler.clearInterval(this.reselectTimer);
      this.reselectTimer = null;
    }
  }

  // ---- 감시 대상 선정 (최소 속도 자격 필터 — 세션 확장 plan §2-2) ----

  /**
   * 자격자(틱/초 ≥ minTickRate) 중 상위 watchCount 재평가. 자격자가 모자라면 빈 자리를 비워 둔다(0개 허용).
   * 감시 중 종목이 자격을 잃으면 히스테리시스와 무관하게 즉시 해제한다(저유동성 이탈이 목적).
   * 히스테리시스(기본 1.2배)는 자격자끼리의 교체에만 적용.
   *
   * ★ 다중 그리드의 핵심: **사이클이 진행 중이어도 재평가를 멈추지 않는다.**
   *   대신 이미 보유·진입 중인 종목(actives·pendingBuys)을 후보에서 제외해, 감시는 늘 "새로 살 종목"만 본다.
   */
  reselect(): void {
    if (!this.running || this.faulted || this.session?.paused) return;
    const minRate = this.config?.minTickRate ?? DEFAULT_MIN_TICK_RATE;
    const now = this.deps.clock.now();
    const slots = this.deps.slots();
    const byTicker = new Map(slots.map((s) => [s.ticker, s]));
    const rateOf = (t: string) => byTicker.get(t)?.tickRate(now) ?? 0;
    const eligible = (t: string) =>
      byTicker.has(t) &&
      rateOf(t) >= minRate &&
      !this.inAbandonCooldown(t) &&
      !this.actives.has(t) &&
      !this.pendingBuys.has(t);

    // 리스트에서 사라졌거나 자격 미달이 된(또는 방금 보유가 된) 감시 종목은 즉시 정리.
    let watched = this.watchedTickers.filter(eligible);

    const candidates = slots
      .map((s) => s.ticker)
      .filter((t) => !watched.includes(t) && eligible(t))
      .sort((a, b) => rateOf(b) - rateOf(a));

    // 빈 자리는 자격자로만 채운다(히스테리시스 없음 — 신규 편입).
    while (watched.length < this.watchCount && candidates.length > 0) {
      watched.push(candidates.shift()!);
    }

    // 교체 판정 — 최저 감시 vs 최고 후보, 배율 상회 시에만.
    watched.sort((a, b) => rateOf(a) - rateOf(b));
    for (const challenger of candidates) {
      const lowest = watched[0];
      if (lowest === undefined) break;
      if (rateOf(challenger) > rateOf(lowest) * this.hysteresisRatio) {
        watched.shift();
        watched.push(challenger);
        watched.sort((a, b) => rateOf(a) - rateOf(b));
      } else {
        break;
      }
    }

    const next = watched.sort((a, b) => rateOf(b) - rateOf(a));
    const prev = this.watchedTickers;
    const changed = next.length !== prev.length || next.some((t) => !prev.includes(t));
    if (!changed) return;

    for (const t of prev) {
      // ⚠ 보유·진입 중 종목의 detector는 떼지 않는다 — 그리드 미사용 경로에서 SELL 청산 신호가 거기서 온다.
      if (!next.includes(t) && !this.actives.has(t) && !this.pendingBuys.has(t)) {
        byTicker.get(t)?.detachDetector();
      }
    }
    for (const t of next) {
      const slot = byTicker.get(t);
      if (slot && !slot.watched) {
        slot.attachDetector((signal, ctx) => this.handleSignal(signal, ctx));
      }
    }
    this.watchedTickers = next;
    this.event(
      next.length > 0
        ? `감시 교체 · ${next.join(', ')}`
        : `감시 대상 없음 · 모든 종목이 ${minRate}틱/초 미만이라 기다리고 있어요`,
    );
    this.emit();
  }

  private detachAll(): void {
    for (const slot of this.deps.slots()) {
      if (slot.watched) slot.detachDetector();
    }
    this.watchedTickers = [];
  }

  // ---- 신호 → 사이클 ----

  private handleSignal(signal: Signal, ctx: SlotSignalContext): void {
    if (signal === 'BUY') {
      this.handleBuySignal(ctx);
      return;
    }
    // SELL — 보유 종목의 매도 변곡점만 의미 있다(유동성이 죽어도 사이클은 반드시 완주 — §4-4).
    const active = this.actives.get(ctx.ticker);
    if (active) {
      // 그리드가 청산을 관리하면 변곡점 매도는 무시한다(D5) — 매도는 +w 지정가 체결로만 일어난다.
      if (this.gridEnabled()) return;
      active.adapter.setLimitPrice(ctx.price);
      active.cycle.onSignal('SELL', this.toSnapshot(ctx));
      this.emit();
      void this.pollCycle();
    }
  }

  /**
   * 매수 신호 — 빈 그리드 슬롯이 있을 때만 받는다.
   * 슬롯 점유는 pendingBuys 등록(동기)으로 **먼저** 확정한다 — 프리플라이트가 async라
   * 그 사이에 들어온 다른 신호가 같은 슬롯을 중복 점유하면 maxGrids를 넘겨 진입한다.
   */
  private handleBuySignal(ctx: SlotSignalContext): void {
    if (this.stopRequested || !this.running || this.faulted || this.session?.paused) return;
    if (this.actives.has(ctx.ticker) || this.pendingBuys.has(ctx.ticker)) return; // 이미 보유·진입 중
    if (this.inAbandonCooldown(ctx.ticker)) return;
    if (this.deps.clock.now() < this.cashCooldownUntil) return;
    if (this.actives.size + this.pendingBuys.size >= this.maxGrids) return; // 그리드 슬롯 만석

    const rate = this.slotOf(ctx.ticker)?.tickRate(this.deps.clock.now()) ?? 0;
    this.pendingBuys.set(ctx.ticker, { ctx, tickRate: rate });
    this.emit();
    void this.commitBuy(ctx.ticker);
  }

  /**
   * 프리플라이트 → 속도 재검사 → 현금 검사 → 발주 확정 (종목 1개).
   * 진입금액은 **설정 고정값(config.startAmountUsd)** — 세션 금액과 무관하다.
   */
  private async commitBuy(ticker: string): Promise<void> {
    const candidate = this.pendingBuys.get(ticker);
    const config = this.config;
    if (!candidate || !config) {
      this.pendingBuys.delete(ticker);
      this.emit();
      return;
    }
    const { ctx } = candidate;

    /** 진입을 포기하고 슬롯을 반납한다(사유는 호출부가 이벤트로 남긴다). */
    const giveUp = (): void => {
      this.pendingBuys.delete(ticker);
      if (this.stopRequested && this.actives.size === 0) {
        this.finishStop();
        return;
      }
      this.reselect();
      this.emit();
    };

    if (this.stopRequested) return giveUp();

    const entryAmountUsd = config.startAmountUsd;
    const qty = qtyForAmount(entryAmountUsd, ctx.price);
    if (qty < 1) {
      this.event(
        `${ctx.ticker} 진입 포기 · 진입금액($${entryAmountUsd.toFixed(2)})이 1주 가격($${ctx.price})보다 작아요`,
      );
      return giveUp();
    }

    const slot = this.slotOf(ctx.ticker);
    if (!slot) return giveUp();

    const broker = this.deps.makeBroker(ctx.ticker);
    const adapter = new OrderPortAdapter({ broker, clock: this.deps.clock });
    const fault = await adapter.preflightCheckFills();
    if (this.stopRequested) return giveUp();
    if (fault) {
      this.pendingBuys.delete(ticker);
      this.enterFault(fault);
      return;
    }

    // 진입 직전 속도 재검사(§4-4) — 감시 선정과 신호 사이에 유동성이 죽었으면 포기.
    const rateNow = slot.tickRate(this.deps.clock.now());
    if (rateNow < config.minTickRate) {
      this.event(
        `${ctx.ticker} 진입 포기 · 속도가 ${rateNow.toFixed(1)}틱/초로 떨어져 기준(${config.minTickRate})에 못 미쳐요`,
      );
      return giveUp();
    }

    // 현금 부족 사전 판정(§2-4) — 조회 실패(null/throw)면 판정 없이 진행(FAULT 인터록이 최후 방어선).
    const needed = qty * ctx.price;
    let buyable: number | null = null;
    try {
      buyable = (await this.deps.fetchBuyableUsd?.(ctx.ticker, ctx.price)) ?? null;
    } catch {
      buyable = null;
    }
    if (this.stopRequested) return giveUp();
    if (buyable !== null && buyable < needed) {
      this.pendingBuys.delete(ticker);
      if (this.actives.size === 0) {
        // 관리 중인 포지션이 없다 — 세션을 통째로 멈추고 사람의 선택을 기다린다(기존 동작).
        this.enterPaused(
          `현금이 부족해서 쉬고 있어요 · 필요 $${needed.toFixed(2)} > 주문가능 $${buyable.toFixed(2)} — 입금 후 재개하거나 세션을 초기화해 주세요`,
        );
        return;
      }
      // ★ 관리 중인 그리드가 있으면 절대 PAUSED로 가지 않는다(폴 타이머가 꺼져 포지션이 방치된다).
      //   신규 진입만 잠시 쉰다 — 기존 그리드가 매도되면 현금이 돌아온다.
      this.cashCooldownUntil = this.deps.clock.now() + CASH_COOLDOWN_MS;
      this.event(
        `${ctx.ticker} 진입 포기 · 현금 부족(필요 $${needed.toFixed(2)} > 주문가능 $${buyable.toFixed(2)}) — 신규 진입을 ${CASH_COOLDOWN_MS / 1000}초 쉬어요`,
      );
      this.reselect();
      this.emit();
      return;
    }

    // 확정 — 사이클 개시.
    this.pendingBuys.delete(ticker);
    const active: ActiveCycle = {
      ticker: ctx.ticker,
      slot,
      adapter,
      cycle: null as unknown as RunCycle, // 아래에서 즉시 채운다(onTrade 클로저가 active를 참조해야 한다).
      broker,
      grid: null,
      gridArmed: false,
      buyingSince: this.deps.clock.now(),
      abandonRequested: false,
      pendingSettle: null,
      arming: false,
    };
    active.cycle = new RunCycle({
      ticker: ctx.ticker,
      qty,
      port: adapter,
      clock: this.deps.clock,
      feeRate: this.deps.feeRate,
      onTrade: (record) => {
        active.pendingSettle = record;
        this.deps.onTrade?.(record);
      },
    });
    this.actives.set(ctx.ticker, active);
    this.deps.pin(ctx.ticker);
    // 이 종목은 이제 "감시 후보"가 아니다 — 목록에서 빼고 빈 자리를 다른 종목으로 채운다(감시 계속).
    this.watchedTickers = this.watchedTickers.filter((t) => t !== ctx.ticker);

    adapter.setLimitPrice(ctx.price);
    const quote = slot.quote;
    if (quote) adapter.setQuote(quote.bid1, quote.ask1, quote.at);

    active.cycle.start();
    active.cycle.onSignal('BUY', this.toSnapshot(ctx));
    this.startPollTimer();
    this.event(
      `${ctx.ticker} 진입 · ${qty}주 × $${ctx.price} (진입금액 $${entryAmountUsd.toFixed(2)}) · 그리드 ${this.actives.size}/${this.maxGrids}`,
    );
    this.reselect(); // 빈 감시 자리를 즉시 채운다.
    this.emit();
  }

  // ---- 사이클 폴링/정산 ----

  /** 체결 폴링 1회 — 진행 중인 모든 사이클을 순회한다(종목 간 독립, 한 종목 FAULT면 전역 인터록). */
  async pollCycle(): Promise<void> {
    if (this.faulted) return;
    for (const active of [...this.actives.values()]) {
      if (this.faulted) return;
      if (!this.actives.has(active.ticker)) continue; // 이번 순회 중 정산돼 사라졌다.
      await this.pollOne(active);
    }
  }

  /** 사이클 1개 폴 — 인스턴스와 같은 순서: fault 회수 → refreshFills → cycle.poll → 정산. */
  private async pollOne(active: ActiveCycle): Promise<void> {
    const pending = active.adapter.takeFault();
    if (pending) {
      this.enterFault(pending);
      return;
    }

    // 그리드가 인계됐으면 진입 어댑터 대신 그리드를 구동한다(매도 체결→SCANNING, 매수 체결→리브래킷).
    if (active.grid && active.gridArmed) {
      await this.pollGrid(active);
      return;
    }

    const ok = await active.adapter.refreshFills();
    if (!ok) {
      this.enterFault(active.adapter.takeFault() ?? { kind: 'FILL_CHECK', reason: '체결 확인 실패' });
      return;
    }

    const view = active.slot.getView();
    if (view.price !== null) active.adapter.setLimitPrice(view.price);
    const quote = active.slot.quote;
    if (quote) active.adapter.setQuote(quote.bid1, quote.ask1, quote.at);

    active.cycle.poll();

    const late = active.adapter.takeFault();
    if (late) {
      this.enterFault(late);
      return;
    }

    // ★ 자동 포기로 감시 복귀한 사이클.
    if (active.cycle.state === 'WATCH_BUY') {
      this.abandonActive(active);
      return;
    }
    if (active.cycle.state === 'HOLDING') {
      // 체결에 성공했다 — 경과 시계와 연속 취소 카운터를 푼다.
      active.buyingSince = null;
      active.abandonRequested = false;
      this.clearAbandon(active.ticker);
      // 진입 체결 → 매도 관리 그리드 인계(D5). 그리드가 켜져 있고 아직 안 걸었으면 지금 두 주문을 건다.
      if (this.gridEnabled() && !active.grid && !active.arming) {
        await this.armGrid(active);
        // arm이 FAULT면 gridArmed=false로 남는다 — 인터록은 armGrid가 이미 걸었으니 그대로 반환한다.
        if (!active.gridArmed) return;
        this.emit();
        return;
      }
    }
    this.emit();
    if (active.cycle.state === 'DONE') this.settle(active);
  }

  // ---- 매도 관리 그리드(D5) ----

  /**
   * 진입 체결 후 그리드 인계 — 잔고에서 평단·수량을 읽어(D1, 폴백=진입 체결) 두 지정가를 건다.
   * 현금은 fetchBuyableUsd로 미리 조회해 매수 다리 축소/생략에 쓴다(D2). 발주 실패는 FAULT.
   *
   * ⚠ 다중 그리드에서는 가용현금을 **동시 그리드 수로 나눠** 배정한다. 안 그러면 그리드 3개가
   *    같은 현금을 각자 "전부 내 것"으로 보고 물타기 매수를 걸어, 셋 다 걸리면 계좌가 즉시 잠긴다.
   */
  private async armGrid(active: ActiveCycle): Promise<void> {
    // ★ 여기서 읽는 값이 이 그리드의 폭·배율로 고정된다(Grid 생성자가 캡처) — 설정 변경은 다음 그리드부터.
    const cfg = this.gridConfig!;
    active.arming = true;
    try {
      const pos = active.cycle.position;
      const fallback = pos ? { qty: pos.qty, avgPrice: pos.entryPrice } : undefined;
      const buyPrice = (pos?.entryPrice ?? 0) * (1 - cfg.width);
      let availableCashUsd: number | undefined;
      try {
        const cash = await this.deps.fetchBuyableUsd?.(active.ticker, buyPrice);
        if (typeof cash === 'number' && Number.isFinite(cash)) availableCashUsd = cash / this.maxGrids;
      } catch {
        // 현금 판정 생략 — 전량 매수 다리로 진행(주문 거절은 FAULT 인터록이 받는다).
      }
      if (this.stopRequested) return;
      const grid = new Grid({
        port: createGridOrderPort(active.broker, active.ticker),
        clock: this.deps.clock,
        config: { width: cfg.width, buyMultiplier: cfg.buyMultiplier, availableCashUsd },
      });
      active.grid = grid;
      await grid.arm(fallback);
      if (grid.state === 'FAULT') {
        this.enterFault({ kind: 'PLACE', reason: grid.faultText ?? '그리드 발주 실패' });
        return;
      }
      active.gridArmed = true;
      const v = grid.view;
      this.event(
        `${active.ticker} 그리드 관리 인계 · 매수 $${v.buyPrice}(평단 −${Math.round(cfg.width * 100)}%) · 매도 $${v.sellPrice}(평단 +${Math.round(cfg.width * 100)}%)`,
      );
      this.emit();
    } finally {
      active.arming = false;
    }
  }

  /** 그리드 폴 1회 — 매도 체결→정산·감시 복귀, 매수 체결→리브래킷, 취소 거절→FAULT. */
  private async pollGrid(active: ActiveCycle): Promise<void> {
    const result = await active.grid!.poll();
    switch (result.kind) {
      case 'sold':
        this.settleGrid(active, result);
        break;
      case 'rebracket':
        this.event(
          `${active.ticker} 그리드 리브래킷 · 평단 $${result.position.avgPrice.toFixed(2)} · ${result.position.qty}주`,
        );
        this.emit();
        break;
      case 'fault':
        this.enterFault({ kind: 'CANCEL', reason: result.reason });
        break;
      default:
        this.emit(); // armed — 현재가 화살표 갱신용.
        break;
    }
  }

  /**
   * 그리드 매도(+w) 체결 정산 — 관리 평단→매도가 손익으로 TradeRecord를 합성해 기존 settle 경로로 넘긴다.
   * (RunCycle은 HOLDING에 파킹돼 있었을 뿐 — 실제 매도는 그리드가 냈으므로 cycle.stop()을 부르지 않는다.)
   */
  private settleGrid(active: ActiveCycle, result: Extract<GridPollResult, { kind: 'sold' }>): void {
    const pos = active.cycle.position;
    const entryPrice = result.avgPrice;
    const exitPrice = result.exitPrice;
    const qty = result.qty;
    const grossPnl = (exitPrice - entryPrice) * qty;
    const feeRate = this.deps.feeRate ?? 0;
    const fees = feeRate * (entryPrice * qty + exitPrice * qty);
    const now = this.deps.clock.now();
    const record: TradeRecord = {
      ticker: active.ticker,
      qty,
      entryPrice,
      entryTs: pos?.entryTs ?? now,
      exitPrice,
      exitTs: now,
      pnl: grossPnl - fees,
      grossPnl,
      fees,
      entrySnapshot: pos?.entrySnapshot ?? { price: entryPrice, slope: 0, accel: 0, ts: now },
      exitSnapshot: null,
      exitReason: 'SELL_SIGNAL',
    };
    active.pendingSettle = record;
    this.deps.onTrade?.(record);
    this.settle(active);
  }

  /**
   * 진행 중 사이클의 자원을 정리한다 — detector 해제, 핀 해제, 맵에서 제거.
   * ⚠ 핀(`pin`)은 `commitBuy`에서 걸리고 여기서만 풀린다. 이 경로를 거치지 않으면 워치리스트가 영구 오염된다.
   */
  private teardownActive(active: ActiveCycle): void {
    active.slot.detachDetector();
    this.actives.delete(active.ticker);
    this.deps.unpin(active.ticker);
    if (this.actives.size === 0) this.stopPollTimer();
  }

  /**
   * 매수 미체결 자동 포기로 사이클을 접고 감시로 복귀한다 — 거래 기록이 없는 유일한 종료 경로.
   * ⚠ `AutoPilot.stop()`을 부르면 `stopRequested`가 서서 IDLE로 종료돼 버리므로 절대 재활용하지 않는다.
   */
  private abandonActive(active: ActiveCycle): void {
    const ticker = active.ticker;
    active.cycle.stop(); // WATCH_BUY→DONE (이 전이는 포트를 호출하지 않는다 — 폐기 위생용)
    this.teardownActive(active);
    this.markAbandon(ticker);
    this.event(`${ticker} 매수 취소 · 안 붙어서 다시 감시해요`);
    if (this.stopRequested && this.actives.size === 0) {
      this.finishStop();
      return;
    }
    this.reselect();
    this.emit();
  }

  /** 자동 포기 1회 기록 — 연속 상한에 닿으면 그 종목 매수를 잠시 쉰다. */
  private markAbandon(ticker: string): void {
    const now = this.deps.clock.now();
    const prev = this.abandonState.get(ticker);
    const streak = (prev?.streak ?? 0) + 1;
    const until = streak >= ABANDON_COOLDOWN_STREAK ? now + ABANDON_COOLDOWN_MS : (prev?.until ?? 0);
    this.abandonState.set(ticker, { streak, until });
    if (streak >= ABANDON_COOLDOWN_STREAK) {
      this.event(`${ticker} 매수 취소가 ${streak}번 이어져서 ${ABANDON_COOLDOWN_MS / 1000}초간 쉬어요`);
    }
  }

  /** 그 종목이 자동 포기 쿨다운 중인가 — 감시 후보에서도 빠지고 매수 신호도 넘긴다. */
  private inAbandonCooldown(ticker: string): boolean {
    const s = this.abandonState.get(ticker);
    return s !== undefined && this.deps.clock.now() < s.until;
  }

  /** 체결에 성공했다 — 그 종목의 연속 취소 기록을 지운다. */
  private clearAbandon(ticker: string): void {
    this.abandonState.delete(ticker);
  }

  /**
   * 사이클 종료 정산 — 세션 성과 반영 → 종료 조건(AND, 금액 조정 전 판정) → 조정 또는 새 세션.
   * 수동 Stop 청산(STOP)은 금액 조정도 세션 종료 판정도 하지 않는다(성과에는 반영).
   * ⚠ 여기서 조정되는 session.amountUsd는 **성과 회계용**이다 — 진입 수량은 config.startAmountUsd만 본다.
   */
  private settle(active: ActiveCycle): void {
    const record = active.pendingSettle;
    active.pendingSettle = null;

    this.teardownActive(active);

    if (record) {
      this.rolloverDailyIfNeeded();
      this.cycles += 1;
      this.cumPnl += record.pnl;
      const session = this.session;
      if (session) {
        const usedAmount = session.amountUsd;
        session.pnl += record.pnl;
        session.cycles += 1;
        if (record.exitReason === 'SELL_SIGNAL') {
          // ★ 마틴 OFF 검사가 반드시 shouldEndSession보다 **먼저** 와야 한다.
          //   뒤로 가면 start=max 설정에서 OFF 세션이 완주해버린다.
          //   (세션 손익·사이클 수와 일일 통계는 위에서 이미 누적됐다 — OFF에서도 통계는 그대로 쌓인다.)
          if (this.config && !isMartingaleOn(this.config)) {
            this.event(
              `${record.ticker} 청산 · 손익 $${record.pnl.toFixed(2)} · 금액 고정 $${session.amountUsd.toFixed(2)}`,
            );
          } else if (this.config && shouldEndSession(record.pnl, usedAmount, session.pnl, this.config.maxAmountUsd)) {
            // 세션 종료 — 금액 조정 없이 새 세션(시작금액·성과 0).
            const endedPnl = session.pnl;
            this.session = { amountUsd: this.config.startAmountUsd, pnl: 0, cycles: 0, paused: false };
            this.sessionCount += 1;
            this.event(
              `세션 완주 · 성과 $${endedPnl.toFixed(2)} — 세션 #${this.sessionCount} 시작 · $${this.config.startAmountUsd.toFixed(2)}부터`,
            );
          } else {
            const before = session.amountUsd;
            session.amountUsd = nextAmountUsd(before, record.pnl);
            const verb =
              record.pnl > 0 ? '수익 → 금액 절반' : record.pnl < 0 ? '손실 → 금액 2배' : '본전 → 금액 유지';
            this.event(
              `${record.ticker} 청산 · 손익 $${record.pnl.toFixed(2)} · ${verb} ($${before.toFixed(2)}→$${session.amountUsd.toFixed(2)})`,
            );
          }
        } else {
          this.event(`${record.ticker} 수동 청산 · 손익 $${record.pnl.toFixed(2)} · 금액 유지`);
        }
      }
      void this.persist();
    }

    // 매도가 나면 현금이 돌아온다 — 현금 쿨다운을 즉시 푼다.
    this.cashCooldownUntil = 0;

    if (this.stopRequested && this.actives.size === 0) {
      this.finishStop();
      return;
    }
    this.reselect();
    this.emit();
  }

  // ---- 내부 ----

  /** 인터록 발동 — 자동매매 **전역** 동결. 사용자 Stop만 해제한다(기존 인스턴스와 동일 원칙). */
  private enterFault(fault: AdapterFault): void {
    if (this.faulted) return;
    const text = `자동매매를 멈췄어요 · ${faultKindLabel(fault)} — ${fault.reason}. 계좌를 확인한 뒤 Stop으로 해제해 주세요`;
    this.lastFault = { at: this.deps.clock.now(), text };
    this.faulted = true;
    for (const active of this.actives.values()) active.cycle.fault();
    this.pendingBuys.clear();
    this.stopPollTimer();
    this.deps.onFault?.(this.lastFault);
    this.event(text);
    this.emit();
  }

  private slotOf(ticker: string): FeedSlot | null {
    return this.deps.slots().find((s) => s.ticker === ticker) ?? null;
  }

  private toSnapshot(ctx: SlotSignalContext): SignalSnapshot {
    return { price: ctx.price, slope: ctx.slope, accel: ctx.accel, ts: ctx.at };
  }

  private startPollTimer(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = this.deps.scheduler.setInterval(() => {
      void this.pollCycle();
    }, this.pollIntervalMs);
    if (this.repriceTimer === null) {
      this.repriceTimer = this.deps.scheduler.setInterval(() => {
        void this.repriceTick();
      }, this.repriceIntervalMs);
    }
  }

  private stopPollTimer(): void {
    if (this.pollTimer !== null) {
      this.deps.scheduler.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.repriceTimer !== null) {
      this.deps.scheduler.clearInterval(this.repriceTimer);
      this.repriceTimer = null;
    }
  }

  /**
   * 빠른 틱(기본 1초) — 진행 중인 사이클마다 상태에 따라 하나만 한다.
   *  · SELLING → 매도 리프라이스(슬롯 최신 호가를 먼저 반영)
   *  · BUYING  → 매수 미체결 경과 판정 → 자동 포기 요청(설정을 켰을 때만)
   * 새 타이머를 만들지 않고 겸용한다 — 하네스가 인스턴스당 타이머 2개를 가정한다.
   *
   * ⚠ 자동관리는 호가를 pollCycle(2초)에서만 어댑터에 넣으므로, 여기서 슬롯의 최신 호가를 **먼저** 반영하지
   * 않으면 최대 2초 낡은 값으로 정정하게 되어 리프라이스가 사실상 무의미해진다.
   */
  private async repriceTick(): Promise<void> {
    if (this.repriceTicking || this.faulted) return;
    this.repriceTicking = true;
    try {
      for (const active of [...this.actives.values()]) {
        if (this.faulted) return;
        if (active.adapter.hasFault()) continue;
        const cycleState = active.cycle.state;
        if (cycleState !== 'SELLING' && cycleState !== 'BUYING') {
          active.buyingSince = null;
          continue;
        }
        if (cycleState === 'SELLING') {
          const quote = active.slot.quote;
          if (quote) active.adapter.setQuote(quote.bid1, quote.ask1, quote.at);
          await active.adapter.repriceSell();
        } else {
          await this.tryAbandonBuy(active);
        }
      }
    } finally {
      this.repriceTicking = false;
    }
  }

  /** 매수 미체결 자동 포기 판정 1회 — 요청 게이트 3겹(odno 확보·취소 미요청·관찰 체결량 0). */
  private async tryAbandonBuy(active: ActiveCycle): Promise<void> {
    if (this.buyCancelAfterMs <= 0) return;
    const probe = active.adapter.buyProbe();
    if (!probe) return;

    if (active.abandonRequested) {
      if (probe.verified && probe.cancelState === 'confirmed' && probe.filledQty > 0) {
        this.enterFault({
          kind: 'CANCEL',
          reason: '부분체결 상태에서 취소가 확정됐어요 — 계좌를 확인해 주세요',
        });
        return;
      }
      if (probe.cancelState === 'confirmed') await this.pollOne(active);
      return;
    }

    if (active.buyingSince === null) {
      active.buyingSince = this.deps.clock.now();
      return;
    }
    if (this.deps.clock.now() - active.buyingSince < this.buyCancelAfterMs) return;
    if (!probe.hasOdno) return;
    if (probe.cancelState !== 'none') return;
    if (probe.filledQty > 0) return; // ★ 부분체결이면 취소하지 않는다
    if (active.cycle.abandonBuy()) active.abandonRequested = true;
  }

  private event(text: string): void {
    this.lastEvent = { at: this.deps.clock.now(), text };
    this.deps.onEvent?.(this.lastEvent);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const view = this.getView();
    for (const l of this.listeners) l(view);
  }
}

function faultKindLabel(fault: AdapterFault): string {
  switch (fault.kind) {
    case 'FILL_CHECK':
      return '체결 확인 실패';
    case 'PLACE':
      return '발주 실패';
    case 'CANCEL':
      return '취소 실패';
    default:
      return '브로커 오류';
  }
}
