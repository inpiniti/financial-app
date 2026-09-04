import { describe, expect, it } from 'vitest';
import {
  APP_MANUAL,
  ENGINE_BAR_MINUTES,
  HIDDEN_SETTING_KEYS,
  USER_FACING_SETTING_KEYS,
  buildAppManual,
  describeRuntimeState,
  describeUserSettings,
} from './appManual';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../lib/appSettings';
import { MARTINGALE_CONFIG } from '../../core/martingale';
import { SLOPE_CONFIG, SLOPE_EXIT_TICK_MS } from '../../core/slope';
import { MODEL_SYMMETRIC_EXIT_CONFIG } from '../../core/model/exitRule';
import { RANKING_TOTAL_MAX, tossSourceId } from '../../core/ranking';
import { MAX_GRIDS_LIMIT } from '../scalper/autopilot';
import { MODEL_BAR_MINUTES } from '../scalper/modelMode';

const pct = (r: number) => `${Number((r * 100).toFixed(2))}%`;

// 두 모드 본을 다 검사한다(2026-09-01 설정화 — 어느 모드를 골라도 챗봇이 맞는 값을 말해야 한다).
const MG_MANUAL = buildAppManual('martingale');
const MODEL_MANUAL = buildAppManual('model');
const SLOPE_MANUAL = buildAppManual('slope');

/**
 * 이 파일의 목적은 "문서가 조용히 낡는 것"을 막는 것이다 — 챗봇이 낡은 값을 확신에 차서 말하면
 * 정적 문서보다 나쁘다. 그래서 규칙 값은 코드 상수와 대조하고, 설정 키는 커버리지를 강제한다.
 */
describe('APP_MANUAL — 코드 상수와 어긋나지 않는다', () => {
  it('APP_MANUAL은 기본 모드(martingale) 고정본이다', () => {
    expect(APP_MANUAL).toBe(MG_MANUAL);
  });

  it('봉 주기·동시 그리드 상한·리스트 상한은 코드 값 그대로 들어간다', () => {
    expect(MG_MANUAL).toContain(`${ENGINE_BAR_MINUTES}분봉 5선(최근 5봉 평균)`);
    expect(MG_MANUAL).toContain(`최대 ${MAX_GRIDS_LIMIT}개`);
    expect(MG_MANUAL).toContain(`${RANKING_TOTAL_MAX}개의 트레이딩 리스트`);
  });

  it('차트 기본 분봉은 엔진 봉 주기와 같다 — 화면과 엔진이 다른 봉을 보면 판정이 어긋난다(2026-08-22 사고)', () => {
    expect(MG_MANUAL).toContain(`분봉 기본값은 ${ENGINE_BAR_MINUTES}분`);
  });

  it('현행이 아닌 규칙(추세 플립)을 매매 규칙으로 설명하지 않는다 — 전환 뒤 문서가 뒤처지지 않게', () => {
    for (const manual of [MG_MANUAL, MODEL_MANUAL]) {
      expect(manual).not.toContain('4선이 꺾');
      expect(manual).not.toContain('플립');
    }
  });

  it('설정 기본값은 하드코딩이 아니라 DEFAULT_APP_SETTINGS에서 온다', () => {
    expect(MG_MANUAL).toContain(`기본 $${DEFAULT_APP_SETTINGS.startAmountUsd}`);
    expect(MG_MANUAL).toContain(`기본 $${DEFAULT_APP_SETTINGS.maxPriceUsd}`);
    expect(MG_MANUAL).toContain(`기본 ${DEFAULT_APP_SETTINGS.minTickRate}`);
  });

  it('5선 물타기 단타: 익절·물타기 선·마감 청산이 MARTINGALE_CONFIG 값을 그대로 따라간다', () => {
    expect(MG_MANUAL).toContain(`+${pct(MARTINGALE_CONFIG.tpPct)}** 오르면 전량 매도`);
    expect(MG_MANUAL).toContain(`평단 −${pct(MARTINGALE_CONFIG.dropStartPct)} 아래에서 5선 돌파`);
    expect(MG_MANUAL).toContain(`−${pct(MARTINGALE_CONFIG.dropMaxPct)}에서 상한`);
    expect(MG_MANUAL).toContain('손절은 없어요');
    const close = `${Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:${String(MARTINGALE_CONFIG.closeAtMin % 60).padStart(2, '0')}`;
    expect(MG_MANUAL).toContain(`${close} ET`);
  });

  it('5선 물타기 단타: 세션 제한(주간거래 진입 없음)과 5선 돌파 진입 조건이 적혀 있다', () => {
    expect(MG_MANUAL).toContain('주간거래(미국 밤, 한국 낮) 시간에는 진입하지 않아요');
    expect(MG_MANUAL).toContain('5선이 오르는 중이고 가격이 5선을 아래에서 위로 뚫는 봉');
    expect(MG_MANUAL).not.toContain('정배열(5선>20선>60선>120선)이고 네 선이'); // 옛 고정 규칙 문구 — 옵션 설명의 '정배열'은 허용
  });

  it('기울기 단타(2026-09-02): 문턱·재판정 주기가 SLOPE_CONFIG를 따라가고, 익절·손절·물타기 없음을 말한다', () => {
    expect(SLOPE_MANUAL).toContain(`기울기 ≥ +${SLOPE_CONFIG.entryPct}%`);
    expect(SLOPE_MANUAL).toContain(`기울기 < +${SLOPE_CONFIG.exitPct}%`);
    expect(SLOPE_MANUAL).toContain(`${SLOPE_EXIT_TICK_MS}ms마다 다시 재요`);
    expect(SLOPE_MANUAL).toContain('익절·손절·물타기·시간 청산·마감 청산이 전부 없어요');
    expect(SLOPE_MANUAL).toContain('시험 운용 중');
    expect(SLOPE_MANUAL).not.toContain('5선 돌파');
    expect(SLOPE_MANUAL).not.toContain('모델 확률이 기준값을 넘고');
  });

  it('5선 물타기 단타: 검증 안 된 시험 운용임을 숨기지 않는다', () => {
    expect(MG_MANUAL).toContain('시험 운용 중');
    expect(MG_MANUAL).toContain('한 종목에 돈이 크게 몰릴 수 있어요');
  });

  it('모델: ±3% 대칭 밴드·래칫 청산이 MODEL_SYMMETRIC_EXIT_CONFIG 값을 그대로 따라간다(2026-09-02)', () => {
    expect(MODEL_MANUAL).toContain(`±${pct(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct)}로 올려 달아요`);
    expect(MODEL_MANUAL).toContain(`평단 −${pct(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct)})에 닿으면 전량 매도`);
    expect(MODEL_MANUAL).toContain(`**${MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분**`);
    expect(MODEL_MANUAL).toContain('시간 청산');
    expect(MODEL_MANUAL).toContain('모델을 다시 물어봐요'); // 익절 보류(래칫) — 사용자 제안의 핵심
    // 트레일링(구모델) 서술이 남아 있으면 안 된다.
    expect(MODEL_MANUAL).not.toContain('트레일링');
    expect(MODEL_MANUAL).not.toContain('매도선은 내려오지 않아요');
  });

  it('모델: 봉 주기·검증 성적(승률 58%·얇은 우위)을 코드 값·최신 워크포워드와 맞춘다', () => {
    expect(MODEL_MANUAL).toContain(`${MODEL_BAR_MINUTES}분봉이 하나 닫힐 때마다`);
    expect(MODEL_MANUAL).toContain('승률 58%');
    expect(MODEL_MANUAL).toContain('체결이 조금만 불리해도');
  });

  it('물타기를 하지 않는다는 사실이 적혀 있다 — 오해가 가장 잦은 지점', () => {
    for (const manual of [MG_MANUAL, MODEL_MANUAL]) {
      expect(manual).toContain('물타기');
      expect(manual).toContain('하지 않아요');
    }
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
      entryStrategy: '**진입 전략**',
      exitStrategy: '**청산 전략**',
      engineOptions: '**엔진 옵션(중복 선택)**',
      startAmountUsd: '**진입금액(USD)**',
      entryQty: '**수량(주)**',
      maxPriceUsd: '**가격 상한(USD)**',
      minPriceUsd: '**가격 하한(USD)**',
      maxConcurrentGrids: '**동시 그리드 수**',
      minTickRate: '**최소 속도(틱/초)**',
      watchCount: '**매수 후보 수**',
      buyCancelAfterSec: '**매수 미체결 취소(초)**',
      buyStrategy: '**매수 전략**',
      sellStrategy: '**매도 전략**',
      sellCancelAfterSec: '**매도 미체결 취소(초)**',
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
