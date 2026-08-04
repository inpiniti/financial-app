import { describe, expect, it } from 'vitest';
import { Resampler } from './index';

// ts는 ms 기준. chunkSeconds=3 이면 3000ms 창.
const S = 1000; // 1초(ms)

describe('Resampler — 청크 평균', () => {
  it('한 청크 동안 수신한 체결가를 평균 1개로 산출한다', () => {
    const r = new Resampler({ chunkSeconds: 3, bufferSize: 5 });
    // 첫 청크(0~3초): 10,20,30 → 평균 20. 3초 경계를 넘는 틱이 청크를 닫는다.
    expect(r.addTick({ price: 10, ts: 0 })).toBeNull();
    expect(r.addTick({ price: 20, ts: 1 * S })).toBeNull();
    expect(r.addTick({ price: 30, ts: 2 * S })).toBeNull();
    // ts=3초 = 경계 → 앞 청크 마감(avg 20), 이 틱은 다음 청크 시작
    expect(r.addTick({ price: 999, ts: 3 * S })).toBe(20);
    expect(r.buffer).toEqual([20]);
  });

  it('경계를 넘지 않은 마지막 청크는 flush로 닫는다', () => {
    const r = new Resampler({ chunkSeconds: 3, bufferSize: 5 });
    r.addTick({ price: 4, ts: 0 });
    r.addTick({ price: 6, ts: 1 * S });
    expect(r.flush()).toBe(5);
    expect(r.buffer).toEqual([5]);
    // 빈 상태에서 flush는 null
    expect(r.flush()).toBeNull();
  });
});

describe('Resampler — 원형 버퍼 & 워밍업', () => {
  it('버퍼가 창 크기만큼 차기 전에는 워밍업(신호 판정 금지)이다', () => {
    const r = new Resampler({ chunkSeconds: 1, bufferSize: 5 });
    // 각 틱을 다음 초에 두어 매 청크가 값 1개씩 생성
    let closed = 0;
    for (let i = 0; i <= 5; i++) {
      const v = r.addTick({ price: 100 + i, ts: i * S });
      if (v !== null) closed++;
      // 버퍼가 5개 찰 때까지는 워밍업
      if (r.buffer.length < 5) expect(r.warmedUp).toBe(false);
    }
    expect(closed).toBe(5); // 청크 5개 마감
    expect(r.warmedUp).toBe(true);
    expect(r.buffer.length).toBe(5);
  });

  it('버퍼가 가득 차면 가장 오래된 값을 버리는 고정 크기 원형 버퍼다', () => {
    const r = new Resampler({ chunkSeconds: 1, bufferSize: 5 });
    // 8개 청크 마감 → 마지막 5개만 남는다
    for (let i = 0; i <= 8; i++) r.addTick({ price: i * 10, ts: i * S });
    // 마감된 청크 값: 0,10,20,30,40,50,60,70 → 마지막 5개 [30,40,50,60,70]
    expect(r.buffer.length).toBe(5);
    expect(r.buffer).toEqual([30, 40, 50, 60, 70]);
  });
});

describe('Resampler — 거래량·체결강도 집계 (BUY 게이트용)', () => {
  it('청크 동안 수신한 volume을 합산해 volumeBuffer에 넣는다', () => {
    const r = new Resampler({ chunkSeconds: 3, bufferSize: 5 });
    r.addTick({ price: 10, ts: 0, volume: 3 });
    r.addTick({ price: 20, ts: 1 * S, volume: 7 });
    // 경계 틱의 volume(100)은 새 청크 귀속 — 앞 청크 합은 10
    r.addTick({ price: 30, ts: 3 * S, volume: 100 });
    expect(r.volumeBuffer).toEqual([10]);
    expect(r.flush()).toBe(30);
    expect(r.volumeBuffer).toEqual([10, 100]);
  });

  it('유한 volume이 하나도 없던 청크는 null로 기록한다 (NaN·미제공 방어)', () => {
    const r = new Resampler({ chunkSeconds: 3, bufferSize: 5 });
    r.addTick({ price: 10, ts: 0 });
    r.addTick({ price: 20, ts: 1 * S, volume: Number.NaN });
    r.addTick({ price: 30, ts: 3 * S, volume: 5 });
    expect(r.volumeBuffer).toEqual([null]);
  });

  it('volumeSpike는 마지막 청크 ÷ 이전 non-null 평균이며, 이력 5개 미만이면 null이다', () => {
    const r = new Resampler({ chunkSeconds: 1, bufferSize: 9 });
    // 청크 5개(volume 각 10) 마감 — 이력 4개 시점까진 null
    for (let i = 0; i < 5; i++) r.addTick({ price: 100, ts: i * S, volume: 10 });
    expect(r.volumeSpike()).toBeNull(); // 마감 4청크 → 이력 3개
    r.addTick({ price: 100, ts: 5 * S, volume: 10 });
    r.addTick({ price: 100, ts: 6 * S, volume: 30 }); // 6번째 마감(10) → 이력 5개
    // 7번째 청크(volume 30)를 마감시키는 캡 틱
    r.addTick({ price: 100, ts: 7 * S, volume: 1 });
    // 마지막 마감 청크 30 ÷ 이전 6개 평균 10 = 3
    expect(r.volumeSpike()).toBe(3);
  });

  it('마지막 청크가 null이거나 평균이 0이면 volumeSpike는 null이다', () => {
    const r = new Resampler({ chunkSeconds: 1, bufferSize: 9 });
    for (let i = 0; i < 7; i++) r.addTick({ price: 100, ts: i * S, volume: 0 });
    r.addTick({ price: 100, ts: 7 * S }); // 마지막 청크 volume 없음
    expect(r.volumeSpike()).toBeNull(); // 평균 0
  });

  it('lastStrength는 마지막 유한 STRN을 유지하고 reset 시 소거된다', () => {
    const r = new Resampler({ chunkSeconds: 3, bufferSize: 5 });
    expect(r.lastStrength).toBeNull();
    r.addTick({ price: 10, ts: 0, strength: 120 });
    r.addTick({ price: 10, ts: 1 * S, strength: Number.NaN });
    expect(r.lastStrength).toBe(120);
    r.reset();
    expect(r.lastStrength).toBeNull();
    expect(r.volumeBuffer).toEqual([]);
  });
});

describe('Resampler — 홀수 강제 & 경계값', () => {
  it('짝수 버퍼 크기는 다음 홀수로 강제된다', () => {
    expect(new Resampler({ bufferSize: 32 }).bufferSize).toBe(33);
    expect(new Resampler({ bufferSize: 50 }).bufferSize).toBe(51);
  });

  it('홀수 버퍼 크기는 그대로 유지된다', () => {
    expect(new Resampler({ bufferSize: 31 }).bufferSize).toBe(31);
  });

  it('SG 최소 창(5) 미만은 거부한다', () => {
    expect(() => new Resampler({ bufferSize: 3 })).toThrow();
  });

  it('기본 청크는 3초, 기본 버퍼는 홀수다', () => {
    const r = new Resampler();
    expect(r.chunkMs).toBe(3000);
    expect(r.bufferSize % 2).toBe(1);
  });
});
