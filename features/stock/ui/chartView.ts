import { barKeyOf } from '../../../core/trend/bars';

export interface ChartCandle {
  key: string;
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  inProgress?: boolean;
}

function formatEtClockFromMs(tsMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    }).format(new Date(tsMs));
  } catch {
    const d = new Date(tsMs);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

export function buildHistoricalWindow(candles: ChartCandle[] | null, viewOffset: number, maxCandles: number): ChartCandle[] | null {
  if (!candles) return null;
  if (viewOffset <= 0) return candles;
  const maxWindow = Math.max(1, maxCandles);
  const startIndex = Math.max(0, candles.length - viewOffset - maxWindow);
  const endIndex = candles.length - viewOffset;
  return candles.slice(startIndex, endIndex);
}

export function applyLivePriceOverlay({
  candles,
  livePrice,
  liveTickAt,
  minuteInterval,
  mode,
  isHistoricalView,
}: {
  candles: ChartCandle[] | null;
  livePrice: number | null;
  liveTickAt: number | null;
  minuteInterval: number;
  mode: 'minute' | 'daily' | 'weekly' | 'monthly';
  isHistoricalView: boolean;
}): ChartCandle[] | null {
  if (candles === null || isHistoricalView || mode !== 'minute') {
    return candles;
  }
  if (!Number.isFinite(livePrice as number) || (livePrice as number) <= 0) {
    return candles;
  }
  if (candles.length === 0) {
    return candles;
  }

  const price = livePrice as number;
  const tickAt = liveTickAt ?? Date.now();
  const liveKey = barKeyOf(tickAt, minuteInterval as 1 | 3 | 5);
  const next = candles.map((c) => ({ ...c, inProgress: Number(c.key) === liveKey }));
  const last = next[next.length - 1];
  const lastKey = Number(last.key);

  if (!Number.isFinite(lastKey)) return candles;
  if (liveKey < lastKey) return next;

  if (liveKey === lastKey) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.inProgress = true;
    return next;
  }

  last.inProgress = false;
  next.push({
    key: String(liveKey),
    label: formatEtClockFromMs(tickAt),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
    inProgress: true,
  });
  return next;
}
