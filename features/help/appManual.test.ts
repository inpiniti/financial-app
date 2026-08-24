import { describe, expect, it } from 'vitest';
import {
  APP_MANUAL,
  HIDDEN_SETTING_KEYS,
  USER_FACING_SETTING_KEYS,
  describeRuntimeState,
  describeUserSettings,
} from './appManual';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../lib/appSettings';
import { RANKING_TOTAL_MAX, tossSourceId } from '../../core/ranking';
import { MAX_GRIDS_LIMIT } from '../scalper/autopilot';
import { MODEL_CONFIG } from '../scalper/positionManager';
import { MODEL_BAR_MINUTES } from '../scalper/modelMode';

/**
 * 이 파일의 목적은 "문서가 조용히 낡는 것"을 막는 것이다 — 챗봇이 낡은 값을 확신에 차서 말하면
 * 정적 문서보다 나쁘다. 그래서 규칙 값은 코드 상수와 대조하고, 설정 키는 커버리지를 강제한다.
 */
describe('APP_MANUAL — 코드 상수와 어긋나지 않는다', () => {
  it('봉 주기·동시 그리드 상한·리스트 상한은 코드 값 그대로 들어간다', () => {
    expect(APP_MANUAL).toContain(`${MODEL_BAR_MINUTES}분봉이 하나 닫힐 때마다`);
    expect(APP_MANUAL).toContain(`최대 ${MAX_GRIDS_LIMIT}개`);
    expect(APP_MANUAL).toContain(`${RANKING_TOTAL_MAX}개의 트레이딩 리스트`);
  });

  it('차트 기본 분봉은 모델 봉 주기와 같다 — 화면과 엔진이 다른 봉을 보면 판정이 어긋난다(2026-08-22 사고)', () => {
    expect(APP_MANUAL).toContain(`분봉 기본값은 ${MODEL_BAR_MINUTES}분`);
  });

  it('현행이 아닌 규칙(추세 4선)을 매매 규칙으로 설명하지 않는다 — 모델 전환 뒤 문서가 뒤처지지 않게', () => {
    // 4선은 차트 오버레이로만 남았다. "판정/매수/매도 기준"으로 소개하면 챗봇이 옛 규칙을 말한다.
    expect(APP_MANUAL).not.toContain('4선이 꺾');
    expect(APP_MANUAL).not.toContain('4선이 모두 상승');
    expect(APP_MANUAL).not.toContain('플립');
  });

  it('설정 기본값은 하드코딩이 아니라 DEFAULT_APP_SETTINGS에서 온다', () => {
    expect(APP_MANUAL).toContain(`기본 $${DEFAULT_APP_SETTINGS.startAmountUsd}`);
    expect(APP_MANUAL).toContain(`기본 $${DEFAULT_APP_SETTINGS.maxPriceUsd}`);
    expect(APP_MANUAL).toContain(`기본 ${DEFAULT_APP_SETTINGS.minTickRate}`);
  });

  it('매도선 2개(트레일링·손절)는 MODEL_CONFIG 값을 그대로 따라간다', () => {
    const pct = (r: number) => `${Number((r * 100).toFixed(2))}%`;
    expect(APP_MANUAL).toContain(`지금까지의 최고가에서 ${pct(MODEL_CONFIG.trailPct)} 아래`);
    expect(APP_MANUAL).toContain(`산 가격보다 ${pct(MODEL_CONFIG.stopLossPct)} 아래`);
  });

  it('익절 상한이 없다는 사실이 적혀 있다 — 트레일링 전환의 핵심', () => {
    expect(APP_MANUAL).toContain('얼마를 벌면 판다는 목표가 없어요');
    expect(APP_MANUAL).toContain('한 번 올라간 매도선은 내려오지 않아요');
  });

  it('승률이 낮다는 사실을 숨기지 않는다 — 트레일링은 자주 지고 크게 번다', () => {
    expect(APP_MANUAL).toContain('승률은 **34%로 낮아요**');
  });

  it('물타기를 하지 않는다는 사실이 적혀 있다 — 오해가 가장 잦은 지점', () => {
    expect(APP_MANUAL).toContain('물타기');
    expect(APP_MANUAL).toContain('하지 않아요');
  });
});

describe('설정 키 커버리지 — 설정을 추가하면 문서도 같이 바뀌게 강제한다', () => {
  it('USER_FACING + HIDDEN이 AppSettings 전체를 정확히 덮는다', () => {
    const covered = [...USER_FACING_SETTING_KEYS, ...HIDDEN_SETTING_KEYS].sort();
    const all = (Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[]).sort();
    expect(covered).toEqual(all);
  });

  it('사용자에게 보이는 설정은 매뉴얼 §7에 설명이 있다', () => {
    const LABEL: Record<(typeof USER_FACING_SETTING_KEYS)[number], string> = {
      startAmountUsd: '**진입금액(USD)**',
      entryQty: '**수량(주)**',
      maxPriceUsd: '**가격 상한(USD)**',
      maxConcurrentGrids: '**동시 그리드 수**',
      minTickRate: '**최소 속도(틱/초)**',
      watchCount: '**매수 후보 수**',
      buyCancelAfterSec: '**매수 미체결 취소(초)**',
      rankingSelection: '**순위 원천**',
    };
    for (const key of USER_FACING_SETTING_KEYS) {
      expect(APP_MANUAL, `${key} 설명 누락`).toContain(LABEL[key]);
    }
  });
});

describe('describeUserSettings — 지금 걸린 값을 대화에 붙인다', () => {
  it('금액 모드는 진입금액 ÷ 현재가로 설명한다', () => {
    const text = describeUserSettings({ ...DEFAULT_APP_SETTINGS, entryQty: 0, startAmountUsd: 12 });
    expect(text).toContain('금액 $12 ÷ 현재가');
    expect(text).toContain('동시 그리드 수: 1개');
  });

  it('수량 모드는 가격 상한과 함께 설명한다', () => {
    const text = describeUserSettings({ ...DEFAULT_APP_SETTINGS, entryQty: 2, maxPriceUsd: 150 });
    expect(text).toContain('수량 고정 2주');
    expect(text).toContain('$150');
  });

  it('진입금액이 0이면 시작 불가라고 알린다 — "왜 시작이 안 돼요?"의 답', () => {
    expect(describeUserSettings({ ...DEFAULT_APP_SETTINGS, startAmountUsd: 0 })).toContain('시작 불가');
  });

  it('순위 원천은 켜진 것만 표시명으로 적는다', () => {
    const id = tossSourceId('amount', 'realtime', false);
    const text = describeUserSettings({
      ...DEFAULT_APP_SETTINGS,
      rankingSelection: { [id]: { enabled: true, count: 15 } },
    });
    expect(text).toContain('토스 거래대금 실시간 위험미포함 15개');
  });

  it('켜진 원천이 없으면 리스트가 빈다고 알린다', () => {
    const text = describeUserSettings({ ...DEFAULT_APP_SETTINGS, rankingSelection: {} });
    expect(text).toContain('트레이딩 리스트가 비어요');
  });
});

describe('describeRuntimeState — 넘겨준 만큼만 적는다', () => {
  it('빈 상태는 빈 문자열이다(없는 값을 지어내지 않게)', () => {
    expect(describeRuntimeState({})).toBe('');
  });

  it('상태·리스트·보유·사이클을 줄로 적는다', () => {
    const text = describeRuntimeState({ state: 'SCANNING', listCount: 30, activeTickers: ['TSLA'], cycles: 2 });
    expect(text).toContain('오토파일럿 상태: SCANNING');
    expect(text).toContain('트레이딩 리스트: 30종목');
    expect(text).toContain('보유 중: TSLA');
    expect(text).toContain('오늘 완료된 매매: 2회');
  });

  it('보유가 비면 "없음"이다', () => {
    expect(describeRuntimeState({ activeTickers: [] })).toContain('보유 중: 없음');
  });
});
