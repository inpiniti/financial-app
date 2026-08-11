// USD/KRW 환율 훅 — 화면이 마운트될 때(또는 reloadKey가 바뀔 때) 한 번 읽어 온다.
// 값 자체와 캐시는 lib/usdKrw.ts 몫이고, 여기서는 화면 수명주기에 맞춰 상태로 노출하기만 한다.
// 환율을 못 구하면 null — 호출부는 원화 대신 USD만 보여주는 폴백을 쓴다.
import { useEffect, useState } from 'react';
import { getUsdKrwRate } from './usdKrw';

export function useUsdKrwRate(reloadKey: number = 0): number | null {
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getUsdKrwRate().then((value) => {
      if (!cancelled) setRate(value);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return rate;
}
