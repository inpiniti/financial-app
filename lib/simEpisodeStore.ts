// simEpisodeStore — 가상 전략 에피소드를 Supabase sim_episodes에 기록한다 (시뮬레이션 plan §B-3).
//
// 네트워크·설정 실패가 시뮬 진행을 절대 막지 않는다:
//  · insert 실패(오프라인·RLS·미설정) → AsyncStorage 큐(sim:episodeQueue)에 적재
//  · 다음 기록 시점마다 큐를 먼저 flush 시도 — 성공하면 비운다
//  · 큐 상한 500행 — 넘치면 가장 오래된 것부터 버린다(연구 데이터라 유실 허용, 앱 저장소 보호가 우선)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import type { SimEpisodeRecord } from '../features/scalper/simLab';

const QUEUE_KEY = 'sim:episodeQueue';
const QUEUE_LIMIT = 500;
const TABLE = 'sim_episodes';

/** flush 재진입 방지 — 에피소드가 몰릴 때(마감 일괄) 큐를 이중으로 읽지 않는다. */
let flushing = false;

/**
 * 에피소드 1행 기록 — 큐 flush를 먼저 시도하고 새 행을 insert한다. 실패는 큐로.
 * fire-and-forget으로 부른다(SimLab.onRecord) — 반환 Promise를 기다리지 않아도 순서가 안 깨진다
 * (실패분은 큐에 남고 다음 호출이 재시도).
 */
export async function recordSimEpisode(record: SimEpisodeRecord): Promise<void> {
  await flushQueuedEpisodes();
  const ok = await tryInsert([record]);
  if (!ok) await enqueue([record]);
}

/** 큐에 남은 행 재전송 — 성공하면 비운다. 앱 시작 시(managerProvider)에도 한 번 부른다. */
export async function flushQueuedEpisodes(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const queued = await readQueue();
    if (queued.length === 0) return;
    const ok = await tryInsert(queued);
    if (ok) await AsyncStorage.removeItem(QUEUE_KEY);
  } finally {
    flushing = false;
  }
}

/** 큐 길이(진단용). */
export async function queuedEpisodeCount(): Promise<number> {
  return (await readQueue()).length;
}

async function tryInsert(records: SimEpisodeRecord[]): Promise<boolean> {
  if (!isSupabaseConfigured()) return false; // 미설정 — 큐에 쌓아 두면 설정 후 flush로 흘러간다.
  try {
    const { error } = await getSupabaseClient().from(TABLE).insert(records);
    return error === null;
  } catch {
    return false;
  }
}

async function readQueue(): Promise<SimEpisodeRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SimEpisodeRecord[]) : [];
  } catch {
    return [];
  }
}

async function enqueue(records: SimEpisodeRecord[]): Promise<void> {
  const queued = await readQueue();
  const next = [...queued, ...records];
  // 상한 초과 — 가장 오래된 것부터 버린다.
  const trimmed = next.length > QUEUE_LIMIT ? next.slice(next.length - QUEUE_LIMIT) : next;
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
  } catch {
    // 저장 실패 — 이 행은 유실된다(연구 데이터라 허용).
  }
}
