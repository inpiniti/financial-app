import { describe, expect, it } from 'vitest';
import { TrendDetector, computeDerivatives, type DetectorResult, type GateInput, type Signal } from './index';

const WINDOW = 7;

/**
 * price 배열 위를 크기 W 창으로 밀며 detector에 순차 투입, 발생한 신호 목록을 반환.
 * 기본은 문턱 0(끔) — 이 헬퍼를 쓰는 기존 테스트들은 "전환 즉시 BUY"를 가정하므로 하위호환 의미를 보존한다.
 * 매수 모멘텀 확인 단계는 별도 describe(아래)에서 문턱>0으로 검증한다.
 */
function replay(prices: number[], w = WINDOW, options: ConstructorParameters<typeof TrendDetector>[0] = { minBuyMomentum: 0, minSellMomentum: 0 }): Signal[] {
  const det = new TrendDetector(options);
  const signals: Signal[] = [];
  for (let i = 0; i + w <= prices.length; i++) {
    const res = det.detect(prices.slice(i, i + w));
    if (res.signal) signals.push(res.signal);
  }
  return signals;
}

/** 창을 밀며 워밍업된 청크의 판정 결과를 순서대로 모은다(모멘텀 확인 단계 검증용). */
function replayDetailed(
  prices: number[],
  options: ConstructorParameters<typeof TrendDetector>[0],
  w = WINDOW,
): DetectorResult[] {
  const det = new TrendDetector(options);
  const out: DetectorResult[] = [];
  for (let i = 0; i + w <= prices.length; i++) {
    out.push(det.detect(prices.slice(i, i + w)));
  }
  return out;
}

describe('computeDerivatives — SG 1차/2차 미분', () => {
  it('상승 구간은 기울기가 양수, 하강 구간은 음수다', () => {
    const up = [1, 2, 3, 4, 5, 6, 7];
    const down = [7, 6, 5, 4, 3, 2, 1];
    expect(computeDerivatives(up).slope).toBeGreaterThan(0);
    expect(computeDerivatives(down).slope).toBeLessThan(0);
  });
});

describe('TrendDetector — 변곡점 판정', () => {
  it('V자 가격에서 BUY 변곡점이 정확히 1번 발생한다', () => {
    const v = [10, 8, 6, 4, 2, 1, 2, 4, 6, 8, 10];
    const signals = replay(v);
    expect(signals).toEqual(['BUY']);
  });

  it('역V자 가격에서 SELL 변곡점이 정확히 1번 발생한다', () => {
    const invV = [1, 3, 5, 7, 9, 10, 9, 7, 5, 3, 1];
    const signals = replay(invV);
    expect(signals).toEqual(['SELL']);
  });

  it('단조 상승만 있으면 어떤 신호도 발생하지 않는다', () => {
    const mono = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(replay(mono)).toEqual([]);
  });

  it('BUY는 이전<0 && 현재>=0, 그 외에는 트리거하지 않는다 (문턱 0 = 전환 즉시)', () => {
    const det = new TrendDetector({ minBuyMomentum: 0 });
    // 하강 창(기울기<0) → 신호 없음, prevSlope 저장
    expect(det.detect([7, 6, 5, 4, 3, 2, 1]).signal).toBeNull();
    // 평평/상승 창(기울기>=0) → BUY
    expect(det.detect([1, 2, 3, 4, 5, 6, 7]).signal).toBe('BUY');
  });
});

describe('TrendDetector — 워밍업/유효창', () => {
  it('창이 5 미만이면 warmedUp=false, 신호 없음', () => {
    const det = new TrendDetector();
    const res = det.detect([1, 2, 3]);
    expect(res.warmedUp).toBe(false);
    expect(res.signal).toBeNull();
    expect(res.slope).toBeNull();
  });

  it('첫 유효 창은 이전 기울기가 없어 신호를 내지 않는다', () => {
    const det = new TrendDetector();
    const res = det.detect([1, 2, 3, 4, 5, 6, 7]);
    expect(res.warmedUp).toBe(true);
    expect(res.slope).not.toBeNull();
    expect(res.signal).toBeNull();
  });
});

describe('TrendDetector — 경고 이벤트(선택, 기본 off)', () => {
  it('기본값에서는 가속도가 급락해도 warning을 내지 않는다', () => {
    const det = new TrendDetector();
    det.detect([1, 2, 3, 4, 5, 6, 7]);
    const res = det.detect([2, 4, 7, 9, 10, 10, 9]); // 기울기 양수, 가속도 꺾임
    expect(res.warning).toBe(false);
  });

  it('enableWarning + 임계 설정 시 기울기>0 && 가속도<=임계면 warning', () => {
    const det = new TrendDetector({ enableWarning: true, warningAccelThreshold: 0 });
    det.detect([1, 2, 3, 4, 5, 6, 7]);
    // 오목(가속 음수)하지만 여전히 상승하는 창
    const res = det.detect([1, 3, 6, 9, 11, 12, 12]);
    expect(res.slope).toBeGreaterThan(0);
    expect(res.accel).toBeLessThanOrEqual(0);
    expect(res.warning).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 매수 모멘텀 확인 단계(2026-07-31 사용자 확정) — 전환 후 상대 기울기 ≥ 문턱 확인 시에만 BUY.
// 매도는 문턱과 무관하게 즉시(비대칭). 문턱 0이면 전환 즉시 BUY(기존 동작).
// ─────────────────────────────────────────────────────────────────────────────
describe('TrendDetector — 매수 모멘텀 확인 단계', () => {
  // integration.test.ts에서 검증된 시퀀스(버퍼 7): BUY 1회.
  const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
  const INV_V = [1, 3, 5, 7, 9, 10, 9, 7, 5, 3, 1];
  const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];

  const countBuys = (rs: DetectorResult[]) => rs.filter((r) => r.signal === 'BUY').length;
  const countSells = (rs: DetectorResult[]) => rs.filter((r) => r.signal === 'SELL').length;

  it('① 전환 후 문턱 도달(윈도 내) → 그 시점에 BUY 1회, 전환 청크엔 확인 대기만', () => {
    const gated = replayDetailed(V, { minBuyMomentum: 0.0001, confirmWindowChunks: 5 });
    expect(countBuys(gated)).toBe(1);

    const buyIdx = gated.findIndex((r) => r.signal === 'BUY');
    // BUY 직전 청크는 확인 대기 중(전환은 감지됐으나 아직 매수 안 함)이고, BUY 시점에 대기가 해제된다.
    expect(gated[buyIdx - 1].momentumConfirming).toBe(true);
    expect(gated[buyIdx - 1].signal).toBeNull();
    expect(gated[buyIdx].momentumConfirming).toBe(false);

    // 확인 단계 때문에 문턱 0(즉시 매수)보다 최소 1청크 늦게 진입한다.
    const immediate = replayDetailed(V, { minBuyMomentum: 0 });
    const immBuyIdx = immediate.findIndex((r) => r.signal === 'BUY');
    expect(buyIdx).toBeGreaterThan(immBuyIdx);
  });

  it('② 전환 후 윈도 내 미달 → BUY 0회, 이후 재전환+문턱 도달 시 BUY 1회', () => {
    const opts = { minBuyMomentum: 0.01, confirmWindowChunks: 3 };
    // 100 근처 완만한 상승(+0.1/청크 ≈ 상대기울기 0.001)은 문턱(0.01) 미달 — 윈도(3) 소진 후 폐기.
    const down1 = [106, 105, 104, 103, 102, 101, 100];
    const gentleUp = [100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7, 100.8, 100.9];
    const gentleOnly = [...down1, ...gentleUp];
    expect(countBuys(replayDetailed(gentleOnly, opts))).toBe(0);

    // 이어서 다시 하락(재무장) → 가파른 상승(+6~/청크 ≈ 0.05)은 문턱 도달 → BUY.
    const down2 = [100, 99, 98, 97, 96, 95];
    const steepUp = [100, 106, 113, 121, 130, 140, 151];
    const full = [...gentleOnly, ...down2, ...steepUp];
    expect(countBuys(replayDetailed(full, opts))).toBe(1);
  });

  it('③ 전환 후 기울기 재음전(하락 재개) → 즉시 폐기, BUY 0회 (윈도 미소진)', () => {
    // 문턱은 도달 불가로 높게, 윈도는 소진되지 않게 크게 — 대기 해제는 오직 하락 재개로만 일어난다.
    const results = replayDetailed(DOWN_UP_DOWN, { minBuyMomentum: 999, confirmWindowChunks: 100 });
    expect(countBuys(results)).toBe(0);
    // 확인 대기가 한 번 켜졌다가(전환) 다시 꺼졌다(하락 재개로 폐기 — 윈도 100은 소진 불가).
    expect(results.some((r) => r.momentumConfirming)).toBe(true);
    expect(results[results.length - 1].momentumConfirming).toBe(false);
  });

  it('④ 문턱 0 → 확인 대기 없이 전환 즉시 BUY(기존 동작 동일)', () => {
    const results = replayDetailed(V, { minBuyMomentum: 0 });
    expect(countBuys(results)).toBe(1);
    expect(results.some((r) => r.momentumConfirming)).toBe(false);
    // 헬퍼 기본(문턱 0)과도 동일.
    expect(replay(V)).toEqual(['BUY']);
  });

  it('⑤ SELL은 매수 문턱과 무관 — 매수 문턱을 아무리 높여도 매도 타이밍은 그대로다 (매도 문턱 0=즉시)', () => {
    const hi = replayDetailed(INV_V, { minBuyMomentum: 999, minSellMomentum: 0 });
    const lo = replayDetailed(INV_V, { minBuyMomentum: 0, minSellMomentum: 0 });
    expect(countSells(hi)).toBe(1);
    expect(hi.findIndex((r) => r.signal === 'SELL')).toBe(lo.findIndex((r) => r.signal === 'SELL'));
  });

  it('⑥ 상대 정규화 — 가격 규모가 150배 달라도 같은 %기울기면 신호·타이밍이 동일하다', () => {
    const opts = { minBuyMomentum: 0.0001, confirmWindowChunks: 5 };
    const base = replayDetailed(V, opts); // ~$2
    const scaled = replayDetailed(V.map((p) => p * 150), opts); // ~$300
    expect(scaled.map((r) => r.signal)).toEqual(base.map((r) => r.signal));
    expect(scaled.map((r) => r.momentumConfirming)).toEqual(base.map((r) => r.momentumConfirming));
  });

  it('reset()은 확인 대기 상태까지 초기화한다', () => {
    const det = new TrendDetector({ minBuyMomentum: 0.0001, confirmWindowChunks: 5 });
    for (let i = 0; i + WINDOW <= V.length; i++) det.detect(V.slice(i, i + WINDOW));
    det.reset();
    // 리셋 직후 첫 창은 prevSlope가 없어 신호도 확인 대기도 없다.
    const first = det.detect([20, 16, 12, 8, 4, 2, 4]);
    expect(first.signal).toBeNull();
    expect(first.momentumConfirming).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 매도 모멘텀 확인 단계(2026-07-31 사용자 확정, 수익 극대화) — +→- 전환 후 즉시 팔지 않고 "매도 확인 대기".
//  · 매 청크 상대 하락 기울기 크기 ≥ 매도 문턱이면 SELL.
//  · 대기 중 기울기가 +로 회복하면 매도 폐기(핵심 구제 경로 — 얕은 눌림 홀딩).
//  · 대기 한도(기본 2청크=6초) 만료 시 무조건 SELL(매수와 반대 — 방어선 보존, 지연 상한만 존재).
//  · 급락 예외: 상대 가속도(accel/price) ≤ 급락 임계면 대기 무시 즉시 SELL.
//  · 매도 문턱 0 = 끔(전환 즉시 SELL, 하위호환). 매수 확인과 독립.
// 실사례: 0.439 매수→0.437 얕은 눌림 후 0.99까지 상승 — 얕은 눌림의 기울기 0 하향 통과만으로 즉시 청산돼 추세를 놓침.
// ─────────────────────────────────────────────────────────────────────────────
describe('TrendDetector — 매도 모멘텀 확인 단계', () => {
  const countSells = (rs: DetectorResult[]) => rs.filter((r) => r.signal === 'SELL').length;
  const idxSell = (rs: DetectorResult[]) => rs.findIndex((r) => r.signal === 'SELL');

  // 얕은 눌림(SG 평활 후 기울기가 1~2청크만 음전) 후 회복. 하락 기울기 크기는 매도 문턱(0.005)에 못 미친다.
  const SHALLOW_DIP = [0.42, 0.43, 0.44, 0.448, 0.454, 0.457, 0.455, 0.451, 0.449, 0.451, 0.456, 0.462, 0.469, 0.477];
  // 완만한 정점 후 지속 하락(역V). 하락 기울기 크기가 점점 커진다(문턱 초과 지점 존재).
  const STEADY_DOWN = [0.4, 0.42, 0.44, 0.46, 0.48, 0.49, 0.485, 0.475, 0.463, 0.449, 0.433, 0.415, 0.395];
  // 정점 직후 폭락(가속도가 급격히 음). 상대 가속도가 급락 임계를 넘는다.
  const VIOLENT_CRASH = [0.44, 0.46, 0.48, 0.49, 0.495, 0.49, 0.47, 0.43, 0.37, 0.29, 0.19, 0.1];
  // 순수 V자(하락→상승) — 매수 전환만, 매도 전환 없음.
  const V_SHAPE = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];

  it('① 얕은 눌림(문턱 미달) 후 기울기 회복 → SELL 0회, 계속 홀딩(실사례 구제)', () => {
    // 매도 문턱 0.005(하락 기울기가 이보다 얕음), 대기 한도 2 — 만료 전에 기울기가 +로 회복해 폐기된다.
    const rs = replayDetailed(SHALLOW_DIP, { minBuyMomentum: 0, minSellMomentum: 0.005, sellConfirmWindowChunks: 2 });
    expect(countSells(rs)).toBe(0);
    // 하향 통과 시 매도 확인 대기가 한 번 켜졌다가, 회복으로 꺼진다.
    expect(rs.some((r) => r.sellConfirming)).toBe(true);
    expect(rs[rs.length - 1].sellConfirming).toBe(false);
  });

  it('② 문턱 이상으로 하락한 청크에 SELL 발동 (만료가 아니라 문턱 때문)', () => {
    // 대기 한도를 넉넉히(5) 줘서 만료가 아닌 "문턱 도달"만이 매도를 일으키도록 격리.
    const rs = replayDetailed(STEADY_DOWN, { minBuyMomentum: 0, minSellMomentum: 0.01, sellConfirmWindowChunks: 5 });
    expect(countSells(rs)).toBe(1);
    const s = idxSell(rs);
    // 매도 직전 청크는 매도 확인 대기 중(전환은 감지됐으나 아직 문턱 미달), 매도 청크에 대기 해제.
    expect(rs[s - 1].sellConfirming).toBe(true);
    expect(rs[s - 1].signal).toBeNull();
    expect(rs[s].sellConfirming).toBe(false);
    // 문턱 0(즉시 매도)보다 늦게 팔린다(확인 대기 때문).
    const immediate = replayDetailed(STEADY_DOWN, { minBuyMomentum: 0, minSellMomentum: 0 });
    expect(s).toBeGreaterThan(idxSell(immediate));
  });

  it('③ 얕은 하락이 대기 한도 내내 지속(회복 없음) → 만료 시점에 무조건 SELL', () => {
    // 매도 문턱을 도달 불가로 높게(0.05), 대기 한도 2 — 오직 만료만이 매도를 일으킨다.
    const rs = replayDetailed(STEADY_DOWN, { minBuyMomentum: 0, minSellMomentum: 0.05, sellConfirmWindowChunks: 2 });
    expect(countSells(rs)).toBe(1);
    // 만료 매도는 즉시(문턱 0) 매도보다 정확히 대기 한도만큼 늦다 — 반드시 팔리되 지연 상한이 있다.
    const immediate = replayDetailed(STEADY_DOWN, { minBuyMomentum: 0, minSellMomentum: 0 });
    expect(idxSell(rs)).toBe(idxSell(immediate) + 2);
  });

  it('④ 급락(상대 가속도 임계 초과) → 대기 무시 즉시 SELL — 문턱 0 매도보다 빠르다', () => {
    // 매도 문턱·대기 한도를 크게 잡아 그 경로로는 매도가 늦게 나게 하고, 급락 예외만이 조기 매도를 일으키게 한다.
    const withCrash = replayDetailed(VIOLENT_CRASH, {
      minBuyMomentum: 0,
      minSellMomentum: 0.5,
      sellConfirmWindowChunks: 10,
      crashAccelThreshold: -0.02,
    });
    // 급락 예외를 끈(임계를 도달 불가로) 동일 시퀀스 — 훨씬 늦게(문턱/가속) 팔린다.
    const noCrash = replayDetailed(VIOLENT_CRASH, {
      minBuyMomentum: 0,
      minSellMomentum: 0.5,
      sellConfirmWindowChunks: 10,
      crashAccelThreshold: -Infinity,
    });
    expect(countSells(withCrash)).toBe(1);
    expect(idxSell(withCrash)).toBeGreaterThanOrEqual(0);
    expect(idxSell(withCrash)).toBeLessThan(idxSell(noCrash));
  });

  it('⑤ 매도 문턱 0 → 확인 대기 없이 전환 즉시 SELL(기존 동작)', () => {
    const rs = replayDetailed(STEADY_DOWN, { minBuyMomentum: 0, minSellMomentum: 0 });
    expect(countSells(rs)).toBe(1);
    expect(rs.some((r) => r.sellConfirming)).toBe(false);
  });

  it('⑥ 매수 확인과 독립 — 매수 대기 중 매도 상태가 오염되지 않는다', () => {
    // 순수 V자(하락→상승): 매수 전환만 있고 매도 전환은 없다. 매수 확인 대기가 도는 동안 sellConfirming은 늘 false.
    const rs = replayDetailed(V_SHAPE, { minBuyMomentum: 0.0001, confirmWindowChunks: 5, minSellMomentum: 0.005 });
    expect(rs.every((r) => r.sellConfirming === false)).toBe(true);
    // 매도 게이팅을 켜도 매수 신호·타이밍은 매수 전용 테스트와 동일하다.
    const buyOnly = replayDetailed(V_SHAPE, { minBuyMomentum: 0.0001, confirmWindowChunks: 5, minSellMomentum: 0 });
    expect(rs.map((r) => r.signal)).toEqual(buyOnly.map((r) => r.signal));
    expect(rs.map((r) => r.momentumConfirming)).toEqual(buyOnly.map((r) => r.momentumConfirming));
  });

  it('reset()은 매도 확인 대기 상태까지 초기화한다', () => {
    const det = new TrendDetector({ minBuyMomentum: 0, minSellMomentum: 0.05, sellConfirmWindowChunks: 5 });
    // 정점 통과까지 흘려 매도 확인 대기에 진입시킨다.
    for (let i = 0; i + WINDOW <= STEADY_DOWN.length; i++) {
      const r = det.detect(STEADY_DOWN.slice(i, i + WINDOW));
      if (r.sellConfirming) break;
    }
    det.reset();
    const first = det.detect([0.4, 0.42, 0.44, 0.46, 0.48, 0.49, 0.485]);
    expect(first.signal).toBeNull();
    expect(first.sellConfirming).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUY 게이트(2026-08-03) — 거래량 스파이크·체결강도가 문턱 이상일 때만 BUY 허용.
//  · 문턱 0 = 끔(기존 동작), 게이트 입력 null = 판정 불가 → 통과(fail-open).
//  · 미통과면 buyGateBlocked=true로 확인 대기를 유지(윈도 소진 시 폐기).
//  · SELL은 게이트와 완전 무관.
// ─────────────────────────────────────────────────────────────────────────────
describe('TrendDetector — BUY 게이트(거래량 스파이크·체결강도)', () => {
  // 하락→상승이 끝까지 이어지는 V자 확장(윈도 7 → 판정 7회) — 게이트 지연 후에도 BUY 기회가 남는다.
  const V_EXT = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 24, 28];
  const INV_V = [1, 3, 5, 7, 9, 10, 9, 7, 5, 3, 1];

  const countBuys = (rs: DetectorResult[]) => rs.filter((r) => r.signal === 'BUY').length;

  function replayGated(
    prices: number[],
    gatesAt: (i: number) => GateInput | undefined,
    options: ConstructorParameters<typeof TrendDetector>[0],
    w = WINDOW,
  ): DetectorResult[] {
    const det = new TrendDetector(options);
    const out: DetectorResult[] = [];
    for (let i = 0; i + w <= prices.length; i++) {
      out.push(det.detect(prices.slice(i, i + w), gatesAt(i)));
    }
    return out;
  }

  // 게이트 없이 즉시 BUY가 나는 전환 청크 인덱스(다른 테스트의 기준점).
  const crossIdx = replayDetailed(V_EXT, { minBuyMomentum: 0 }).findIndex((r) => r.signal === 'BUY');

  it('① 게이트 문턱 0(기본) → gates를 넘겨도 기존 동작과 동일, buyGateBlocked 없음', () => {
    const base = replayDetailed(V_EXT, { minBuyMomentum: 0 });
    const gated = replayGated(V_EXT, () => ({ volumeSpike: 0.1, strength: 1 }), { minBuyMomentum: 0 });
    expect(gated.map((r) => r.signal)).toEqual(base.map((r) => r.signal));
    expect(gated.every((r) => r.buyGateBlocked === false)).toBe(true);
  });

  it('② 게이트만 켬 + 전환 청크에서 통과 → 그 청크에 즉시 BUY(지연 0)', () => {
    const rs = replayGated(V_EXT, () => ({ volumeSpike: 3, strength: 200 }), {
      minBuyMomentum: 0,
      minVolumeSpikeRatio: 1.5,
      minStrength: 100,
    });
    expect(countBuys(rs)).toBe(1);
    expect(rs.findIndex((r) => r.signal === 'BUY')).toBe(crossIdx);
  });

  it('③ 거래량 스파이크 미달 → 보류(buyGateBlocked)·대기 유지 → 도달 청크에 BUY', () => {
    const rs = replayGated(V_EXT, (i) => ({ volumeSpike: i <= crossIdx ? 1 : 3 }), {
      minBuyMomentum: 0,
      minVolumeSpikeRatio: 1.5,
    });
    expect(rs[crossIdx].signal).toBeNull();
    expect(rs[crossIdx].buyGateBlocked).toBe(true);
    expect(rs[crossIdx].momentumConfirming).toBe(true);
    expect(rs[crossIdx + 1].signal).toBe('BUY');
    expect(rs[crossIdx + 1].buyGateBlocked).toBe(false);
    expect(countBuys(rs)).toBe(1);
  });

  it('④ 게이트 미달인 채 윈도 소진 → 폐기, BUY 0회', () => {
    const rs = replayGated(V_EXT, () => ({ volumeSpike: 1 }), {
      minBuyMomentum: 0,
      minVolumeSpikeRatio: 1.5,
      confirmWindowChunks: 1,
    });
    expect(countBuys(rs)).toBe(0);
    expect(rs.some((r) => r.buyGateBlocked)).toBe(true);
    expect(rs[rs.length - 1].momentumConfirming).toBe(false);
  });

  it('⑤ 체결강도 게이트 — 미달이면 BUY 없음, 문턱 이상이면 전환 청크 즉시 BUY', () => {
    const weak = replayGated(V_EXT, () => ({ strength: 90 }), {
      minBuyMomentum: 0,
      minStrength: 100,
      confirmWindowChunks: 2,
    });
    expect(countBuys(weak)).toBe(0);
    const strong = replayGated(V_EXT, () => ({ strength: 120 }), { minBuyMomentum: 0, minStrength: 100 });
    expect(strong.findIndex((r) => r.signal === 'BUY')).toBe(crossIdx);
  });

  it('⑥ 게이트 입력 null·미제공 → fail-open으로 게이트 없는 것과 동일', () => {
    const nullGates = replayGated(V_EXT, () => ({ volumeSpike: null, strength: null }), {
      minBuyMomentum: 0,
      minVolumeSpikeRatio: 1.5,
      minStrength: 100,
    });
    const noGates = replayGated(V_EXT, () => undefined, {
      minBuyMomentum: 0,
      minVolumeSpikeRatio: 1.5,
      minStrength: 100,
    });
    expect(nullGates.findIndex((r) => r.signal === 'BUY')).toBe(crossIdx);
    expect(noGates.findIndex((r) => r.signal === 'BUY')).toBe(crossIdx);
  });

  it('⑦ 모멘텀 문턱 + 게이트 동시 — 둘 다 충족하는 청크에서만 BUY', () => {
    const momOpts = { minBuyMomentum: 0.0001, confirmWindowChunks: 5 };
    const momBuyIdx = replayDetailed(V_EXT, momOpts).findIndex((r) => r.signal === 'BUY');
    // 모멘텀 도달 청크까지 게이트를 막으면 BUY가 1청크 더 밀린다.
    const rs = replayGated(V_EXT, (i) => ({ volumeSpike: i <= momBuyIdx ? 1 : 3 }), {
      ...momOpts,
      minVolumeSpikeRatio: 1.5,
    });
    expect(rs[momBuyIdx].signal).toBeNull();
    expect(rs[momBuyIdx].buyGateBlocked).toBe(true);
    expect(rs[momBuyIdx + 1].signal).toBe('BUY');
  });

  it('⑧ SELL은 게이트와 무관 — 게이트를 아무리 높여도 매도 타이밍 불변', () => {
    const base = replayDetailed(INV_V, { minBuyMomentum: 0, minSellMomentum: 0 });
    const gated = replayGated(INV_V, () => ({ volumeSpike: 1, strength: 50 }), {
      minBuyMomentum: 0,
      minSellMomentum: 0,
      minVolumeSpikeRatio: 5,
      minStrength: 500,
    });
    expect(gated.map((r) => r.signal)).toEqual(base.map((r) => r.signal));
    expect(gated.every((r) => r.buyGateBlocked === false)).toBe(true);
  });
});
