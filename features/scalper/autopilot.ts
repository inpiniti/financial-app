// AutoPilot — 단타 관리자 (plan: 2026-07-31_단타-자동관리 + 2026-08-05_다중그리드
//              — 세션(마틴게일 회계) 개념은 2026-08-08_세션-제거 plan으로 삭제됨).
//
// 단타 도메인의 중앙 관리자: 상태·금액·종목을 한 곳에서 관리한다.
//  · 변곡점 감지기(detector)는 **리스트 전 종목에 상시 부착**한다(2026-08-10 — 감시 교체 때 떼면
//    사다리 앵커가 리셋돼 속도가 출렁이는 주간거래에서 변곡점이 안 쌓였다). "감시(watched)" 목록은
//    자격자(minTickRate 이상) 중 틱/초 상위 3개로, 호가 예열·UI 요약용 우선순위일 뿐이다.
//    진입은 신호 시점·발주 직전 두 번의 속도 게이트가 거른다(자격 미달 종목은 신호가 떠도 진입 없음).
//  · RUN(매매 사이클)은 **동시에 여러 종목**이 가능하다(maxConcurrentGrids, 기본 3).
//    종목마다 RunCycle + OrderPortAdapter + Grid를 따로 만들고, 이미 보유·진입 중인 종목은
//    감시 후보에서 제외한다 — 즉 진입 뒤에도 변곡점 감시는 멈추지 않고 계속 돈다.
//  · 진입금액은 **설정한 고정 금액(config.startAmountUsd)**이다 — 단, 진입 수량(config.entryQty)을 지정하면 가격과 무관하게 그 수량이다(2026-08-18).
//    (그리드가 스스로 물타기로 수량을 늘리므로, 진입금액을 가변으로 두면 노출이 두 겹으로 폭주한다.)
//  · 현금 부족(매수가능금액 < 필요금액):
//      보유 그리드가 하나도 없으면 → PAUSED(입금 후 사람이 재개를 선택)
//      보유 그리드가 있으면      → 그 진입만 포기하고 신규 진입만 잠시 쉰다(기존 그리드는 계속 관리).
//
// 안전장치는 ScalperInstance와 같은 원칙: 매수 전 프리플라이트, FAULT 인터록(사용자 Stop으로만 해제),
// 미체결 무한 대기(취소는 사용자 Stop 경로에서만).
// FAULT 범위(2026-08-08 plan): **진입 경로**(프리플라이트·진입 직후 인계 실패)만 전역 동결이고,
// 관리 중 그리드의 fault는 **그 그리드만 격리**한다(gridFaulted) — 사용자가 화면을 안 보고 있어도
// 한 종목 오류로 나머지 종목 관리와 폴 타이머가 멈추지 않게 한다.

import { RunCycle, type SignalSnapshot, type TradeRecord } from '../../core/cycle';
import { entryChaseExceeded, TREND_ENTRY_GATE_QUOTE_FRESH_MS } from '../../core/trend/entryGate';
import type { ConditionalPosition } from '../../core/conditional';
import type { Signal } from '../../core/detector';
import { isDaytimeSessionOpen } from './daySession';
import { FeedSlot, type SlotSignalContext } from './feedSlot';
import { OrderPortAdapter } from './orderPortAdapter';
import {
  makePositionManager,
  resolvePositionMode,
  type GridExitConfig,
  type PositionGaugeView,
  type PositionManagementConfig,
  type PositionManager,
  type PositionPollResult,
} from './positionManager';

// 진입 후 관리(포지션 관리자) 쪽 정의 — 정본은 positionManager.ts. 기존 import 경로 호환을 위해 다시 내보낸다.
export {
  GRID_EXIT,
  INFLECTION_GRID,
  INFLECTION_THRESHOLDS,
  MANUAL_EXIT_CHECK_MS,
  TREND_CONFIG,
  type GridExitConfig,
  type InflectionGridConfig,
  type PositionManagementConfig,
  type PositionRule,
  type TrendGridConfig,
} from './positionManager';
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
export const DEFAULT_MAX_GRIDS = 1;
/** 동시 그리드 개수의 상한 — WS 호가(R) 구독 예산과 현금 분할이 감당하는 선. */
export const MAX_GRIDS_LIMIT = 6;
/** 연속 매수 취소가 이 횟수에 닿으면 그 종목 매수를 잠시 쉰다. */
export const ABANDON_COOLDOWN_STREAK = 3;
/** 매수 취소 쿨다운 길이(ms). */
export const ABANDON_COOLDOWN_MS = 60_000;
/** 현금 부족(보유 그리드가 있어 PAUSED로 안 가는 경우)에 신규 진입을 쉬는 시간(ms). */
export const CASH_COOLDOWN_MS = 60_000;
/**
 * 그리드 매수 다리 지연(ms) — 급락 방어(2026-08-14). 브래킷마다 매도는 즉시 걸고, 매수는 이 시간
 * 쉬었다가 그 시점의 min(평단, 현재가) 앵커로 건다. 매수폭(기본 5%)을 1분 안에 지나가는 건
 * 급락뿐이라 평시 비용은 사실상 0이고, 장대음봉에서만 매수가 폭락한 현재가 아래로 따라 내려간다.
 */
export const GRID_BUY_LEG_DELAY_MS = 5_000;
/** 최소 속도 기본값(틱/초) — 0 설정 불가(> 0 강제, 사용자 확정 §4-6). */
export const DEFAULT_MIN_TICK_RATE = 1;

export type AutoPilotState = 'IDLE' | 'SCANNING' | 'ENTERING' | 'HOLDING' | 'EXITING' | 'PAUSED' | 'FAULT';

/** 사용자 설정 — 진입금액·최소 속도·동시 그리드 수. */
export interface AutoPilotConfig {
  /**
   * **종목당 진입금액(USD)** — 진입 수량은 항상 floor(이 금액 ÷ 현재가)다.
   * (이름은 옛 세션 개시금액과 겸용이던 흔적 — 저장 포맷 하위호환을 위해 startAmountUsd 그대로 둔다.)
   */
  startAmountUsd: number;
  /**
   * 진입 수량(주) 고정 — 지정(> 0)하면 진입 수량은 가격과 무관하게 이 값이다(2026-08-18).
   * 미지정(undefined·0)이면 floor(startAmountUsd ÷ 현재가). 옛 저장값 호환을 위해 선택 키.
   */
  entryQty?: number;
  minTickRate: number;
  /** 동시에 열 수 있는 그리드(포지션) 최대 개수. 미지정이면 DEFAULT_MAX_GRIDS. */
  maxConcurrentGrids?: number;
}

/**
 * 트레이딩 설정 스냅샷 — 설정 정본(lib/appSettings)에서 한 번에 내려온다(2026-08-19 설정 배관 단일화).
 * config(진입금액·수량·속도·동시 종목)는 IDLE에서만 반영되고, grid·buyCancelAfterMs는 실행 중에도 즉시 반영된다.
 */
export interface TradingSettings {
  config?: AutoPilotConfig;
  /** 매도 관리 그리드 폭·배율(OCO 경로·롤백 보존). 미지정이면 그리드 경로 비활성. */
  grid?: GridExitConfig;
  /** 매수 미체결 자동 취소 대기(ms, 0=끔). */
  buyCancelAfterMs?: number;
}

/** 고정 진입 수량 단일 판정 — 미지정·0·손상값은 null(금액 계산), 양수는 정수 절사. */
export function fixedEntryQtyOf(config: Pick<AutoPilotConfig, 'entryQty'> | null | undefined): number | null {
  const raw = config?.entryQty;
  if (!Number.isFinite(raw) || (raw as number) < 1) return null;
  return Math.floor(raw as number);
}

export function maxGridsOf(config: Pick<AutoPilotConfig, 'maxConcurrentGrids'> | null | undefined): number {
  const raw = config?.maxConcurrentGrids;
  if (!Number.isFinite(raw) || (raw as number) < 1) return DEFAULT_MAX_GRIDS;
  return Math.min(Math.floor(raw as number), MAX_GRIDS_LIMIT);
}

export interface AutoPilotEvent {
  at: number;
  text: string;
}

export interface AutoPilotView {
  readonly state: AutoPilotState;
  readonly config: AutoPilotConfig | null;
  /** 현금 부족으로 일시정지 중인가 — 재개는 사람이 선택(Stop·재시작에도 유지). */
  readonly paused: boolean;
  /**
   * 감시 상위 티커(자격자 중 상위 — 0~3개). 보유·진입 중 종목은 여기 없다.
   * ⚠ 2026-08-10부터 **감지기는 리스트 전 종목에 상시 부착**된다 — 이 목록은 호가(R) 예열·UI 요약용
   * 우선순위일 뿐, 여기서 빠져도 사다리 카운트는 리셋되지 않는다.
   */
  readonly watched: readonly string[];
  /** 사이클(진입~그리드 관리)이 열려 있는 모든 티커. */
  readonly activeTickers: readonly string[];
  /** 진입 확정 대기(pendingBuys) 티커 — 매니저가 호가 구독을 미리 데우는 데 쓴다. */
  readonly entering: readonly string[];
  /** 하위호환 — activeTickers의 첫 종목(없으면 null). */
  readonly activeTicker: string | null;
  /** 동시 그리드 최대 개수(설정값). */
  readonly maxGrids: number;
  /** 오늘(미국 장 기준일) 전체 완료 사이클 수·누적 실현손익. */
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
/** 게이지(화면) 한 줄 — 포지션 관리자의 gaugeView에 종목·격리 사유를 얹은 것. */
export interface AutoPilotGridView extends PositionGaugeView {
  ticker: string;
  /** 이 종목만 멈춘 사유(종목 단위 격리) — null이면 정상. 전역 FAULT와 다르다. */
  faultText: string | null;
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
   * 진입 후 관리 설정(추세/변곡점/OCO 그리드) — 어느 모드가 켜지는지는 positionManager.resolvePositionMode가 정한다
   * (우선순위 추세 > 변곡점 > OCO, 주입 자체가 활성화 신호). 미주입이면 옛 RunCycle SELL 신호 청산 경로(하네스 하위호환).
   * grid는 applySettings로 실행 중에도 갈아끼운다(다음 인계부터).
   */
  positionManagement?: PositionManagementConfig;
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
  /** 그리드 매수 다리 지연(ms, 기본 GRID_BUY_LEG_DELAY_MS). 0이면 즉시(옛 동작) — 테스트 하네스용. */
  gridBuyLegDelayMs?: number;
  reselectIntervalMs?: number;
  hysteresisRatio?: number;
  watchCount?: number;
}

/** 진입 수량(순수) — 금액÷가격 내림. 1 미만이면 0(진입 포기 신호). */
export function qtyForAmount(amountUsd: number, price: number): number {
  if (!Number.isFinite(amountUsd) || !Number.isFinite(price) || price <= 0) return 0;
  return Math.floor(amountUsd / price);
}

/**
 * 설정 검증(순수) — 진입금액 > 0, 최소 속도 > 0, 동시 그리드 ≥ 1. 문제 없으면 null, 있으면 사용자 문구.
 * ⚠ restore()가 이 함수로 저장값을 필터링하므로, 규칙을 **엄격하게** 바꾸면 기존 설정이 조용히 소실된다.
 *    그래서 maxConcurrentGrids는 미지정(undefined)을 허용한다 — 기존 저장값이 살아남아야 한다.
 */
export function validateConfig(config: AutoPilotConfig): string | null {
  if (!Number.isFinite(config.startAmountUsd) || config.startAmountUsd <= 0) {
    return '금액은 0보다 큰 달러 금액으로 입력해 주세요';
  }
  if (!Number.isFinite(config.minTickRate) || config.minTickRate <= 0) {
    return '최소 속도는 0보다 크게 입력해 주세요 (기본 1틱/초)';
  }
  if (config.entryQty !== undefined && config.entryQty !== 0) {
    if (!Number.isFinite(config.entryQty) || config.entryQty < 1 || !Number.isInteger(config.entryQty)) {
      return '진입 수량은 1 이상의 정수로 입력해 주세요 (비우면 진입금액으로 계산)';
    }
  }
  if (config.maxConcurrentGrids !== undefined) {
    const n = config.maxConcurrentGrids;
    if (!Number.isFinite(n) || n < 1 || n > MAX_GRIDS_LIMIT) {
      return `동시 그리드 수는 1~${MAX_GRIDS_LIMIT} 사이로 입력해 주세요`;
    }
  }
  return null;
}

/** 미국 정규장(ET 09:30~16:00, LULD 적용 시간)인가 — 서킷 감지 게이트(2026-08-19). 서머타임은 Intl이 처리한다. */
export function isUsRegularSession(epochMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
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
  /**
   * 이 종목의 시세 슬롯. **입양(adopt) 포지션은 null일 수 있다** — 잔고에는 있지만 단타 리스트에
   * 올라와 있지 않은 종목(어제 남은 물량 등)이면 슬롯이 없다. 현재가 화살표만 못 그릴 뿐 관리는 된다.
   */
  slot: FeedSlot | null;
  adapter: OrderPortAdapter;
  /**
   * 변곡점 진입 사이클. **입양 포지션은 null이다** — 우리가 산 게 아니라 계좌에 이미 있던 물량이라
   * 진입 기록도, 매수 주문도 없다. 관리는 처음부터 그리드가 전담한다.
   */
  cycle: RunCycle | null;
  /** 잔고에서 주워 온 포지션인가(= cycle === null). 정산·Stop 문구가 갈린다. */
  adopted: boolean;
  /** 이 사이클의 브로커 — 그리드 발주에 재사용한다(진입 어댑터와 같은 브로커). */
  broker: ScalperBroker;
  /** 포지션 관리자(추세/변곡점/OCO 어댑터) — 인계 후. 관리 모드가 없으면(옛 경로) null. */
  cond: PositionManager | null;
  /**
   * 이 그리드만 격리 동결됐는가(전역 FAULT 아님) — 폴에서 건너뛰고 다른 종목은 계속 관리한다.
   * 사유는 grid.faultText에 있다. 해제는 Stop 후 "보유 종목 등록"(adoptPosition) 재등록.
   */
  gridFaulted: boolean;
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

/** 영속 v4(2026-08-19) — 상태만(일시정지·일별 누계). 설정값은 lib/appSettings가 정본이라 더 저장하지 않는다. */
interface PersistedV4 {
  version: 4;
  /** 현금 부족 일시정지 — 재시작에도 복원돼야 한다(자동 재개 금지). */
  paused: boolean;
  daily: { date: string; cycles: number; cumPnl: number } | null;
}

/** 옛 저장 포맷(마이그레이션 파싱 전용) — v3는 config 동봉, v2는 세션, v1은 baseAmountUsd 단일 값. */
interface LegacyPersisted {
  version?: number;
  config?: (AutoPilotConfig & { maxAmountUsd?: number; martingale?: boolean }) | null;
  session?: { amountUsd?: number; paused?: boolean } | null;
  daily?: { date?: string; sessionCount?: number; cycles?: number; cumPnl?: number } | null;
  paused?: boolean;
  baseAmountUsd?: number;
}

type Listener = (view: AutoPilotView) => void;

export class AutoPilot {
  private readonly deps: AutoPilotDeps;
  private readonly pollIntervalMs: number;
  private readonly repriceIntervalMs: number;
  /**
   * 매수 미체결 자동 취소 대기(ms, 0=끔). deps에서 **초기값만** 받고 이후 setBuyCancelAfterMs로 바꾼다 —
   * 설정 탭 저장이 앱 재시작 전까지 먹지 않던 문제(gridConfig와 같은 원인)를 여기서도 막는다.
   */
  private buyCancelAfterMs: number;
  private readonly gridBuyLegDelayMs: number;
  private readonly reselectIntervalMs: number;
  private readonly hysteresisRatio: number;
  private readonly watchCount: number;

  /** start()~finishStop() 사이인가. 전역 state는 이 플래그·faulted·paused에서 파생된다. */
  private running = false;
  /** 전역 인터록 — 사용자 Stop으로만 해제. */
  private faulted = false;
  private config: AutoPilotConfig | null = null;
  /** 현금 부족 일시정지 — Stop·FAULT·재시작에도 유지되고, 사람이 재개해야 풀린다. */
  private paused = false;
  private dailyDate: string | null = null;
  private watchedTickers: string[] = [];
  /**
   * 진입 후 관리 설정 — deps에서 초기값, grid는 applySettings로 갈아끼운다(설정 탭에서 폭을 바꿔도 매니저 싱글턴이
   * 캐시돼 옛 값으로 돌던 버그 방지). 이미 인계된 관리자는 자기 설정을 캡처하므로 **다음 인계부터** 적용된다.
   */
  private positionManagement: PositionManagementConfig | undefined;
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

  /**
   * 직전 폴에서 본 세션(미국 주간거래 창 여부) — 그리드 주문 재등록 판정용.
   * null이면 미관측(다음 폴이 기준점만 잡는다). 폴 타이머가 꺼질 때 리셋한다 —
   * 그리드 없이 세션이 바뀐 뒤 새 그리드가 열리면, 방금 현 세션으로 발주한 주문을
   * 낡은 기준점과 비교해 헛되이 재등록하는 일을 막는다.
   */
  private lastDaytime: boolean | null = null;

  private pollTimer: unknown = null;
  /** 매도 리프라이스 타이머(폴 타이머와 함께 켜고 끈다). */
  private repriceTimer: unknown = null;
  /** 리프라이스 틱 재진입 방지. */
  private repriceTicking = false;
  private reselectTimer: unknown = null;
  private readonly listeners = new Set<Listener>();

  constructor(deps: AutoPilotDeps) {
    this.deps = deps;
    this.positionManagement = deps.positionManagement ? { ...deps.positionManagement } : undefined;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.repriceIntervalMs = deps.repriceIntervalMs ?? 1000;
    this.buyCancelAfterMs = deps.buyCancelAfterMs ?? 0;
    this.gridBuyLegDelayMs = deps.gridBuyLegDelayMs ?? GRID_BUY_LEG_DELAY_MS;
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
      paused: this.paused,
      watched: [...this.watchedTickers],
      activeTickers,
      entering: [...this.pendingBuys.keys()],
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
    if (this.paused) return 'PAUSED';
    let entering = this.pendingBuys.size > 0;
    let exiting = false;
    let holding = false;
    for (const a of this.actives.values()) {
      if (!a.cycle) {
        holding = true; // 입양 포지션 — 진입 사이클 없이 곧장 보유 상태다.
        continue;
      }
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
      if (!active.cond) continue;
      out.push({
        ticker: active.ticker,
        ...active.cond.gaugeView(),
        faultText: active.gridFaulted ? (active.cond.faultText ?? `${active.cond.label}가 멈췄어요`) : null,
      });
    }
    return out;
  }

  /** 진입 후 관리 모드 — 판정은 positionManager.resolvePositionMode 한 곳(추세 > 변곡점 > OCO). null이면 옛 RunCycle SELL 경로. */
  private get positionMode() {
    return resolvePositionMode(this.positionManagement);
  }

  /**
   * 트레이딩 설정 스냅샷 적용 — 설정 정본에서 내려온 값을 **한 번에** 받는다(항목별 setter 없음).
   * grid·buyCancelAfterMs는 즉시, config는 IDLE에서만(거절 사유 문자열 반환, 나머지는 그대로 적용된다).
   */
  applySettings(settings: TradingSettings): string | null {
    if ('grid' in settings) this.applyGridConfig(settings.grid);
    if (settings.buyCancelAfterMs !== undefined) this.applyBuyCancelAfterMs(settings.buyCancelAfterMs);
    return settings.config ? this.setConfig(settings.config) : null;
  }

  /**
   * 그리드 폭·매수배율 교체 — **실행 중에도 안전하다.**
   * 이미 걸린 그리드는 자기 폭을 그대로 유지하고(주문이 이미 접수돼 있다), 다음 진입부터 새 값이 쓰인다.
   * 현재 값과 같으면 아무것도 하지 않는다(불필요한 이벤트·리렌더 방지).
   */
  private applyGridConfig(config: GridExitConfig | undefined): void {
    const prev = this.positionManagement?.grid;
    if (
      prev === config ||
      (prev !== undefined &&
        config !== undefined &&
        prev.buyWidth === config.buyWidth &&
        prev.sellWidth === config.sellWidth &&
        prev.buyMultiplier === config.buyMultiplier)
    ) {
      return;
    }
    this.positionManagement = { ...(this.positionManagement ?? {}), grid: config };
    if (config) {
      this.event(
        `그리드 설정 적용 · 매수 −${(config.buyWidth * 100).toFixed(1)}% · 매도 +${(config.sellWidth * 100).toFixed(1)}% · 매수 배율 ${config.buyMultiplier}배 (다음 그리드부터)`,
      );
    }
    this.emit();
  }

  /**
   * 매수 미체결 취소 대기 교체(설정 탭 저장 반영). **실행 중에도 안전하다** — 판정은 매 리프라이스 틱마다
   * 현재 값을 읽으므로, 이미 대기 중인 매수도 다음 틱부터 새 기준(buyingSince로부터의 경과)으로 잰다.
   */
  private applyBuyCancelAfterMs(ms: number): void {
    const next = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (next === this.buyCancelAfterMs) return;
    this.buyCancelAfterMs = next;
    this.event(next > 0 ? `매수 미체결 취소 ${Math.round(next / 1000)}초로 적용했어요` : '매수 미체결 취소를 껐어요');
  }

  /** 현재 그리드 설정(읽기 전용) — UI 표시용. 그리드를 쓰지 않는 하네스면 undefined. */
  get gridSettings(): GridExitConfig | undefined {
    const grid = this.positionManagement?.grid;
    return grid ? { ...grid } : undefined;
  }

  // ---- 설정/영속화 ----

  /**
   * 진입 설정(금액·수량·속도·동시 종목) — IDLE에서만. 검증 실패 문구를 반환한다(성공 시 null).
   * 저장하지 않는다 — 정본은 lib/appSettings이고 부팅·포커스마다 applySettings로 다시 내려온다. 같은 값이면 no-op.
   */
  setConfig(config: AutoPilotConfig): string | null {
    if (this.state !== 'IDLE') return '설정은 정지 상태에서 바꿀 수 있어요';
    const error = validateConfig(config);
    if (error) return error;
    const prev = this.config;
    if (
      prev &&
      prev.startAmountUsd === config.startAmountUsd &&
      (prev.entryQty ?? 0) === (config.entryQty ?? 0) &&
      prev.minTickRate === config.minTickRate &&
      (prev.maxConcurrentGrids ?? DEFAULT_MAX_GRIDS) === (config.maxConcurrentGrids ?? DEFAULT_MAX_GRIDS)
    ) {
      return null;
    }
    this.config = { ...config };
    this.emit();
    return null;
  }

  /**
   * 재시작 복원 — v4 paused·일일 통계.
   * 옛 포맷 마이그레이션: v3는 동봉된 config를 **폴백**으로만 승계(정본 appSettings가 부팅 때 덮어쓴다),
   * v2(세션)는 config에서 maxAmountUsd·martingale을 버리고 session.paused만 승계, v1(baseAmountUsd)은 진입금액으로 승계.
   * 어느 경우든 다음 저장은 v4(설정값 없음)다.
   */
  async restore(): Promise<void> {
    const raw = await this.deps.storage.getItem(AUTOPILOT_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedV4> & LegacyPersisted;
      if (parsed.version === 4) {
        this.paused = parsed.paused === true;
        if (parsed.daily && typeof parsed.daily.date === 'string') {
          this.dailyDate = parsed.daily.date;
          this.cycles = parsed.daily.cycles ?? 0;
          this.cumPnl = parsed.daily.cumPnl ?? 0;
        }
      } else if (parsed.version === 3) {
        if (parsed.config && validateConfig(parsed.config) === null) this.config = parsed.config;
        this.paused = parsed.paused === true;
        if (parsed.daily && typeof parsed.daily.date === 'string') {
          this.dailyDate = parsed.daily.date;
          this.cycles = parsed.daily.cycles ?? 0;
          this.cumPnl = parsed.daily.cumPnl ?? 0;
        }
        void this.persist();
      } else if (parsed.version === 2) {
        // v2 → v3: 세션 제거 — config의 세션 전용 키를 버리고, PAUSED 상태만 승계한다.
        if (parsed.config) {
          const { maxAmountUsd: _max, martingale: _mart, ...rest } = parsed.config;
          if (validateConfig(rest) === null) this.config = rest;
        }
        this.paused = parsed.session?.paused === true;
        if (parsed.daily && typeof parsed.daily.date === 'string') {
          this.dailyDate = parsed.daily.date;
          this.cycles = parsed.daily.cycles ?? 0;
          this.cumPnl = parsed.daily.cumPnl ?? 0;
        }
        void this.persist();
      } else if (typeof parsed.baseAmountUsd === 'number' && parsed.baseAmountUsd > 0) {
        // v1 → v3: base → 진입금액, 최소 속도 기본 1.
        this.config = {
          startAmountUsd: parsed.baseAmountUsd,
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
    const data: PersistedV4 = {
      version: 4,
      paused: this.paused,
      daily:
        this.dailyDate === null
          ? null
          : { date: this.dailyDate, cycles: this.cycles, cumPnl: this.cumPnl },
    };
    await this.deps.storage.setItem(AUTOPILOT_STORAGE_KEY, JSON.stringify(data));
  }

  /** 미국 장 기준일이 바뀌었으면 일일 통계를 리셋한다. */
  private rolloverDailyIfNeeded(): void {
    const today = etDateOf(this.deps.clock.now());
    if (this.dailyDate === today) return;
    this.dailyDate = today;
    this.cycles = 0;
    this.cumPnl = 0;
  }

  // ---- 시작/정지 ----

  /** Run — 설정 필수. 현금 부족으로 일시정지돼 있었다면 PAUSED로 진입(재개는 사람이 선택). */
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
    if (this.paused) {
      // 현금 부족으로 멈췄던 상태 — 자동 재개하지 않는다. 입금 후 사람이 재개를 누른다.
      this.reselectTimer = this.deps.scheduler.setInterval(() => this.reselect(), this.reselectIntervalMs);
      this.event('현금 부족으로 멈춰 있어요 — 입금 후 재개해 주세요');
      this.emit();
      return;
    }
    this.reselect();
    this.reselectTimer = this.deps.scheduler.setInterval(() => this.reselect(), this.reselectIntervalMs);
    const fixedQty = fixedEntryQtyOf(this.config);
    this.event(
      `자동 트레이딩을 시작했어요 · 종목당 ${fixedQty !== null ? `${fixedQty}주 고정` : `${this.config.startAmountUsd.toFixed(2)}`} · 그리드 최대 ${this.maxGrids}개`,
    );
    void this.persist();
    this.emit();
  }

  stop(): void {
    this.stopRequested = true;
    this.pendingBuys.clear();
    if (this.faulted) {
      // 인터록 해제 — 추가 주문·취소 없이 정리만(포지션은 계좌에서 수동 처리하거나 adoptPosition으로 다시 태운다).
      const abandoned = [...this.actives.keys()];
      for (const active of [...this.actives.values()]) {
        active.cycle?.stop(); // FAULT→DONE(코어가 주문 없이 종료).
        this.teardownActive(active);
      }
      if (abandoned.length > 0) {
        this.event(
          `${abandoned.join(', ')} 관리를 놓았어요 — 계좌에 남은 물량은 "보유 종목 등록"으로 그리드에 다시 태울 수 있어요`,
        );
      }
      this.finishStop();
      return;
    }
    if (this.actives.size > 0) {
      // 입양 포지션은 청산할 진입 사이클이 없고, 격리 동결된 그리드는 폴에서 빠져 있어 정산 경로가 없다
      // — 둘 다 주문이 계좌에 그대로 남는다는 걸 분명히 알리고 즉시 관리를 놓는다.
      // 조합(cond) 포지션도 즉시 놓는다 — 걸린 지정가가 없어(추격 매매 중이면 최선껏 취소) 방치 위험이 없고,
      // 파킹된 사이클을 stop하면 STOP 매도가 나가 버리므로 그리드 경로처럼 폴 완주를 기다릴 것도 없다.
      const releaseNow = [...this.actives.values()].filter(
        (a) => a.adopted || a.gridFaulted || (a.cond !== null && !a.cond.restingOrders),
      );
      if (releaseNow.length > 0) {
        const withOrders = releaseNow.filter((a) => a.cond === null || a.cond.restingOrders || a.cond.busy || a.gridFaulted);
        if (withOrders.length > 0) {
          this.event(
            `${withOrders.map((a) => a.ticker).join(', ')}의 그리드 주문은 계좌에 남아 있어요 — 필요하면 증권사 앱에서 취소하거나 "보유 종목 등록"으로 다시 태울 수 있어요`,
          );
        }
        const clean = releaseNow.filter((a) => !withOrders.includes(a));
        if (clean.length > 0) {
          this.event(
            `${clean.map((a) => a.ticker).join(', ')} 관리를 놓았어요 — 걸린 주문은 없고, 보유 물량은 "보유 종목 등록"으로 다시 태울 수 있어요`,
          );
        }
        for (const active of releaseNow) {
          active.cond?.release(); // 추격 중이던 매매 주문 최선껏 취소(결과는 기다리지 않는다).
          active.cycle?.fault(); // 주문 없이 종료 준비(파킹된 사이클용 — 입양은 cycle이 없다).
          active.cycle?.stop();
          this.teardownActive(active);
        }
      }
      if (this.actives.size === 0) {
        this.finishStop();
        return;
      }
      for (const active of this.actives.values()) active.cycle?.stop();
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
    this.event('자동 트레이딩을 정지했어요');
    void this.persist();
    this.emit();
  }

  // ---- PAUSED (현금 부족) ----

  /** 재개 — 감시 복귀(입금 후 사용자가 누른다). */
  resume(): void {
    if (this.state !== 'PAUSED') return;
    this.paused = false;
    this.cashCooldownUntil = 0;
    this.reselect();
    this.event('자동 트레이딩을 재개했어요');
    void this.persist();
    this.emit();
  }

  /**
   * 현금 부족으로 전면 정지 — **보유 그리드가 하나도 없을 때만** 부른다.
   * (그리드가 살아 있는데 여기 들어오면 폴 타이머가 꺼져 관리 중인 포지션이 방치된다.)
   */
  private enterPaused(reason: string): void {
    this.paused = true;
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

  // ---- 감시 대상 선정 (최소 속도 자격 필터) ----

  /**
   * 자격자(틱/초 ≥ minTickRate) 중 상위 watchCount 재평가. 자격자가 모자라면 빈 자리를 비워 둔다(0개 허용).
   * 감시 중 종목이 자격을 잃으면 히스테리시스와 무관하게 즉시 해제한다(저유동성 이탈이 목적).
   * 히스테리시스(기본 1.2배)는 자격자끼리의 교체에만 적용.
   *
   * ★ 다중 그리드의 핵심: **사이클이 진행 중이어도 재평가를 멈추지 않는다.**
   *   대신 이미 보유·진입 중인 종목(actives·pendingBuys)을 후보에서 제외해, 감시는 늘 "새로 살 종목"만 본다.
   */
  reselect(): void {
    if (!this.running || this.faulted || this.paused) return;
    const minRate = this.config?.minTickRate ?? DEFAULT_MIN_TICK_RATE;
    const now = this.deps.clock.now();
    const slots = this.deps.slots();
    const byTicker = new Map(slots.map((s) => [s.ticker, s]));

    // ★ 감지기는 리스트 전 종목 상시 부착(2026-08-10) — 예전처럼 감시(top3) 교체 때 감지기를
    //   떼면 attachDetector가 새 앵커로 시작해 사다리 홀 카운트가 리셋됐고, 속도가 출렁이는
    //   주간거래에서는 교체가 잦아 변곡점이 영영 안 쌓였다. 감시 목록은 이제 호가 예열·UI
    //   요약용 우선순위일 뿐이다. 이미 부착된 슬롯은 건너뛴다(재부착 = 앵커 리셋이라 금물).
    //   신규 슬롯(리스트 편입)도 이 루프가 받는다 — 리스트 변경 시 매니저가 reselect를 부른다.
    for (const s of slots) {
      if (!s.watched) s.attachDetector((signal, ctx) => this.handleSignal(signal, ctx));
    }

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

    // 감시 교체는 감지기를 건드리지 않는다(위 상시 부착 루프 참조) — 목록·이벤트만 갱신한다.
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
    // 조합 모드의 보유 종목 — BUY(물타기 후보)·SELL(익절 후보) 모두 조건부 그리드가 판정한다.
    // cond가 세워졌다는 사실 자체가 게이트다(추세/변곡점 어느 규칙이든) — 스위치를 다시 보지 않는다.
    const active0 = this.actives.get(ctx.ticker);
    if (active0?.cond) {
      if (active0.gridFaulted || this.stopRequested || !this.running || this.faulted || this.paused) return;
      active0.cond.onSignal(signal, ctx.price);
      return;
    }
    if (signal === 'BUY') {
      this.handleBuySignal(ctx);
      return;
    }
    // SELL — 보유 종목의 매도 변곡점만 의미 있다(유동성이 죽어도 사이클은 반드시 완주).
    const active = this.actives.get(ctx.ticker);
    if (active) {
      // 진입 후 관리 모드가 있으면 RunCycle SELL 경로는 쓰지 않는다 — 청산은 포지션 관리자 몫(인계 전 틈에서도).
      // 입양 포지션(cycle 없음)도 마찬가지.
      if (this.positionMode !== null || !active.cycle) return;
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
    if (this.stopRequested || !this.running || this.faulted || this.paused) return;
    if (this.actives.has(ctx.ticker) || this.pendingBuys.has(ctx.ticker)) return; // 이미 보유·진입 중
    if (this.inAbandonCooldown(ctx.ticker)) return;
    if (this.deps.clock.now() < this.cashCooldownUntil) return;
    if (this.actives.size + this.pendingBuys.size >= this.maxGrids) return; // 그리드 슬롯 만석

    const rate = this.slotOf(ctx.ticker)?.tickRate(this.deps.clock.now()) ?? 0;
    // 감지기가 전 종목에 붙으면서(2026-08-10) 느린 종목의 신호가 흔해졌다 — 프리플라이트(REST 왕복)
    // 전에 여기서 거른다. commitBuy의 재검사(발주 직전)와 이중이지만 각자 다른 시점을 지킨다.
    if (rate < (this.config?.minTickRate ?? DEFAULT_MIN_TICK_RATE)) return;
    this.pendingBuys.set(ctx.ticker, { ctx, tickRate: rate });
    this.emit();
    void this.commitBuy(ctx.ticker);
  }

  /**
   * 프리플라이트 → 속도 재검사 → 현금 검사 → 발주 확정 (종목 1개).
   * 진입금액은 **설정 고정값(config.startAmountUsd)**이다.
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

    // 진입 수량 — 고정 수량이 지정돼 있으면 가격과 무관하게 그 수량, 아니면 floor(진입금액 ÷ 현재가).
    const fixedQty = fixedEntryQtyOf(config);
    const entryAmountUsd = config.startAmountUsd;
    const qty = fixedQty ?? qtyForAmount(entryAmountUsd, ctx.price);
    if (qty < 1) {
      this.event(
        `${ctx.ticker} 진입 포기 · 진입금액($${entryAmountUsd.toFixed(2)})이 1주 가격($${ctx.price})보다 작아요`,
      );
      return giveUp();
    }

    const slot = this.slotOf(ctx.ticker);
    if (!slot) return giveUp();

    // 추격 진입 게이트(2026-08-20 둘째날 분석) — 신호가 대비 매도1호가가 +1%를 넘으면 사지 않는다.
    // 실거래 이틀 66건에서 신호가보다 +1% 이상 뛰어 체결된 진입 23건 합계 −89%(승 4) — 얇은 호가 추격의 대가.
    // 신선한 호가가 있을 때만 판정한다(없으면 기존 동작 그대로 — 게이트는 보조 방어선).
    if (this.positionMode === 'trend') {
      const gateQuote = slot.quote;
      if (
        gateQuote !== null &&
        this.deps.clock.now() - gateQuote.at <= TREND_ENTRY_GATE_QUOTE_FRESH_MS &&
        entryChaseExceeded(ctx.price, gateQuote.ask1)
      ) {
        this.event(
          `${ctx.ticker} 진입 포기 · 매도1호가 $${gateQuote.ask1}가 신호가 $${ctx.price} 대비 +${((gateQuote.ask1 / ctx.price - 1) * 100).toFixed(1)}% — 추격 상한(+1%)을 넘었어요`,
        );
        return giveUp();
      }
    }

    const broker = this.deps.makeBroker(ctx.ticker);
    const adapter = new OrderPortAdapter({ broker, clock: this.deps.clock });
    const fault = await adapter.preflightCheckFills();
    if (this.stopRequested) return giveUp();
    if (fault) {
      this.pendingBuys.delete(ticker);
      this.enterFault(fault);
      return;
    }

    // 진입 직전 속도 재검사 — 감시 선정과 신호 사이에 유동성이 죽었으면 포기.
    const rateNow = slot.tickRate(this.deps.clock.now());
    if (rateNow < config.minTickRate) {
      this.event(
        `${ctx.ticker} 진입 포기 · 속도가 ${rateNow.toFixed(1)}틱/초로 떨어져 기준(${config.minTickRate})에 못 미쳐요`,
      );
      return giveUp();
    }

    // 현금 부족 사전 판정 — 조회 실패(null/throw)면 판정 없이 진행(FAULT 인터록이 최후 방어선).
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
        // 관리 중인 포지션이 없다 — 통째로 멈추고 사람의 재개를 기다린다.
        this.enterPaused(
          `현금이 부족해서 쉬고 있어요 · 필요 $${needed.toFixed(2)} > 주문가능 $${buyable.toFixed(2)} — 입금 후 재개해 주세요`,
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
      cycle: null, // 바로 아래에서 채운다 — onTrade 클로저가 active를 참조해야 해서 두 단계로 나눈다.
      adopted: false,
      broker,
      cond: null,
      gridFaulted: false,
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
      `${ctx.ticker} 진입 · ${qty}주 × ${ctx.price} (${fixedQty !== null ? `고정 수량 ${fixedQty}주` : `진입금액 ${entryAmountUsd.toFixed(2)}`}) · 그리드 ${this.actives.size}/${this.maxGrids}`,
    );
    this.reselect(); // 빈 감시 자리를 즉시 채운다.
    this.emit();
  }

  // ---- 사이클 폴링/정산 ----

  private pollingCycle = false;

  /** 체결 폴링 1회 — 진행 중인 모든 사이클을 순회한다(종목 간 독립, 한 종목 FAULT면 전역 인터록). */
  async pollCycle(): Promise<void> {
    if (this.faulted) return;
    // 재진입 방지 — 리브래킷 버스트(REST 4~6 왕복)가 폴 주기(2초)를 넘기면 다음 타이머 폴이
    // 겹쳐 들어와 같은 그리드에 fetchFills·발주가 중복 실행되고 KIS 유량(EGW00201)을 배로 태운다.
    if (this.pollingCycle) return;
    this.pollingCycle = true;
    try {
      await this.rotateGridSessionIfNeeded();
      if (this.faulted) return;
      for (const active of [...this.actives.values()]) {
        if (this.faulted) return;
        if (!this.actives.has(active.ticker)) continue; // 이번 순회 중 정산돼 사라졌다.
        await this.pollOne(active);
      }
    } finally {
      this.pollingCycle = false;
    }
  }

  /** 사이클 1개 폴 — 인스턴스와 같은 순서: fault 회수 → refreshFills → cycle.poll → 정산. */
  private async pollOne(active: ActiveCycle): Promise<void> {
    const pending = active.adapter.takeFault();
    if (pending) {
      this.enterFault(pending);
      return;
    }

    // 격리 동결된 그리드 — 건너뛴다(주문은 계좌에 남아 있고, 다른 종목 관리는 계속).
    if (active.gridFaulted) return;

    // 조합 모드 인계 완료 — 진행 중 매매(있으면)를 폴한다. 매매가 없으면 폴할 주문 자체가 없다(조건부).
    if (active.cond) {
      await this.pollConditional(active);
      return;
    }

    // 입양 포지션은 포지션 관리자가 유일한 관리 주체다 — arm에 실패했다면 폴할 것이 없다(슬롯만 반납).
    if (!active.cycle || !active.slot) {
      this.teardownActive(active);
      this.emit();
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
      // 진입 체결 → 포지션 관리자 인계(모드는 팩토리가 정한다). 인계 실패는 인터록(armPosition이 건다).
      if (this.positionMode !== null && !active.cond && !active.arming) {
        const armed = await this.armPosition(active, { interlockOnFailure: true });
        if (!armed) return;
        this.emit();
        return;
      }
    }
    this.emit();
    if (active.cycle.state === 'DONE') this.settle(active);
  }

  // ---- 진입 후 관리 인계(포지션 관리자) ----

  /**
   * 진입 체결(또는 입양) 후 포지션 관리자 인계 — 평단·수량은 진입 체결(폴백=잔고)에서 읽고, 어댑터 선택·규칙 조립은
   * 팩토리(positionManager.makePositionManager)가 한다. 실패하면 interlockOnFailure에 따라 전역 인터록(방금 산 주식이
   * 방치되는 상황) 또는 그 종목만 포기(입양 — 계좌 상태가 달라진 것뿐).
   */
  private async armPosition(active: ActiveCycle, opts: { interlockOnFailure: boolean }): Promise<boolean> {
    const mode = this.positionMode;
    if (mode === null) return false;
    active.arming = true;
    try {
      const entry = active.cycle?.position;
      let seed: ConditionalPosition | null = entry ? { qty: entry.qty, avgPrice: entry.entryPrice } : null;
      if (!seed) {
        try {
          seed = await active.broker.fetchPosition();
        } catch {
          seed = null;
        }
      }
      if (this.stopRequested) return false;
      const ticker = active.ticker;
      const pos = active.cycle?.position ?? null;
      const manager = makePositionManager(mode, this.positionManagement!, {
        ticker,
        broker: active.broker,
        clock: this.deps.clock,
        price: () => {
          const v = active.slot?.getView();
          return v ? { price: v.price, lastTradeAt: v.lastTradeAt, dayLow: v.dayLow, dayHigh: v.dayHigh } : null;
        },
        regularSession: isUsRegularSession,
        fetchBuyableUsd: this.deps.fetchBuyableUsd ? (price) => this.deps.fetchBuyableUsd!(ticker, price) : undefined,
        entry: pos ? { entryTs: pos.entryTs, entrySnapshot: pos.entrySnapshot } : null,
        adopted: active.adopted,
        feeRate: this.deps.feeRate,
        mayStart: () => !this.stopRequested && !this.faulted && !active.gridFaulted && this.actives.has(ticker),
        onEvent: (text) => this.event(text),
        buyLegDelayMs: this.gridBuyLegDelayMs,
        // ⚠ 다중 그리드에서는 가용현금을 **동시 그리드 수로 나눠** 배정한다. 안 그러면 그리드 3개가 같은 현금을
        //   각자 "전부 내 것"으로 보고 물타기 매수를 걸어, 셋 다 걸리면 계좌가 즉시 잠긴다.
        fetchAvailableCash: async (buyPrice) => {
          const cash = await this.deps.fetchBuyableUsd?.(ticker, buyPrice);
          return typeof cash === 'number' && Number.isFinite(cash) ? cash / this.maxGrids : null;
        },
      });
      const r = await manager.arm(seed);
      if (!r.ok) {
        if (opts.interlockOnFailure) this.enterFault({ kind: 'PLACE', reason: r.reason });
        return false;
      }
      active.cond = manager;
      this.emit();
      return true;
    } finally {
      active.arming = false;
    }
  }

  // ---- 잔고 보유분 입양(FAULT 이후 복구·수동 편입) ----

  /**
   * 계좌에 이미 있는 보유분을 그리드 관리에 등록한다 — FAULT로 관리를 놓친 물량을 되찾는 주 경로.
   *
   * 진입 사이클 없이 그리드만 만들고, 수량·평단은 **KIS 잔고에서 그대로 읽는다**(Grid.arm → fetchPosition).
   * 성공하면 null, 실패하면 사용자에게 보여줄 문구를 반환한다.
   *
   * ⚠ 계좌에는 자동매매와 무관한 장기 보유분이 섞여 있을 수 있다 — 그래서 전 종목 자동 편입은 하지 않고
   *   **호출자(사용자)가 종목을 하나씩 지정**하게 한다.
   */
  async adoptPosition(ticker: string): Promise<string | null> {
    if (!this.running) return '자동 트레이딩을 먼저 시작해 주세요';
    if (this.faulted) return '멈춤 상태예요 — 먼저 Stop으로 해제해 주세요';
    if (this.paused) return '일시정지 중이에요 — 재개한 뒤 다시 시도해 주세요';
    if (this.positionMode === null) return '그리드 관리가 꺼져 있어 등록할 수 없어요';
    if (this.actives.has(ticker) || this.pendingBuys.has(ticker)) return `${ticker}은(는) 이미 관리 중이에요`;
    if (this.actives.size + this.pendingBuys.size >= this.maxGrids) {
      return `동시 그리드 수(${this.maxGrids}개)가 꽉 찼어요 — 설정에서 늘리거나 기다려 주세요`;
    }

    const broker = this.deps.makeBroker(ticker);
    const active: ActiveCycle = {
      ticker,
      slot: this.slotOf(ticker), // 리스트에 없으면 null — 현재가 화살표만 안 뜬다.
      adapter: new OrderPortAdapter({ broker, clock: this.deps.clock }),
      cycle: null,
      adopted: true,
      broker,
      cond: null,
      gridFaulted: false,
      buyingSince: null,
      abandonRequested: false,
      pendingSettle: null,
      arming: false,
    };
    // 슬롯을 먼저 잡는다 — arm이 await라, 그 사이 들어온 변곡점 신호가 같은 자리를 가져가면 안 된다.
    this.actives.set(ticker, active);
    this.deps.pin(ticker);
    this.watchedTickers = this.watchedTickers.filter((t) => t !== ticker);

    // 입양은 진입 기록이 없어 물타기 고정 수량(entryQty)이 등록 시점 보유 수량으로 잡힌다(문서상 "최초 진입 수량"의 입양 해석).
    const armed = await this.armPosition(active, { interlockOnFailure: false });
    if (!armed) {
      this.actives.delete(ticker);
      this.deps.unpin(ticker);
      this.reselect();
      this.emit();
      return `${ticker} 등록에 실패했어요 — 잔고에 수량이 없거나 주문이 거절됐어요`;
    }

    this.startPollTimer();
    this.reselect();
    this.emit();
    return null;
  }

  /**
   * 세션 전환(정규장↔주간거래, KST 10:00/16:00 경계) 감지 — 쉬는 주문을 가진 포지션 관리자(OCO)에게 재등록을 맡긴다.
   * (KIS는 세션이 끝나면 미체결을 일괄 취소한다 — 자세한 이유는 OcoGridPositionManager.rotateSession.)
   */
  private async rotateGridSessionIfNeeded(): Promise<void> {
    const daytime = isDaytimeSessionOpen(this.deps.clock.now());
    if (this.lastDaytime === null || daytime === this.lastDaytime) {
      this.lastDaytime = daytime;
      return;
    }
    this.lastDaytime = daytime;
    const label = daytime ? '주간거래' : '정규장';
    for (const active of [...this.actives.values()]) {
      if (this.faulted) return;
      if (!this.actives.has(active.ticker)) continue;
      if (!active.cond?.rotateSession || active.gridFaulted) continue;
      const r = await active.cond.rotateSession(label);
      if (r) this.applyPositionResult(active, r);
    }
  }

  /** 포지션 관리자 폴 1회 — 결과값으로 정산·격리만 한다. */
  private async pollConditional(active: ActiveCycle): Promise<void> {
    this.applyPositionResult(active, await active.cond!.poll());
  }

  private applyPositionResult(active: ActiveCycle, r: PositionPollResult): void {
    switch (r.kind) {
      case 'sold':
        active.pendingSettle = r.record;
        this.deps.onTrade?.(r.record);
        this.settle(active);
        return;
      case 'isolated':
        this.isolateConditional(active, r.reason);
        return;
      default:
        this.emit();
        return;
    }
  }

  /** 조합 관리 격리 동결 — 전역이 아니라 이 종목만(OCO 그리드의 gridFaulted와 같은 원칙). */
  private isolateConditional(active: ActiveCycle, reason: string): void {
    active.gridFaulted = true;
    this.event(
      `${active.ticker} ${active.cond?.label ?? '그리드'}가 멈췄어요 — ${reason}. 이 종목 주문은 계좌에서 확인해 주세요 · 다른 종목은 계속 관리해요`,
    );
    this.emit();
  }

  /**
   * 진행 중 사이클의 자원을 정리한다 — detector 해제, 핀 해제, 맵에서 제거.
   * ⚠ 핀(`pin`)은 `commitBuy`에서 걸리고 여기서만 풀린다. 이 경로를 거치지 않으면 워치리스트가 영구 오염된다.
   */
  private teardownActive(active: ActiveCycle): void {
    active.slot?.detachDetector();
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
    active.cycle?.stop(); // WATCH_BUY→DONE (이 전이는 포트를 호출하지 않는다 — 폐기 위생용)
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

  /** 사이클 종료 정산 — 일일 통계(사이클 수·누적 손익)만 반영한다. 진입금액은 항상 설정 고정값이다. */
  private settle(active: ActiveCycle): void {
    const record = active.pendingSettle;
    active.pendingSettle = null;

    this.teardownActive(active);

    if (record) {
      this.rolloverDailyIfNeeded();
      this.cycles += 1;
      this.cumPnl += record.pnl;
      this.event(
        `${record.ticker} ${exitReasonLabel(record.exitReason)} · 손익 ${record.pnl.toFixed(2)}`,
      );
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
    for (const active of this.actives.values()) active.cycle?.fault();
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
    this.lastDaytime = null; // 세션 기준점 리셋 — 다음 그리드가 열릴 때 그 시점 세션으로 다시 잡는다.
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
        // 조합 매매 추격 — 최신 현재가로 취소선 판정·정정을 구동한다(재정정 스로틀은 Execution 내부).
        if (active.cond) {
          if (!active.gridFaulted) {
            await active.cond.tick({ canStart: this.running && !this.paused && !this.stopRequested });
          }
          continue;
        }
        if (!active.cycle || !active.slot) continue; // 입양 포지션 — 리프라이스할 주문도, 매수 시계도 없다.
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
    if (active.cycle?.abandonBuy()) active.abandonRequested = true;
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

/** 정산 이벤트 문구 — 청산 사유별. */
function exitReasonLabel(reason: TradeRecord['exitReason']): string {
  switch (reason) {
    case 'SELL_SIGNAL':
      return '청산';
    case 'STOP_LOSS':
      return '손절 청산';
    case 'CIRCUIT':
      return '서킷 청산';
    case 'MANUAL':
      return '수동 청산(앱 밖)';
    default:
      return '수동 청산';
  }
}
