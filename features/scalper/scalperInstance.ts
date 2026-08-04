// ScalperInstance — 인스턴스 1개의 러너.
// WS 틱 → Resampler(3초 청크) → TrendDetector(SG 1·2차 미분·변곡점) → RunCycle(주문·청산) 를 잇는다.
// RunCycle의 동기 OrderPort는 OrderPortAdapter가 KIS async REST로 브리징한다.
//
// 성능 계약(PRD §4-E / expo-react-native-performance):
//   - 매 틱마다 리스너를 발행하지 않는다. 상태 전이·변곡점 신호 시에만 즉시 발행하고,
//     현재가 등 수치 변화는 throttleMs(기본 1000ms) 간격으로만 발행한다.
//   - 연산·상태 추적은 전부 이 클래스 내부(비 React) — UI는 subscribe로만 관찰한다.
import { Resampler } from '../../core/resample';
import { TrendDetector } from '../../core/detector';
import { RunCycle, type SignalSnapshot, type TradeRecord } from '../../core/cycle';
import { OrderPortAdapter } from './orderPortAdapter';
import type {
  AdapterFault,
  AutoRunNote,
  ClockLike,
  InstanceFault,
  ScalperBroker,
  ScalperInstanceConfig,
  ScalperInstanceView,
  SchedulerLike,
  Signal,
  TickExtras,
} from './types';

/**
 * 오토런 손익 판정 수량 — 사용자 명세.
 *  · 벌었으면(pnl > 0): 절반(반올림), 최소 1.
 *  · 잃었으면(pnl <= 0): 2배.
 */
export function nextAutoRunQty(qty: number, pnl: number): number {
  if (pnl > 0) return Math.max(1, Math.round(qty / 2));
  return qty * 2;
}

export interface ScalperInstanceDeps {
  broker: ScalperBroker;
  clock: ClockLike;
  /** 폴 타이머 주입(기본 global). */
  scheduler?: SchedulerLike;
  /** 체결 폴링·poll() 구동 주기(ms). 기본 2000. */
  pollIntervalMs?: number;
  /**
   * 매도 리프라이스 주기(ms). 기본 1000 — 매수1호가가 바뀐 경우에만 정정을 내므로
   * 호가가 잠잠하면 네트워크 호출이 0회다(유량 절감).
   */
  repriceIntervalMs?: number;
  /** 리샘플 청크 초(기본 3). */
  chunkSeconds?: number;
  /** SG 버퍼 크기(홀수, 기본 31). */
  bufferSize?: number;
  /**
   * 매수 모멘텀 문턱(상대 기울기, "%/청크" 소수) — detector에 그대로 주입한다.
   * 미지정 시 detector 기본(0.0001=0.01%/청크). 0이면 끔(전환 즉시 매수).
   */
  minBuyMomentum?: number;
  /**
   * 매도 모멘텀 문턱(하락 상대 기울기 크기, "%/청크" 소수) — detector에 그대로 주입한다.
   * 미지정 시 detector 기본(0.00005=0.005%/청크). 0이면 끔(전환 즉시 매도, 하위호환).
   * 매수와 의미가 다르다: 대기 만료 시 반드시 매도한다(방어선 보존).
   */
  minSellMomentum?: number;
  /** BUY 거래량 스파이크 게이트(배수, 0=끔) — detector에 그대로 주입. SELL과 무관. */
  minVolumeSpikeRatio?: number;
  /** BUY 체결강도 게이트(STRN, 0=끔) — detector에 그대로 주입. SELL과 무관. */
  minStrength?: number;
  /**
   * @deprecated 무한 대기로 전환돼 더 이상 쓰이지 않는다(자동 타임아웃 취소 제거). 호출부 호환을 위해만 남긴다.
   */
  fillTimeoutMs?: number;
  /**
   * Run 시 버퍼 신선도 판정 기준(ms, 기본 30000). 마지막 틱이 이보다 오래됐으면(끊겼던 데이터로 보고)
   * 리샘플러·detector를 리셋해 처음부터 워밍업한다. 그보다 신선하면 이미 쌓인 버퍼를 이어서 쓴다.
   */
  bufferStaleMs?: number;
  /** 수치 발행 스로틀(ms, 기본 1000). */
  throttleMs?: number;
  /** 사이클 종료 시 거래 기록 발행 — 매니저가 tradeStore에 연결. */
  onTrade?: (instanceId: string, record: TradeRecord) => void;
  /** async 오류 통지(발주·취소·폴링 실패). */
  onError?: (err: unknown) => void;
  /** 안전 인터록 발동 통지 — 매니저가 진단 이벤트(lastFeedEvent)로 노출한다. */
  onFault?: (instanceId: string, fault: InstanceFault) => void;
  /**
   * 오토런 이벤트 통지 — 매니저가 진단 이벤트 노출 + 재시작 수량 영속화 + keep-awake 재평가에 쓴다.
   * qty는 재시작에 적용된 새 수량이다. 수량 상한은 없다(무제한 재시작).
   */
  onAutoRun?: (instanceId: string, note: AutoRunNote, qty: number) => void;
}

type Listener = (view: ScalperInstanceView) => void;

const defaultScheduler: SchedulerLike = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class ScalperInstance {
  readonly id: string;
  readonly ticker: string;
  /** 현재 적용 중인 수량 — setQty()로 바뀔 수 있으므로 readonly가 아니다(공개 필드 유지, 값만 갱신). */
  qty: number;

  private readonly config: ScalperInstanceConfig;
  private readonly clock: ClockLike;
  private readonly scheduler: SchedulerLike;
  private readonly pollIntervalMs: number;
  private readonly repriceIntervalMs: number;
  private readonly fillTimeoutMs?: number;
  private readonly bufferStaleMs: number;
  private readonly throttleMs: number;
  private readonly onTradeCb?: (instanceId: string, record: TradeRecord) => void;
  private readonly onFaultCb?: (instanceId: string, fault: InstanceFault) => void;
  private readonly onAutoRunCb?: (instanceId: string, note: AutoRunNote, qty: number) => void;

  private readonly resampler: Resampler;
  private readonly detector: TrendDetector;
  private readonly adapter: OrderPortAdapter;
  /** RunCycle — setQty()가 새 qty로 재생성한다(readonly 아님). 재생성은 IDLE/DONE/FAULT에서만 일어나 진행 중 사이클을 건드리지 않는다. */
  private cycle: RunCycle;

  private readonly listeners = new Set<Listener>();

  // 관찰 상태(비 React) — subscribe로만 노출.
  private currentPrice: number | null = null;
  private slope: number | null = null;
  private accel: number | null = null;
  private warmedUp = false;
  /** 매수 모멘텀 확인 대기 중인가 — WATCH_BUY 중 카드가 "모멘텀 확인 중" 배지를 오버라이드하는 데 쓴다. */
  private momentumConfirming = false;
  /** 매도 모멘텀 확인 대기 중인가 — HOLDING 중 카드가 "매도 확인 중" 배지를 오버라이드하는 데 쓴다. */
  private sellConfirming = false;
  /** BUY 게이트(거래량/체결강도)만 매수를 막고 있는가 — 카드 "거래량/체결강도 확인 중" 배지용. */
  private buyGateBlocked = false;
  private lastSignal: Signal | null = null;
  private tickCount = 0;
  private lastTickAt: number | null = null;
  private lastQuoteAt: number | null = null;
  private bid1: number | null = null;
  private ask1: number | null = null;
  private bidVol1: number | undefined;
  private askVol1: number | undefined;
  /** pushQuote 누적 호출 횟수 — 호가 진단 시트(QuoteSheet)용 실측 카운트. */
  private quoteCount = 0;
  private sampleCount = 0;

  private prevState: string;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  /** 매도 리프라이스 타이머(폴 타이머와 별개 주기). */
  private repriceTimer: unknown = null;
  /** 리프라이스 틱 재진입 방지 — setInterval은 async를 await하지 않는다. */
  private repriceTicking = false;

  // 안전 인터록 상태 — set이면 자동매매가 동결됐고 카드에 빨간 경고가 뜬다. stop()으로만 해제.
  private faulted: InstanceFault | null = null;
  // 매수 프리플라이트(비동기)가 진행 중인가 — 같은 창에서 중복 발주를 막는다.
  private buyInFlight = false;

  // 오토런 상태.
  private autoRunEnabled = true;
  private lastAutoRun: AutoRunNote | null = null;
  /** 사이클이 자연 완료(SELL_SIGNAL)돼 오토런을 시도해야 하면 그 손익을 여기 담아 poll 종료 후 처리한다. */
  private pendingAutoRunPnl: number | null = null;

  constructor(config: ScalperInstanceConfig, deps: ScalperInstanceDeps) {
    this.config = config;
    this.id = config.id;
    this.ticker = config.ticker;
    this.qty = config.qty;
    this.clock = deps.clock;
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.repriceIntervalMs = deps.repriceIntervalMs ?? 1000;
    this.fillTimeoutMs = deps.fillTimeoutMs;
    this.bufferStaleMs = deps.bufferStaleMs ?? 30000;
    this.throttleMs = deps.throttleMs ?? 1000;
    this.onTradeCb = deps.onTrade;
    this.onFaultCb = deps.onFault;
    this.onAutoRunCb = deps.onAutoRun;
    this.autoRunEnabled = config.autoRun ?? true;

    this.resampler = new Resampler({
      chunkSeconds: deps.chunkSeconds ?? 3,
      bufferSize: deps.bufferSize ?? 31,
    });
    // 매수·매도 모멘텀 문턱과 BUY 게이트를 detector에 주입(미지정 시 detector 기본). 매도 확인 대기 한도·급락 임계는 detector 기본 사용.
    this.detector = new TrendDetector({
      minBuyMomentum: deps.minBuyMomentum,
      minSellMomentum: deps.minSellMomentum,
      minVolumeSpikeRatio: deps.minVolumeSpikeRatio,
      minStrength: deps.minStrength,
    });
    this.adapter = new OrderPortAdapter({ broker: deps.broker, onError: deps.onError, clock: deps.clock });
    this.cycle = this.buildCycle(config.qty);
    this.prevState = this.cycle.state;
  }

  /** RunCycle 생성 — 생성자·setQty()가 공유한다(qty만 다르게). */
  private buildCycle(qty: number): RunCycle {
    return new RunCycle({
      ticker: this.config.ticker,
      qty,
      port: this.adapter,
      clock: this.clock,
      fillTimeoutMs: this.fillTimeoutMs,
      onTrade: (record) => this.handleTrade(record),
    });
  }

  // ---- 구독 API (UI 구독 계약) ----

  /** 인스턴스 뷰 구독. 반환값은 해제 함수. 신호/상태 전이 시 즉시, 수치는 스로틀 발행. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getView(): ScalperInstanceView {
    const pos = this.cycle.position;
    const pnlRate =
      pos && this.currentPrice != null && pos.entryPrice > 0
        ? (this.currentPrice - pos.entryPrice) / pos.entryPrice
        : null;
    return {
      id: this.id,
      ticker: this.ticker,
      qty: this.qty,
      state: this.cycle.state,
      price: this.currentPrice,
      slope: this.slope,
      accel: this.accel,
      pnlRate,
      lastSignal: this.lastSignal,
      warmedUp: this.warmedUp,
      momentumConfirming: this.momentumConfirming,
      sellConfirming: this.sellConfirming,
      buyGateBlocked: this.buyGateBlocked,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastQuoteAt: this.lastQuoteAt,
      bid1: this.bid1,
      ask1: this.ask1,
      bidVol1: this.bidVol1,
      askVol1: this.askVol1,
      quoteCount: this.quoteCount,
      sampleCount: this.sampleCount,
      lastFault: this.faulted,
      autoRun: this.autoRunEnabled,
      lastAutoRun: this.lastAutoRun,
    };
  }

  // ---- 구동 ----

  /**
   * Run 시작 — 감시 개시(WATCH_BUY). 폴 타이머를 켠다.
   * 버퍼 처리(실기기 제보): 틱은 Run 전에도 계속 쌓이므로 무조건 리셋하면 "데이터 모으는 중 0/N"으로
   * 되돌아가는 낭비가 생긴다. 마지막 틱이 오래됐으면(bufferStaleMs 초과 — 끊겼던 데이터) 리셋해 처음부터
   * 워밍업하고, 신선하면 이미 쌓인 리샘플러·detector 상태를 이어서 쓴다.
   */
  start(): void {
    // FAULT 상태에서 직접 Run은 무시한다 — 사용자는 먼저 Stop으로 인터록을 풀어야 한다.
    if (this.faulted) return;
    if (this.isBufferStale()) {
      this.detector.reset();
      this.resampler.reset();
      this.warmedUp = false;
      this.momentumConfirming = false;
      this.sellConfirming = false;
      this.buyGateBlocked = false;
      this.sampleCount = 0;
    }
    this.cycle.start();
    this.startTimer();
    this.forceEmit();
  }

  /** 마지막 틱이 없거나 신선도 기준(bufferStaleMs)보다 오래됐으면 버퍼가 낡았다고 본다(끊겼던 데이터). */
  private isBufferStale(): boolean {
    if (this.lastTickAt === null) return true; // 아직 한 틱도 없음 — 리셋(무해).
    return this.clock.now() - this.lastTickAt > this.bufferStaleMs;
  }

  /**
   * Stop — 보유 중이면 전량 매도 후 종료(SELLING→DONE은 폴로 진행).
   * FAULT였다면 여기서 인터록을 해제한다(사용자만 해제 가능). 이후 Run(start)에서 프리플라이트가 다시 검사한다.
   */
  stop(): void {
    this.faulted = null;
    this.buyInFlight = false;
    this.adapter.takeFault(); // 남은 미회수 오류를 버려 재시작이 즉시 오염되지 않게 한다.
    this.cycle.stop();
    this.forceEmit();
  }

  /**
   * 수량 변경 — ScalperManager가 IDLE/DONE/FAULT 상태에서만 호출을 허용한다(실행 중 변경 금지는 매니저 몫).
   * 여기서도 방어적으로 한 번 더 상태를 검사한다(faultBarrier·enterFault와 같은 이중화 원칙).
   * RunCycle을 새 qty로 재생성하므로, 진행 중이던 사이클의 주문 수량엔 영향이 없다 —
   * 재생성 시점엔 이미 포지션·미체결 주문이 없는 상태(IDLE/DONE/FAULT)이기 때문이다.
   * 다음 Run(start())부터 새 수량이 적용된다.
   */
  setQty(qty: number): void {
    const state = this.cycle.state;
    if (state !== 'IDLE' && state !== 'DONE' && state !== 'FAULT') return;
    this.qty = qty;
    this.config.qty = qty;
    this.cycle = this.buildCycle(qty);
    // 새 RunCycle은 IDLE로 태어난다 — 원래 FAULT였다면 그대로 유지해 카드 빨간 경고·버튼 상태를 보존한다
    // (this.faulted 로컬 플래그는 이미 set 상태이므로 start()는 여전히 무시되고, stop()으로만 빠져나간다).
    if (state === 'FAULT') this.cycle.fault();
    this.prevState = this.cycle.state;
    this.forceEmit();
  }

  /**
   * 실시간호가 1호가 수신 — 최신 호가를 어댑터 캐시에 넘겨 공격적 지정가 발주에 쓰게 한다.
   * 신호 로직·리샘플과 무관하므로 여기서 발행(emit)하지 않는다(호가는 체결가보다 잦다 — 성능 계약).
   * 수신 사실만 lastQuoteAt/quoteCount·bid1/ask1(+잔량)에 기록해 다음 정상 발행 때(스로틀)
   * 카드·QuoteSheet가 진단용으로 노출할 수 있게 한다 — 발주 판정(resolveOrderPrice)에는 영향 없다.
   */
  pushQuote(bid1: number, ask1: number, at: number, bidVol1?: number, askVol1?: number): void {
    this.adapter.setQuote(bid1, ask1, at);
    this.lastQuoteAt = this.clock.now();
    this.quoteCount += 1;
    this.bid1 = Number.isFinite(bid1) && bid1 > 0 ? bid1 : null;
    this.ask1 = Number.isFinite(ask1) && ask1 > 0 ? ask1 : null;
    this.bidVol1 = typeof bidVol1 === 'number' && Number.isFinite(bidVol1) ? bidVol1 : undefined;
    this.askVol1 = typeof askVol1 === 'number' && Number.isFinite(askVol1) ? askVol1 : undefined;
  }

  /**
   * 발주 단가 미리보기(표시 전용) — OrderPortAdapter.previewOrderPrice에 그대로 위임한다.
   * resolveOrderPrice(실제 발주 경로)와 동일한 단일 소스를 쓰므로 로직 중복이 없다. QuoteSheet 등 읽기 전용 UI가 쓴다.
   */
  previewOrderPrice(side: 'buy' | 'sell'): { price: number; fallback: boolean } {
    return this.adapter.previewOrderPrice(side);
  }

  /** WS 틱 1개 수신(러너 진입점). 리샘플→판정→신호 전달까지 동기로 처리. */
  pushTick(price: number, tsMs: number, extras?: TickExtras): void {
    this.currentPrice = price;
    this.tickCount += 1;
    this.lastTickAt = this.clock.now();
    this.adapter.setLimitPrice(price);

    // 인터록 발동 상태거나 브로커 오류가 감지됐으면 신호를 발동하지 않는다(현재가 표시만 갱신).
    if (this.faultBarrier()) {
      this.reconcileEmit(false);
      return;
    }

    const closed = this.resampler.addTick({
      price,
      ts: tsMs,
      volume: extras?.volume,
      strength: extras?.strength,
    });
    let signalFired = false;
    if (closed !== null) {
      this.sampleCount = this.resampler.buffer.length;
      // 워밍업 = 버퍼가 설정 크기만큼 가득 찼을 때만 (PRD §4-B-4: 그 전엔 신호 판정 금지).
      // detector의 isValidWindow는 "홀수·5 이상"이면 유효로 보므로, 채워지는 동안 홀수 길이(5,7,9…)마다
      // 조기 판정·수치 표시가 켜졌다 꺼졌다 하는 깜빡임 버그가 있었다(실기기 제보) — 여기서 가득 참을 게이트한다.
      if (!this.resampler.warmedUp) {
        this.warmedUp = false;
        this.reconcileEmit(false);
        return;
      }
      const res = this.detector.detect(this.resampler.buffer, {
        volumeSpike: this.resampler.volumeSpike(),
        strength: this.resampler.lastStrength,
      });
      this.warmedUp = res.warmedUp;
      if (res.warmedUp) {
        this.slope = res.slope;
        this.accel = res.accel;
        this.momentumConfirming = res.momentumConfirming;
        this.sellConfirming = res.sellConfirming;
        this.buyGateBlocked = res.buyGateBlocked;
      }
      if (res.signal) {
        this.lastSignal = res.signal;
        const snap: SignalSnapshot = {
          price,
          slope: res.slope ?? 0,
          accel: res.accel ?? 0,
          ts: tsMs,
        };
        this.handleSignal(res.signal, snap);
        signalFired = true;
      }
    }
    this.reconcileEmit(signalFired);
  }

  /** 체결 폴링 + RunCycle.poll() 1회. 폴 타이머가 주기적으로, 테스트는 수동으로 호출. */
  async pollCycle(): Promise<void> {
    if (this.faulted) return; // 동결 — 브로커와 더 상호작용하지 않는다.

    // 발주/취소 fire-and-forget 오류가 폴 사이 도착했을 수 있다 → 회수해 FAULT.
    if (this.faultBarrier()) return;

    // 체결 확인이 throw면 false → RunCycle.poll()(타임아웃→취소→복귀)을 절대 진행하지 않고 FAULT. (사고 핵심 방지)
    const ok = await this.adapter.refreshFills();
    if (!ok) {
      this.enterFault(this.adapter.takeFault() ?? { kind: 'FILL_CHECK', reason: '체결 확인 실패' });
      return;
    }

    this.cycle.poll();

    // poll()이 유발한 취소(타임아웃 경로)가 async로 실패했을 수 있다 — 다음 가드에서 잡히지만 여기서도 한 번 확인.
    if (this.faultBarrier()) return;

    this.reconcileEmit(false);

    // 사이클이 자연 완료(SELL_SIGNAL)됐으면 손익에 따라 수량 조정 후 자동 재시작(상한 초과 시 중지).
    this.maybeAutoRerun();
  }

  /** 자원 해제 — 타이머 중지. */
  dispose(): void {
    this.stopTimer();
  }

  get state() {
    return this.cycle.state;
  }

  // ---- 내부 ----

  private handleTrade(record: TradeRecord): void {
    this.onTradeCb?.(this.id, record);
    // 오토런 판정은 여기서 상태를 바꾸지 않는다 — emitTrade가 아직 SELLING 상태에서 불리므로(설계상)
    // setQty/start를 지금 부르면 상태 가드에 걸린다. 자연 완료(SELL_SIGNAL)만 표시해 poll 종료 후 처리한다.
    if (record.exitReason === 'SELL_SIGNAL' && this.autoRunEnabled) {
      this.pendingAutoRunPnl = record.pnl;
    }
  }

  /** 오토런 설정 토글 — 실행 중에도 바꿀 수 있고 다음 완료 시점에 반영된다. */
  setAutoRun(enabled: boolean): void {
    this.autoRunEnabled = enabled;
    this.config.autoRun = enabled;
    this.forceEmit();
  }

  /**
   * 사이클이 자연 완료돼 DONE인 지금, 손익에 따라 수량을 조정해 자동 재시작한다.
   * 수량 상한은 없다 — 손실이 이어져 수량이 아무리 커져도 계속 재시작한다(사용자 결정: 무제한).
   * WS는 이미 살아 있으므로 realtime.connect는 부르지 않는다(내부 start만).
   */
  private maybeAutoRerun(): void {
    const pnl = this.pendingAutoRunPnl;
    this.pendingAutoRunPnl = null;
    if (pnl === null) return;
    if (this.faulted || this.cycle.state !== 'DONE') return;
    if (!this.autoRunEnabled) return;

    const nextQty = nextAutoRunQty(this.qty, pnl);
    this.setQty(nextQty); // RunCycle을 새 수량으로 재생성(DONE 상태라 안전).
    this.lastAutoRun = {
      at: this.clock.now(),
      kind: 'restarted',
      text: `오토런 · ${nextQty}주로 재시작했어요`,
    };
    this.start(); // WATCH_BUY 재개(신선한 버퍼면 이어서, WS는 이미 연결됨).
    this.onAutoRunCb?.(this.id, this.lastAutoRun, nextQty);
  }

  /**
   * 이미 FAULT이거나, 어댑터가 감지해 둔 미회수 오류가 있으면 즉시 FAULT로 전환한다.
   * @returns 인터록이 걸려 있어(또는 방금 걸려서) 정상 진행을 멈춰야 하면 true.
   */
  private faultBarrier(): boolean {
    if (this.faulted) return true;
    const f = this.adapter.takeFault();
    if (f) {
      this.enterFault(f);
      return true;
    }
    return false;
  }

  /** 신호 라우팅 — BUY는 프리플라이트(체결 확인 생존 검사)를 거친 뒤에만 발주한다. SELL은 즉시. */
  private handleSignal(signal: Signal, snapshot: SignalSnapshot): void {
    if (this.faulted) return;
    if (signal === 'BUY' && this.cycle.state === 'WATCH_BUY') {
      void this.preflightAndBuy(snapshot);
      return;
    }
    this.cycle.onSignal(signal, snapshot);
  }

  /**
   * 매수 프리플라이트 → 발주. 체결 확인 API가 죽어 있으면 **주문을 내지 않고** FAULT.
   * (죽은 체결 확인으로는 절대 사지 않는다 — 중복 매수 최소장치)
   */
  private async preflightAndBuy(snapshot: SignalSnapshot): Promise<void> {
    if (this.buyInFlight || this.faulted) return;
    if (this.cycle.state !== 'WATCH_BUY') return;
    this.buyInFlight = true;
    const fault = await this.adapter.preflightCheckFills();
    this.buyInFlight = false;

    if (this.faulted) return;
    if (fault) {
      this.enterFault(fault);
      return;
    }
    // 프리플라이트 대기 사이에 상태가 변했으면(정지 등) 발주하지 않는다.
    if (this.cycle.state !== 'WATCH_BUY') return;
    this.cycle.onSignal('BUY', snapshot);
    this.reconcileEmit(true);
  }

  /** 인터록 발동 — 자동매매 동결, 폴 타이머 중지, 카드 빨간 경고, 매니저 진단 통지. */
  private enterFault(fault: AdapterFault): void {
    if (this.faulted) return;
    this.faulted = { at: this.clock.now(), text: composeFaultText(fault) };
    this.cycle.fault(); // 코어도 FAULT로 동결 — 신규 주문·취소·재진입 차단(방어적 이중화).
    this.stopTimer();
    this.onFaultCb?.(this.id, this.faulted);
    this.forceEmit();
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = this.scheduler.setInterval(() => {
      void this.pollCycle();
    }, this.pollIntervalMs);
    // 리프라이스는 폴보다 촘촘히 돈다(기본 1초 vs 2초). 호가가 그대로면 네트워크 호출이 0회라 유량 부담이 없다.
    if (this.repriceTimer === null) {
      this.repriceTimer = this.scheduler.setInterval(() => {
        void this.repriceTick();
      }, this.repriceIntervalMs);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.repriceTimer !== null) {
      this.scheduler.clearInterval(this.repriceTimer);
      this.repriceTimer = null;
    }
  }

  /**
   * 매도 리프라이스 1틱 — SELLING일 때만 매수1호가를 따라간다.
   * 사용자 Stop 이후에도 SELLING이면 계속한다(그 매도가 곧 청산이라 빨리 붙어야 한다).
   * FAULT면 즉시 멈춘다 — cycle.fault()가 pendingRef를 버려 정정 대상 자체가 사라진다.
   */
  private async repriceTick(): Promise<void> {
    if (this.repriceTicking) return; // setInterval 재진입 방지
    if (this.faulted || this.adapter.hasFault()) return;
    if (this.cycle.state !== 'SELLING') return;
    this.repriceTicking = true;
    try {
      await this.adapter.repriceSell();
    } finally {
      this.repriceTicking = false;
    }
  }

  private reconcileEmit(signalFired: boolean): void {
    const state = this.cycle.state;
    const stateChanged = state !== this.prevState;
    this.prevState = state;

    // 사이클 종료 시 폴 타이머를 끈다(배터리).
    if (state === 'DONE') this.stopTimer();

    if (stateChanged || signalFired) {
      this.emitNow();
      return;
    }
    // 수치 전용 변화 — 스로틀.
    const now = this.clock.now();
    if (now - this.lastEmitAt >= this.throttleMs) this.emitNow();
  }

  private forceEmit(): void {
    this.prevState = this.cycle.state;
    this.emitNow();
  }

  private emitNow(): void {
    this.lastEmitAt = this.clock.now();
    if (this.listeners.size === 0) return;
    const view = this.getView();
    for (const l of this.listeners) l(view);
  }
}

/** 인터록 사유별 사용자 경고 문구(해요체) — 카드 빨간 줄·매니저 진단에 그대로 쓴다. */
function composeFaultText(fault: AdapterFault): string {
  const reason = fault.reason ? ` (사유: ${fault.reason})` : '';
  switch (fault.kind) {
    case 'CANCEL':
      return `취소가 안 됐어요 — 미체결 주문이 계좌에 남아있을 수 있어요. 계좌에서 확인해 주세요.${reason}`;
    case 'PLACE':
      return `주문을 넣지 못했어요 — 자동매매를 멈췄어요. 계좌를 직접 확인해 주세요.${reason}`;
    case 'FILL_CHECK':
    default:
      return `체결 확인이 안 돼요 — 자동매매를 멈췄어요. 계좌를 직접 확인해 주세요.${reason}`;
  }
}
