// 종목 상세화면 "댓글" 탭 — 옛 CommentsSheet.tsx(바텀시트)에서 추출한 토스 커뮤니티 댓글 뷰.
// 진입 시에만 조회한다 — 폴링·자동 갱신 금지(lib/tossCommunity.ts 주석과 동일 원칙).
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchTossComments,
  resolveTossProductCode,
  type TossComment,
  type TossCommentSort,
} from '../../../lib/tossCommunity';

export interface CommentsPanelProps {
  ticker: string;
}

type LoadState =
  | { kind: 'resolving' }
  | { kind: 'notFound' }
  | { kind: 'loading' } // 최초 목록 로딩(스켈레톤)
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const SORT_OPTIONS: Array<{ value: TossCommentSort; label: string }> = [
  { value: 'RECENT', label: '최신' },
  { value: 'POPULAR', label: '인기' },
];

/** 뱃지 색 키 → 연한 배경 pill 톤(토스 토큰 계열). 알 수 없는 키는 중립 회색으로 안전하게 처리한다. */
const BADGE_COLOR: Record<string, { bg: string; fg: string }> = {
  yellow: { bg: '#fff6e0', fg: '#ffb331' },
  blue: { bg: '#eaf2ff', fg: '#3182f6' },
  green: { bg: '#e6f4ea', fg: '#03b26c' },
};
const DEFAULT_BADGE_COLOR = { bg: '#f7f9fc', fg: '#8b95a1' };

/** 본문 미리보기 상한(대략 6줄 분량의 문자 수 휴리스틱) — RN onTextLayout은 numberOfLines로 잘린 뒤 실측이라 넘침 여부를 신뢰성 있게 못 잡는다. */
const PREVIEW_CHAR_LIMIT = 220;

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '방금';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}일 전`;
}

function SegmentToggle({ value, onChange }: { value: TossCommentSort; onChange: (next: TossCommentSort) => void }) {
  return (
    <View className="flex-row rounded-xl bg-[#f7f9fc] p-1">
      {SORT_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            className={`items-center justify-center rounded-lg px-4 py-2 ${active ? 'bg-white' : ''}`}
            style={{ minHeight: 32 }}
          >
            <Text className={`text-xs font-semibold ${active ? 'text-[#191f28]' : 'text-[#8b95a1]'}`}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CommentRow({ comment }: { comment: TossComment }) {
  const [expanded, setExpanded] = useState(false);
  const message = comment.message.message ?? '';
  const truncated = !expanded && message.length > PREVIEW_CHAR_LIMIT;
  const badge = comment.author.badge;
  const badgeColor = badge ? (BADGE_COLOR[badge.color] ?? DEFAULT_BADGE_COLOR) : null;

  return (
    <View className="border-b border-[#f2f4f6] px-5 py-4">
      <View className="flex-row items-center">
        {comment.author.profilePictureUrl ? (
          <Image source={{ uri: comment.author.profilePictureUrl }} style={{ width: 32, height: 32, borderRadius: 16 }} />
        ) : (
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#e5e8eb' }} />
        )}
        <View className="ml-2 flex-1">
          <View className="flex-row flex-wrap items-center">
            <Text className="text-sm font-semibold text-[#191f28]">{comment.author.nickname}</Text>
            {badge && badgeColor && (
              <View className="ml-1 rounded-full px-2 py-0.5" style={{ backgroundColor: badgeColor.bg }}>
                <Text className="text-[10px] font-semibold" style={{ color: badgeColor.fg }}>
                  {badge.title}
                </Text>
              </View>
            )}
          </View>
          <Text className="text-xs text-[#8b95a1]">{formatRelativeTime(comment.createdAt)}</Text>
        </View>
      </View>

      {comment.message.title ? <Text className="mt-2 text-sm font-bold text-[#191f28]">{comment.message.title}</Text> : null}
      <Text className="mt-1 text-sm leading-5 text-[#4e5968]" numberOfLines={expanded ? undefined : 6}>
        {message}
      </Text>
      {truncated && (
        <Pressable onPress={() => setExpanded(true)} hitSlop={8}>
          <Text className="mt-1 text-xs font-semibold text-[#3182f6]">더보기</Text>
        </Pressable>
      )}

      <View className="mt-2 flex-row items-center" style={{ gap: 12 }}>
        <View className="flex-row items-center" style={{ gap: 3 }}>
          <Ionicons name="heart-outline" size={13} color="#8b95a1" />
          <Text className="text-xs text-[#8b95a1]">{comment.statistic.likeCount}</Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 3 }}>
          <Ionicons name="chatbubble-outline" size={13} color="#8b95a1" />
          <Text className="text-xs text-[#8b95a1]">{comment.statistic.replyCount}</Text>
        </View>
      </View>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View className="border-b border-[#f2f4f6] px-5 py-4">
      <View className="flex-row items-center">
        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#e5e8eb' }} />
        <View className="ml-2 flex-1">
          <View className="mb-1 h-3 w-1/3 rounded-full bg-[#e5e8eb]" />
          <View className="h-2.5 w-1/4 rounded-full bg-[#f7f9fc]" />
        </View>
      </View>
      <View className="mt-3 h-3 w-full rounded-full bg-[#f7f9fc]" />
      <View className="mt-2 h-3 w-2/3 rounded-full bg-[#f7f9fc]" />
    </View>
  );
}

export function CommentsPanel({ ticker }: CommentsPanelProps) {
  const [sort, setSort] = useState<TossCommentSort>('RECENT');
  const [productCode, setProductCode] = useState<string | null>(null);
  const [comments, setComments] = useState<TossComment[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [nextKey, setNextKey] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'resolving' });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirstPage = useCallback(async (code: string, sortValue: TossCommentSort) => {
    try {
      const page = await fetchTossComments(code, sortValue);
      setComments(page.results);
      setHasNext(page.hasNext);
      setNextKey(page.key);
      setState({ kind: 'ready' });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }, []);

  // 진입 시 productCode 해석 + 첫 페이지 조회.
  useEffect(() => {
    let cancelled = false;

    setSort('RECENT');
    setComments([]);
    setHasNext(false);
    setNextKey(null);
    setState({ kind: 'resolving' });

    (async () => {
      const code = await resolveTossProductCode(ticker).catch(() => null);
      if (cancelled) return;
      if (!code) {
        setState({ kind: 'notFound' });
        return;
      }
      setProductCode(code);
      setState({ kind: 'loading' });
      await loadFirstPage(code, 'RECENT');
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  const handleSortChange = useCallback(
    (next: TossCommentSort) => {
      if (!productCode || next === sort) return;
      setSort(next);
      setComments([]);
      setHasNext(false);
      setNextKey(null);
      setState({ kind: 'loading' });
      loadFirstPage(productCode, next);
    },
    [productCode, sort, loadFirstPage],
  );

  const handleRefresh = useCallback(() => {
    if (!productCode) return;
    setRefreshing(true);
    loadFirstPage(productCode, sort);
  }, [productCode, sort, loadFirstPage]);

  const handleRetry = useCallback(() => {
    if (!productCode) return;
    setState({ kind: 'loading' });
    loadFirstPage(productCode, sort);
  }, [productCode, sort, loadFirstPage]);

  const handleEndReached = useCallback(async () => {
    if (!productCode || !hasNext || !nextKey || loadingMore || state.kind !== 'ready') return;
    setLoadingMore(true);
    try {
      const page = await fetchTossComments(productCode, sort, nextKey);
      setComments((prev) => [...prev, ...page.results]);
      setHasNext(page.hasNext);
      setNextKey(page.key);
    } catch {
      // 다음 페이지 실패는 조용히 무시 — 이미 로드된 목록은 유지하고, 당겨서 새로고침으로 다시 시도할 수 있다.
    } finally {
      setLoadingMore(false);
    }
  }, [productCode, hasNext, nextKey, loadingMore, sort, state.kind]);

  return (
    <View className="flex-1 bg-white">
      {state.kind !== 'notFound' && (
        <View className="px-4 pb-3 pt-4">
          <SegmentToggle value={sort} onChange={handleSortChange} />
        </View>
      )}

      <View className="flex-1">
        {state.kind === 'resolving' || state.kind === 'loading' ? (
          <View>
            {[1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </View>
        ) : state.kind === 'notFound' ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="search-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
            <Text className="text-base font-semibold text-[#191f28]">이 종목의 토스 게시판을 찾지 못했어요</Text>
          </View>
        ) : state.kind === 'error' ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="alert-circle-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
            <Text className="mb-1 text-center text-base font-semibold text-[#191f28]">댓글을 불러오지 못했어요</Text>
            <Text className="mb-4 text-center text-sm text-[#8b95a1]">비공식 API라 막혔을 수 있어요</Text>
            <Pressable onPress={handleRetry} className="rounded-2xl bg-[#3182f6] px-5 py-3 active:opacity-80" style={{ minHeight: 44 }}>
              <Text className="text-sm font-semibold text-white">다시 시도하기</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={comments}
            keyExtractor={(item) => item.commentId}
            renderItem={({ item }) => <CommentRow comment={item} />}
            contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#3182f6" />}
            onEndReachedThreshold={0.4}
            onEndReached={handleEndReached}
            ListEmptyComponent={
              <View className="flex-1 items-center justify-center px-8 py-16">
                <Ionicons name="chatbubble-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
                <Text className="text-base font-semibold text-[#191f28]">아직 댓글이 없어요</Text>
              </View>
            }
            ListFooterComponent={loadingMore ? <ActivityIndicator className="py-4" color="#3182f6" /> : null}
          />
        )}
      </View>
    </View>
  );
}
