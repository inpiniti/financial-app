// 모델 입력용 하루치 OHLCV 봉 저장소.
//
// 왜 WS 체결 틱으로 봉을 만들지 않나(추세와 갈라지는 지점):
//   모델 Feature 33개 중 3개가 거래량 **비율**(volume_change_1bar, volume_ratio_20/60)이다. 학습은 토스 분봉
//   거래량(주거래소분 부분집합, 일봉의 ~54%)으로 배웠는데 WS 체결량은 한투(EVOL) 값이라 눈금이 다르다.
//   시드(토스)와 라이브(한투) 봉이 한 창에 섞이면 이동평균 대비 비율이 통째로 부풀어 학습과 딴 값이 된다.
//   그래서 **모델 경로의 봉은 처음부터 끝까지 토스**다 — 첫 조회로 그날치를 받고, 이후 봉 마감마다 몇 개만
//   덧붙인다(merge). WS 틱은 속도·진입가·청산 감시에만 쓴다.
//
// 학습 규약 재현: 하루 경계는 04:00 ET(거래일이 바뀌면 통째로 비운다),
// 봉 키는 봉 시작 epoch 분(barMinutes의 배수) — 토스 min:5의 dt와 같은 버킷.
//
// 표본 창(04:00~20:00 ET) 밖 봉(주간거래·오버나이트)도 **담는다**(2026-08-25 사용자 요청) —
// 한국 낮 시간에도 화면·챗봇의 참고 판정이 그래프를 따라 움직이게. 학습 때 없던 봉이라 그 구간
// 확률은 참고값이지만, 매수 판정에는 영향이 없다: BUY는 마지막 봉이 정규장일 때만 나오고(signal.ts
// session 게이트), 정규장 판정 시점의 저장소에는 주간거래 봉이 없다(20:00 ET 이후에나 생기고,
// 새벽 04:00 ET 거래일 전환에서 전일치와 함께 통째로 비워진다).

import type { OhlcvBar } from './features';
import { tradingDayIndex } from './session';

export type { OhlcvBar } from './features';

/** epoch ms → 봉 키(봉 시작 epoch 분). */
export function barKeyOf(tsMs: number, barMinutes: number): number {
  const m = Math.max(1, Math.floor(barMinutes));
  return Math.floor(tsMs / (60_000 * m)) * m;
}

export class ModelDayBars {
  readonly barMinutes: number;
  private list: OhlcvBar[] = [];
  private dayIndex: number | null = null;
  private cumDollar = 0;

  constructor(barMinutes: number) {
    this.barMinutes = Math.max(1, Math.floor(barMinutes));
  }

  /** 그날 닫힌 봉 전부(오름차순). */
  get bars(): readonly OhlcvBar[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }

  /** 마지막 봉의 키 — 없으면 null. */
  get lastKey(): number | null {
    return this.list.length > 0 ? this.list[this.list.length - 1].minuteKey : null;
  }

  /** 그날 첫 봉의 시가(= `change_from_day_open`의 분모) — 없으면 null. */
  get dayOpen(): number | null {
    return this.list.length > 0 ? this.list[0].open : null;
  }

  /** 그날 누적 거래대금(USD 근사) — 감지 가능 시점 필터(≥$2M)용. */
  get cumDollarVolume(): number {
    return this.cumDollar;
  }

  /** 담고 있는 거래일 번호(04:00 ET 기준) — 비었으면 null. */
  get day(): number | null {
    return this.dayIndex;
  }

  /**
   * 봉 덧붙이기 — 같은 키는 새 값으로 갈아끼우고, 거래일이 바뀌면 통째로 비우고 새 날로 시작한다.
   * **마지막 봉의 거래일이 아닌** 봉은 버린다. 주간거래·오버나이트 봉도 담는다(파일 상단 주석).
   * 반영된(추가·갱신) 봉 수를 돌려준다.
   */
  merge(incoming: readonly OhlcvBar[]): number {
    const clean = incoming
      .filter((b) => Number.isFinite(b.minuteKey) && Number.isFinite(b.close) && b.close > 0)
      .map((b) => ({ ...b, minuteKey: Math.floor(b.minuteKey / this.barMinutes) * this.barMinutes }))
      .sort((a, b) => a.minuteKey - b.minuteKey);
    if (clean.length === 0) return 0;

    const day = tradingDayIndex(clean[clean.length - 1].minuteKey);
    const fresh = clean.filter((b) => tradingDayIndex(b.minuteKey) === day);
    if (fresh.length === 0) return 0;
    if (this.dayIndex !== day) {
      this.list = [];
      this.cumDollar = 0;
      this.dayIndex = day;
    }

    const byKey = new Map(this.list.map((b) => [b.minuteKey, b]));
    for (const b of fresh) byKey.set(b.minuteKey, { ...b });
    this.list = [...byKey.values()].sort((a, b) => a.minuteKey - b.minuteKey);
    this.cumDollar = this.list.reduce((sum, b) => sum + b.volume * b.close, 0);
    return fresh.length;
  }

  /** 비우기 — 종목이 리스트에서 빠질 때. */
  clear(): void {
    this.list = [];
    this.cumDollar = 0;
    this.dayIndex = null;
  }
}
