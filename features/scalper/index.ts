// features/scalper 공개 API — 6단계 단타 탭 UI가 여기서 가져다 쓴다.
// (vitest 테스트는 이 배럴이 아니라 개별 모듈을 직접 import한다 — expo-keep-awake 등 네이티브 의존 격리.)
export * from './types';
export { ScalperManager } from './scalperManager';
export type { ScalperManagerDeps } from './scalperManager';
export { OrderPortAdapter } from './orderPortAdapter';
export type { OrderPortAdapterOptions } from './orderPortAdapter';
export {
  appendTradeRecord,
  readTodayTrades,
  readTradesByDate,
  formatTradeDate,
  tradeKeyFor,
  TRADE_KEY_PREFIX,
} from './tradeStore';
export type { StoredTrade } from './tradeStore';
export { TickRateMeter, DEFAULT_TICK_RATE_WINDOW_MS, DEFAULT_TICK_RATE_HISTORY_MS } from './tickRate';
export {
  SlopeMeter,
  DEFAULT_SLOPE_WINDOW_MS,
  DEFAULT_SLOPE_MIN_SPAN_MS,
  DEFAULT_SLOPE_HISTORY_MS,
} from './slopeRate';
export {
  ScalperWatchlist,
  computeDesired,
  WATCH_SOURCES,
  WATCH_SOURCE_LABEL,
  WATCH_SLOTS_PER_SOURCE,
  WATCHLIST_POLL_INTERVAL_MS,
} from './watchlist';
export type { RankingSnapshot, WatchCandidateRow, WatchEntry, WatchlistDiff } from './watchlist';
export { FeedSlot } from './feedSlot';
export type { FeedSlotView, SlotSignalContext } from './feedSlot';
export {
  AutoPilot,
  AUTOPILOT_STORAGE_KEY,
  GRID_EXIT,
  maxGridsOf,
  DEFAULT_MAX_GRIDS,
  MAX_GRIDS_LIMIT,
  CASH_COOLDOWN_MS,
  DEFAULT_MIN_TICK_RATE,
  etDateOf,
  qtyForAmount,
  validateConfig,
} from './autopilot';
export type {
  AutoPilotConfig,
  AutoPilotDeps,
  AutoPilotEvent,
  AutoPilotGridView,
  AutoPilotState,
  AutoPilotView,
  GridExitConfig,
} from './autopilot';
export { AutoPilotManager, AUTOPILOT_TRADE_ID } from './autopilotManager';
export type { AutoPilotManagerDeps, AutoPilotSlotRow } from './autopilotManager';
export { createKisBroker } from './createKisBroker';
export type { KisBrokerConfig } from './createKisBroker';
export { createRealtimeFeed } from './createRealtimeFeed';
export type { RealtimeFeedConfig } from './createRealtimeFeed';
export { expoKeepAwake } from './keepAwake';
