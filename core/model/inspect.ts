// 모델 판정 들여다보기 — 화면·챗봇이 "이 종목, 지금 모델이 뭐라고 하나"를 묻는 단일 통로.
//
// 왜 따로 두나: 진입 판정은 ModelScanner가 5분에 한 번 백그라운드로만 돌린다. 사용자가 차트를 보거나
// 챗봇에게 물을 때는 그 결과를 곧바로 알 수 없다. 그렇다고 화면이 자기 방식으로 다시 계산하면
// **엔진과 다른 답**을 말하게 된다(2026-08-22 "그래프와 감지가 일치하지 않는다"가 바로 그 사고였다).
// 그래서 봉을 넣으면 스캐너와 **똑같은 절차**(ModelDayBars → evaluateModel)로 답하는 함수를 하나 둔다.
//
// 순수 함수다 — 네트워크는 호출부가 한다(화면은 토스 차트, 챗봇 도구는 같은 토스 차트).

import { ModelDayBars, type OhlcvBar } from './bars';
import { etDateString } from './session';
import { evaluateModel, type ModelEval } from './signal';
import type { GbdtModel } from './gbdt';

export interface ModelInspectInput {
  /** 오름차순 봉(원시가). 진행 중 봉은 빼고 넣는다 — 엔진도 닫힌 봉만 본다. */
  bars: readonly OhlcvBar[];
  /** 최근 일봉 종가(날짜 오름차순). 없으면 전일 계열 Feature 3개가 null이 된다(엔진과 같은 동작). */
  dailyCloses?: readonly { date: string; close: number }[];
  /** 봉 주기(분) — 모델 채택값을 그대로 넘긴다. */
  barMinutes: number;
}

export interface ModelInspection extends ModelEval {
  /** 판정에 쓴 그날 봉 수(04:00~20:00 ET 창 안). */
  dayBars: number;
  /** 그날 첫 봉 시가 — 없으면 null. */
  dayOpen: number | null;
  /** 그날 누적 거래대금(USD 근사). */
  cumDollarVolume: number;
  /** 판정 시점 ET 거래일(YYYY-MM-DD). 봉이 없으면 null. */
  etDate: string | null;
}

/** 판정 불가·미달 사유를 사람 문장으로. 신호면 null. */
export function describeReject(ev: Pick<ModelEval, 'reject' | 'prob' | 'threshold'>): string | null {
  switch (ev.reject) {
    case null:
      return null;
    case 'bars':
      return '봉이 모자라 아직 판정할 수 없어요';
    case 'session':
      return '지금은 정규장이 아니에요 — 모델은 정규장에서만 신호를 내요';
    case 'liquidity':
      return '그날 거래대금이 200만 달러에 못 미쳐요';
    case 'price':
      return '주가가 1달러 이하예요';
    case 'prob':
      return ev.prob === null
        ? '확률이 기준값에 못 미쳐요'
        : `확률 ${(ev.prob * 100).toFixed(1)}%가 기준 ${(ev.threshold * 100).toFixed(1)}%에 못 미쳐요`;
    default:
      return '판정할 수 없어요';
  }
}

/**
 * 봉을 넣으면 스캐너와 같은 절차로 판정한다.
 * 거래일 경계(04:00 ET)·누적 거래대금은 ModelDayBars가 처리한다(주간거래 봉 포함 — bars.ts 주석).
 */
export function inspectModel(model: GbdtModel, input: ModelInspectInput): ModelInspection {
  const store = new ModelDayBars(input.barMinutes);
  store.merge(input.bars);
  const lastKey = store.lastKey;
  const etDate = lastKey === null ? null : etDateString(lastKey);
  const dayOpen = store.dayOpen;

  const base = {
    dayBars: store.size,
    dayOpen,
    cumDollarVolume: store.cumDollarVolume,
    etDate,
  };
  if (lastKey === null || dayOpen === null || !(dayOpen > 0)) {
    return { ...base, signal: null, prob: null, threshold: model.threshold, reject: 'bars', bars: store.size };
  }

  // 전일·전전일 종가 — 판정일보다 앞선 날짜만(오늘 진행 중 일봉이 섞여 오므로 잘라낸다).
  const past = (input.dailyCloses ?? []).filter((d) => d.date < etDate!);
  const ev = evaluateModel(model, {
    bars: store.bars,
    ctx: {
      dayOpen,
      prevClose: past.length > 0 ? past[past.length - 1].close : null,
      prevPrevClose: past.length > 1 ? past[past.length - 2].close : null,
    },
    cumDollarVolume: store.cumDollarVolume,
    barMinutes: input.barMinutes,
  });
  return { ...base, ...ev };
}
