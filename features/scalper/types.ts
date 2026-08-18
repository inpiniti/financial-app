// features/scalper 공용 타입.
// 5단계(사이클 오케스트레이터)는 UI를 모른다 — 순수 로직·상태만.
// core(RunCycle/Resampler/TrendDetector)와 kis(주문·체결내역·WS)를 잇되,
// 외부 의존(fetch·AsyncStorage·expo-keep-awake·WebSocket)은 전부 인터페이스로 주입받아
// vitest(node)에서 가짜 KIS 심으로 검증 가능하게 한다.
import type { CycleState, Signal } from '../../core/cycle';
import type { RealtimeControlMessage, RealtimeMarketCode } from '../../kis/realtimePrice';
import type { OverseasExchangeCode } from '../../kis/trId';

export type { CycleState, Signal, RealtimeControlMessage };

/** 시각 주입 — core.Clock / kis.ClockLike와 동일 계약. */
export interface ClockLike {
  now(): number;
}

/** 인스턴스 1개의 사용자 구성(티커·수량). AsyncStorage에 영속화되는 최소 단위. */
export interface ScalperInstanceConfig {
  /** 인스턴스 식별자(영속·거래기록 instanceId). */
  id: string;
  /** 종목 티커(예: 'AAPL') — WS SYMB·주문 PDNO에 그대로 사용. */
  ticker: string;
  /** 고정 주문 수량. */
  qty: number;
  /** WS 실시간 시세 시장구분(기본 'NAS'). */
  market?: RealtimeMarketCode;
  /** 주문 거래소코드(기본 'NASD'). */
  exchange?: OverseasExchangeCode;
  /**
   * 오토런 — 사이클이 자연 완료(SELL_SIGNAL)되면 손익에 따라 수량을 조정해 자동으로 다시 Run할지.
   * 기본 true. 실행 중에도 토글 가능(다음 완료 시점에 반영). AsyncStorage에 영속화된다.
   */
  autoRun?: boolean;
  /**
   * 오토런 재시작 시 수량을 손익에 따라 조정(손실 2배·수익 절반)할지. **미지정이면 켬** — 기존 저장값 하위호환.
   * 끄면 항상 같은 수량으로 재시작한다. `autoRun`과 직교한다(오토런이 꺼져 있으면 이 값은 무의미).
   */
  martingale?: boolean;
}

/** UI(6단계)가 구독하는 인스턴스 뷰. 신호/상태 전이 시에만, 수치는 1초 이하 스로틀로 발행된다. */
export interface ScalperInstanceView {
  id: string;
  ticker: string;
  qty: number;
  /** RunCycle 상태(IDLE/WATCH_BUY/BUYING/HOLDING/SELLING/DONE). */
  state: CycleState;
  /** 현재가(최근 틱). 워밍업 전에도 갱신될 수 있음. */
  price: number | null;
  /** 기울기(1차 미분) — 워밍업 전 null. */
  slope: number | null;
  /** 가속도(2차 미분) — 워밍업 전 null. */
  accel: number | null;
  /** 보유 중 평가 수익률((현재가-진입가)/진입가). 미보유 null. */
  pnlRate: number | null;
  /** 직전 변곡점 신호. */
  lastSignal: Signal | null;
  /** SG 창이 찼는가. */
  warmedUp: boolean;
  /**
   * 매수 모멘텀 확인 대기 중인가 — 기울기 -→+ 전환은 감지됐으나 상대 기울기가 아직 문턱에 못 미쳐
   * BUY를 보류 중인 상태(상태기계는 WATCH_BUY 그대로, 카드 배지만 "모멘텀 확인 중"으로 표시).
   */
  momentumConfirming: boolean;
  /**
   * 매도 모멘텀 확인 대기 중인가 — 기울기 +→- 전환은 감지됐으나 하락 기울기 크기가 아직 매도 문턱에 못 미쳐
   * SELL을 보류 중인 상태(상태기계는 HOLDING 그대로, 카드 배지만 "매도 확인 중"으로 표시).
   */
  sellConfirming: boolean;
  /**
   * BUY 게이트(거래량 스파이크/체결강도)만 매수를 막고 있는 상태 — 모멘텀 조건은 충족(또는 무관)인데
   * 게이트 미통과로 BUY 보류 중(카드 배지 "거래량/체결강도 확인 중"). 게이트 꺼짐(기본)이면 항상 false.
   */
  buyGateBlocked: boolean;
  /** pushTick 누적 호출 횟수(WS 틱 실측 수신 카운트) — 시세 수신 진단 표시용. */
  tickCount: number;
  /** 마지막 틱 수신 시각(clock 기준). 아직 한 번도 안 왔으면 null. */
  lastTickAt: number | null;
  /** 마지막 실시간호가 수신 시각(clock 기준) — "호가 수신 중" 진단용. 아직 없으면 null. */
  lastQuoteAt: number | null;
  /** 최신 매수1호가(bid) — 실시간호가 수신 시 갱신. 유효(유한·양수)하지 않으면 null. */
  bid1: number | null;
  /** 최신 매도1호가(ask). 유효하지 않으면 null. */
  ask1: number | null;
  /** 매수1호가 잔량 — 서버가 보내지 않았거나 파싱 실패면 undefined. */
  bidVol1?: number;
  /** 매도1호가 잔량. */
  askVol1?: number;
  /** pushQuote 누적 호출 횟수(실시간호가 실측 수신 카운트) — 호가 진단 시트용. */
  quoteCount: number;
  /** 리샘플러 버퍼에 실제로 쌓인 개수(시간 근사치가 아닌 실측) — 워밍업 진행률 표시용. */
  sampleCount: number;
  /** 안전 인터록 발동 기록 — 있으면 카드에 빨간 경고를 띄우고 자동매매가 멈춘 상태다. 없으면 null. */
  lastFault: InstanceFault | null;
  /** 오토런 설정(카드 토글) — 사이클 자연 완료 시 자동 재시작 여부. */
  autoRun: boolean;
  /** 수량 마틴게일 설정(카드 토글) — 끄면 오토런이 같은 수량으로 재시작한다. */
  martingale: boolean;
  /** 최근 매수 미체결 자동 포기 안내 — 카드에 한 줄로 표시. 없으면 null. */
  lastAbandon: AbandonNote | null;
  /** 최근 오토런 이벤트(재시작/상한 도달로 중지) — 카드에 안내 문구로 표시. 없으면 null. */
  lastAutoRun: AutoRunNote | null;
}

/** 매수 미체결 자동 포기 안내 — 카드에 보여줄 완성 문구(해요체)와 발생 시각. */
export interface AbandonNote {
  at: number;
  text: string;
}

/** 오토런 안내 — 카드/진단에 보여줄 완성 문구(해요체)와 발생 시각. */
export interface AutoRunNote {
  at: number;
  /** 'restarted'=수량 조정 후 자동 재시작(수량 상한 없음 — 무제한 재시작). */
  kind: 'restarted';
  text: string;
}

/** 안전 인터록 사유 분류 — 러너가 사용자 문구를 조립하는 데 쓴다. */
export type FaultKind = 'FILL_CHECK' | 'PLACE' | 'CANCEL';

/** OrderPortAdapter가 감지한 async 브로커 오류(체결 확인/발주/취소 실패). */
export interface AdapterFault {
  kind: FaultKind;
  /** 원인 요약(한 줄) — 스택은 담지 않는다. */
  reason: string;
}

/** 인스턴스 뷰·매니저 진단에 노출되는 인터록 발동 기록. */
export interface InstanceFault {
  at: number;
  /** 사용자에게 그대로 보여줄 완성된 경고 문구(해요체). */
  text: string;
}

/** WS 연결 상태 — 매니저가 RealtimeFeed의 상태 변화를 이 5가지로 노출한다. */
export type FeedStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** BrokerFill: 오늘 주문 1건의 체결 상태 스냅샷(폴러가 주기 조회). odno로 매칭. */
export interface BrokerFill {
  odno: string;
  orderQty: number;
  filledQty: number;
  /** 평균 체결단가 — 미확정이면 null. */
  filledPrice: number | null;
  /**
   * 이 스냅샷이 미체결 목록의 **실측**인가 — true면 주문이 목록에 살아 있고 filledQty가 잔량 역산 실측.
   * false/미지정이면 추론(목록 부재→전량체결, 유예, 정정 왕복 보류)이다. 정정 거절 구제의 생존 판정에 쓴다.
   */
  listed?: boolean;
}

export interface BrokerPlaceInput {
  side: 'buy' | 'sell';
  /** 종목코드(PDNO). */
  pdno: string;
  qty: number;
  /** 지정가 단가(OVRS_ORD_UNPR) — 0 금지(지정가). */
  price: number;
}

export interface BrokerCancelInput {
  pdno: string;
  /** 원주문번호(ODNO). */
  odno: string;
  qty: number;
}

/** 정정(리프라이스) 입력 — 살아있는 주문의 단가·수량을 바꾼다. (2026-08-04 매도 실행기) */
export interface BrokerAmendInput {
  pdno: string;
  /** 현재 살아있는 원주문번호(ORGN_ODNO). 정정할 때마다 바뀌므로 항상 최신값을 넘겨야 한다. */
  odno: string;
  /**
   * 새 주문수량. KIS 해외 정정에는 "잔량 전부" 옵션이 없어서(국내 QTY_ALL_ORD_YN 같은 필드 부재)
   * 부분체결 후에는 **반드시 미체결 잔량**을 계산해 넣어야 한다.
   */
  qty: number;
  /** 새 지정가. side별 절사는 브로커가 적용한다. */
  price: number;
  side: 'buy' | 'sell';
}

/**
 * ScalperBroker: OrderPortAdapter가 의존하는 async 주문 게이트웨이.
 * 실서비스는 createKisBroker가 kis/order·orderCancel·orderHistory로 구현하고,
 * 테스트는 가짜 심으로 구현한다.
 */
export interface ScalperBroker {
  placeOrder(input: BrokerPlaceInput): Promise<{ odno: string }>;
  cancelOrder(input: BrokerCancelInput): Promise<void>;
  /**
   * 정정 — 성공하면 KIS가 **새 ODNO를 채번**해 돌려준다. 다음 정정은 반드시 이 새 값을 orgnOdno로 써야 하고,
   * 옛 ODNO는 미체결 목록에서 사라지므로 구현체가 추적 상태를 원자적으로 갈아끼워야 한다
   * (안 하면 "목록 부재 = 전량체결" 오판이 난다).
   */
  amendOrder(input: BrokerAmendInput): Promise<{ odno: string }>;
  /** 오늘 주문들의 체결 상태 스냅샷(odno 기준). checkFilled 폴러가 주기 호출. */
  fetchFills(): Promise<BrokerFill[]>;
  /**
   * KIS 잔고에서 이 브로커의 종목(생성 시 pdno) 포지션을 읽는다 — 매도 관리 그리드가 브래킷을
   * 세울 때 평단·수량 출처로 쓴다(D1). 보유가 없거나 아직 반영 전이면 null.
   * 실서비스는 inquireOverseasBalance(output1)로, 테스트는 심으로 구현한다.
   */
  fetchPosition(): Promise<{ qty: number; avgPrice: number } | null>;
}

/** AsyncStorage 최소 계약(거래기록·구성 영속화). 테스트는 Map 기반 심을 주입. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * 체결 틱의 부가 정보 — BUY 게이트(거래량 스파이크·체결강도)용.
 * 파싱 실패(NaN)면 필드 자체를 뺀다 — 하류는 미제공을 "판정 불가"로 보고 게이트를 통과시킨다(fail-open).
 */
export interface TickExtras {
  /** 이 틱의 체결량(KIS EVOL). */
  volume?: number;
  /** 체결강도(KIS STRN, 100=매수·매도 균형). */
  strength?: number;
}

/** WS 단일 연결을 감싸는 시세 피드. 매니저가 티커별 구독을 이 위로 멀티플렉스한다. */
export interface RealtimeFeed {
  connect(): void;
  close(): void;
  /** trKey 구독/해제. trId 기본 체결가(HDFSCNT0) — 현재 쓰는 TR은 체결가뿐이다. */
  subscribe(trKey: string, trId?: string): void;
  unsubscribe(trKey: string, trId?: string): void;
  /** 수신 틱(체결가) 라우팅 핸들러 등록 — (symb, price, tsMs, extras?). extras는 게이트용 선택 정보. */
  setTickHandler(handler: (symb: string, price: number, tsMs: number, extras?: TickExtras) => void): void;
  /**
   * 1호가 라우팅 핸들러 등록 — (symb, bid1, ask1, tsMs, bidVol1?, askVol1?).
   * 체결가 페이로드(PBID/PASK/VBID/VASK)에서 뽑아 흘린다(별도 호가 TR 구독 없음). 잔량은 선택.
   */
  setQuoteHandler(
    handler: (symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void,
  ): void;
  /** 연결 상태 변화 핸들러 등록 — 매니저가 구독해 FeedStatus로 노출한다. */
  setStatusHandler(handler: (status: FeedStatus) => void): void;
  /** 구독 등록/해제 ACK 등 제어 프레임 핸들러 등록 — 매니저가 진단 이벤트(lastFeedEvent)로 노출한다. */
  setControlHandler(handler: (msg: RealtimeControlMessage) => void): void;
}

/** expo-keep-awake 얇은 래퍼 계약(인스턴스 1개 이상 실행 시 활성). */
export interface KeepAwakeControl {
  activate(): void;
  deactivate(): void;
}

/** setInterval/clearInterval 주입(폴 타이머) — 테스트에서 실타이머 회피. */
export interface SchedulerLike {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
