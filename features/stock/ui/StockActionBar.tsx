// 종목 상세화면 하단 고정 매수/매도 액션바 — 토스증권 스타일 UI.
// - 보유 종목: 매수 버튼 비활성화, 매도 버튼 활성화
// - 미보유 종목: 매수 버튼 활성화, 매도 버튼 비활성화
// - 매수: 진입 규칙(startAmountUsd/fixedQty, 현재가 지정가)에 따라 발주, 체결 시 +3% 익절 선등록 자동 인계
// - 매도: 청산 규칙(전량 현재가 추격 매도)에 따라 발주, 기존 선등록 매도 취소 후 즉시 교체
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AutoPilotManager } from '../../scalper/autopilotManager';
import type { StockMarketCode } from '../marketCodes';

export interface StockActionBarProps {
  ticker: string;
  market: StockMarketCode;
  name?: string;
  livePrice: number | null;
  autopilot: AutoPilotManager | null;
}

export type StockHoldingState = 'IDLE' | 'HELD' | 'EXITING';

export function StockActionBar({ ticker, market, name, livePrice, autopilot }: StockActionBarProps) {
  const insets = useSafeAreaInsets();
  const [holdingState, setHoldingState] = useState<StockHoldingState>('IDLE');
  const [submitting, setSubmitting] = useState<'buy' | 'sell' | null>(null);

  // 보유/매도 상태 구독 및 동기화
  useEffect(() => {
    let cancelled = false;

    if (!autopilot) {
      return;
    }

    // 1. 메모리 상의 activeTickers 및 exitingTickers 즉시 확인
    const isExitingNow = autopilot.isExiting(ticker);
    const isHeldNow = autopilot.isHeld(ticker);
    setHoldingState(isExitingNow ? 'EXITING' : isHeldNow ? 'HELD' : 'IDLE');

    // 2. 실시간 view 변경 구독 (진입·체결·청산 시 자동 반영)
    const unsubscribe = autopilot.subscribeView((view) => {
      if (!cancelled) {
        if (view.exitingTickers.includes(ticker)) {
          setHoldingState('EXITING');
        } else if (view.activeTickers.includes(ticker)) {
          setHoldingState('HELD');
        } else {
          setHoldingState('IDLE');
        }
      }
    });

    // 3. 증권사 계좌 실잔고까지 비동기 대조
    autopilot
      .checkHolding(ticker)
      .then((held) => {
        if (!cancelled) {
          // 실시간으로 EXITING 중이면 잔고 결과로 덮어쓰지 않는다
          setHoldingState((prev) => {
            if (prev === 'EXITING') return 'EXITING';
            return held ? 'HELD' : 'IDLE';
          });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [autopilot, ticker]);

  // 매수 실행 핸들러
  const handleBuyPress = useCallback(() => {
    if (!autopilot) {
      Alert.alert('알림', '계좌 설정에서 KIS API 키를 먼저 등록해 주세요.');
      return;
    }

    const priceText = livePrice && livePrice > 0 ? `\n(현재가: $${livePrice.toFixed(2)})` : '';
    const view = autopilot.getView();

    // 오토파일럿이 시작되지 않은 상태인 경우: 시작 후 매매 진행 여부 확인
    if (view.state === 'IDLE') {
      Alert.alert(
        '자동 트레이딩 시작',
        `${name ?? ticker} 종목을 진입 규칙에 따라 매수하려면 자동 트레이딩이 켜져 있어야 해요.${priceText}\n\n지금 시작하고 매수할까요?`,
        [
          { text: '취소', style: 'cancel' },
          {
            text: '시작하고 매수',
            onPress: async () => {
              try {
                setSubmitting('buy');
                autopilot.start();
                const err = await autopilot.buyNow(ticker, {
                  price: livePrice ?? undefined,
                  market,
                  name,
                });
                if (err) {
                  Alert.alert('매수 실패', err);
                } else {
                  setHoldingState('HELD');
                }
              } catch (e) {
                Alert.alert('매수 오류', e instanceof Error ? e.message : String(e));
              } finally {
                setSubmitting(null);
              }
            },
          },
        ],
      );
      return;
    }

    // 이미 실행 중인 경우: 일반 확인 다이얼로그
    Alert.alert(
      '매수 확인',
      `${name ?? ticker} 종목을 진입 규칙에 따라 매수할까요?${priceText}\n\n체결 즉시 +3% 익절 선등록 및 물타기 감시가 시작돼요.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '매수하기',
          onPress: async () => {
            try {
              setSubmitting('buy');
              const err = await autopilot.buyNow(ticker, {
                price: livePrice ?? undefined,
                market,
                name,
              });
              if (err) {
                Alert.alert('매수 실패', err);
              } else {
                setHoldingState('HELD');
              }
            } catch (e) {
              Alert.alert('매수 오류', e instanceof Error ? e.message : String(e));
            } finally {
              setSubmitting(null);
            }
          },
        },
      ],
    );
  }, [autopilot, livePrice, market, name, ticker]);

  // 매도 실행 핸들러
  const handleSellPress = useCallback(() => {
    if (!autopilot) {
      Alert.alert('알림', '계좌 설정에서 KIS API 키를 먼저 등록해 주세요.');
      return;
    }

    const priceText = livePrice && livePrice > 0 ? `\n(현재가: $${livePrice.toFixed(2)})` : '';
    const view = autopilot.getView();

    if (view.state === 'IDLE') {
      Alert.alert(
        '자동 트레이딩 시작',
        `${name ?? ticker} 종목을 청산 규칙에 따라 매도하려면 자동 트레이딩이 켜져 있어야 해요.${priceText}\n\n지금 시작하고 매도할까요?`,
        [
          { text: '취소', style: 'cancel' },
          {
            text: '시작하고 매도',
            style: 'destructive',
            onPress: async () => {
              try {
                setSubmitting('sell');
                autopilot.start();
                const err = await autopilot.sellNow(ticker, livePrice ?? undefined);
                if (err) {
                  Alert.alert('매도 실패', err);
                } else {
                  setHoldingState('EXITING');
                }
              } catch (e) {
                Alert.alert('매도 오류', e instanceof Error ? e.message : String(e));
              } finally {
                setSubmitting(null);
              }
            },
          },
        ],
      );
      return;
    }

    Alert.alert(
      '전량 매도 확인',
      `${name ?? ticker} 보유 수량 전량을 청산 규칙에 따라 매도할까요?${priceText}\n\n체결될 때까지 현재가로 추격 매도해요.`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '전량 매도',
          style: 'destructive',
          onPress: async () => {
            try {
              setSubmitting('sell');
              const err = await autopilot.sellNow(ticker, livePrice ?? undefined);
              if (err) {
                Alert.alert('매도 실패', err);
              } else {
                setHoldingState('EXITING');
              }
            } catch (e) {
              Alert.alert('매도 오류', e instanceof Error ? e.message : String(e));
            } finally {
              setSubmitting(null);
            }
          },
        },
      ],
    );
  }, [autopilot, livePrice, name, ticker]);

  const isBuyDisabled = holdingState !== 'IDLE' || submitting !== null;
  const isSellDisabled = holdingState !== 'HELD' || submitting !== null;
  const isExiting = holdingState === 'EXITING';

  return (
    <View
      className="flex-row items-center border-t border-[#f2f4f6] bg-white px-4 pt-2.5"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      {/* 매도 버튼 (좌측, 파란색 계열) */}
      <Pressable
        onPress={handleSellPress}
        disabled={isSellDisabled}
        className="mr-2 flex-1 items-center justify-center rounded-2xl py-3.5 active:opacity-80"
        style={{
          backgroundColor: isSellDisabled ? '#f2f4f6' : '#3182f6',
          minHeight: 48,
        }}
        accessibilityRole="button"
        accessibilityLabel={isExiting ? '매도 중' : '매도'}
        accessibilityState={{ disabled: isSellDisabled }}
      >
        {submitting === 'sell' ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Text
            className="text-base font-bold"
            style={{ color: isSellDisabled ? '#b0b8c1' : '#ffffff' }}
          >
            {isExiting ? '매도 중...' : '매도'}
          </Text>
        )}
      </Pressable>

      {/* 매수 버튼 (우측, 빨간색 계열) */}
      <Pressable
        onPress={handleBuyPress}
        disabled={isBuyDisabled}
        className="ml-2 flex-1 items-center justify-center rounded-2xl py-3.5 active:opacity-80"
        style={{
          backgroundColor: isBuyDisabled ? '#f2f4f6' : '#f04452',
          minHeight: 48,
        }}
        accessibilityRole="button"
        accessibilityLabel="매수"
        accessibilityState={{ disabled: isBuyDisabled }}
      >
        {submitting === 'buy' ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Text
            className="text-base font-bold"
            style={{ color: isBuyDisabled ? '#b0b8c1' : '#ffffff' }}
          >
            매수
          </Text>
        )}
      </Pressable>
    </View>
  );
}
