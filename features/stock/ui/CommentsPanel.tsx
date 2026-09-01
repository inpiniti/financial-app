// 종목 상세화면 "커뮤니티" 탭 — 토스 커뮤니티 댓글 뷰. 댓글을 누르면 답글 시트(RepliesSheet)가 열린다.
// 진입 시에만 조회한다 — 폴링·자동 갱신 금지(lib/tossCommunity.ts 주석과 동일 원칙).
import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchTossComments,
  resolveTossProductCode,
  type TossComment,
  type TossCommentSort,
} from '../../../lib/tossCommunity';
import { CommentRow, CommentSkeletonRow } from './CommentRow';
import { RepliesSheet } from './RepliesSheet';

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

/**
 * 목록 행 래퍼 — comment·onOpen 참조가 같으면 리렌더하지 않는다. CommentRow에 인라인 화살표
 * onPress를 바로 넘기면 매 렌더 새 함수라 memo가 무력해져서, 여기서 안정된 onPress를 만들어 넘긴다.
 */
const CommentItem = memo(function CommentItem({
  comment,
  onOpen,
}: {
  comment: TossComment;
  onOpen: (comment: TossComment) => void;
}) {
  const handlePress = useCallback(() => onOpen(comment), [onOpen, comment]);
  return <CommentRow comment={comment} onPress={handlePress} />;
});

// memo — 부모(종목 상세화면)가 실시간 체결가로 1초마다 리렌더돼도, props(ticker 문자열)가
// 같으면 커뮤니티 탭 전체가 다시 그려지지 않게 한다(2026-09-01 렌더 격리).
export const CommentsPanel = memo(function CommentsPanel({ ticker }: CommentsPanelProps) {
  const [sort, setSort] = useState<TossCommentSort>('RECENT');
  const [productCode, setProductCode] = useState<string | null>(null);
  const [comments, setComments] = useState<TossComment[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [nextKey, setNextKey] = useState<string | number | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'resolving' });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openedComment, setOpenedComment] = useState<TossComment | null>(null);

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
    setOpenedComment(null);
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
    if (!productCode || !hasNext || nextKey == null || loadingMore || state.kind !== 'ready') return;
    setLoadingMore(true);
    try {
      const page = await fetchTossComments(productCode, sort, nextKey);
      // 이미 가진 댓글은 걸러낸다 — 서버가 같은 페이지를 다시 주더라도 중복 key로 리스트가 깨지지 않게.
      setComments((prev) => {
        const seen = new Set(prev.map((c) => String(c.commentId)));
        const fresh = page.results.filter((c) => !seen.has(String(c.commentId)));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      // 커서가 안 움직이면 더 받아봐야 같은 페이지다 — 무한 재요청을 끊는다.
      setHasNext(page.hasNext && page.key != null && String(page.key) !== String(nextKey));
      setNextKey(page.key);
    } catch {
      // 다음 페이지 실패는 조용히 무시 — 이미 로드된 목록은 유지하고, 당겨서 새로고침으로 다시 시도할 수 있다.
    } finally {
      setLoadingMore(false);
    }
  }, [productCode, hasNext, nextKey, loadingMore, sort, state.kind]);

  const openComment = useCallback((comment: TossComment) => setOpenedComment(comment), []);

  // renderItem을 렌더마다 새로 만들지 않는다 — FlatList가 행 재렌더 여부를 안정적으로 판단하게.
  const renderComment = useCallback(
    ({ item }: { item: TossComment }) => <CommentItem comment={item} onOpen={openComment} />,
    [openComment],
  );

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
              <CommentSkeletonRow key={i} />
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
            keyExtractor={(item) => String(item.commentId)}
            renderItem={renderComment}
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

      <RepliesSheet comment={openedComment} onClose={() => setOpenedComment(null)} />
    </View>
  );
});
