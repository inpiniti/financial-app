// 댓글 하나의 답글 목록 시트 — 커뮤니티 탭에서 댓글을 누르면 열린다. 조회 전용(작성·좋아요 없음).
// 답글은 v2 엔드포인트만 존재하며(`/api/v2/comments/{id}/replies`), 커서 규칙은 본문 댓글과 같다.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '../../../components/BottomSheet';
import { fetchTossReplies, type TossComment } from '../../../lib/tossCommunity';
import { CommentRow, CommentSkeletonRow } from './CommentRow';

export interface RepliesSheetProps {
  /** 열려 있는 원문 댓글. null이면 시트를 닫는다. */
  comment: TossComment | null;
  onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';

export function RepliesSheet({ comment, onClose }: RepliesSheetProps) {
  const [replies, setReplies] = useState<TossComment[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [nextKey, setNextKey] = useState<string | number | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  const commentId = comment?.commentId ?? null;

  useEffect(() => {
    if (commentId == null) return;
    let cancelled = false;

    setReplies([]);
    setHasNext(false);
    setNextKey(null);
    setState('loading');

    (async () => {
      try {
        const page = await fetchTossReplies(commentId);
        if (cancelled) return;
        setReplies(page.results);
        setHasNext(page.hasNext);
        setNextKey(page.key);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [commentId]);

  const handleEndReached = useCallback(async () => {
    if (commentId == null || !hasNext || nextKey == null || loadingMore || state !== 'ready') return;
    setLoadingMore(true);
    try {
      const page = await fetchTossReplies(commentId, nextKey);
      // 본문 목록과 같은 방어 — 서버가 같은 페이지를 다시 줘도 중복 key로 리스트가 깨지지 않게.
      setReplies((prev) => {
        const seen = new Set(prev.map((c) => String(c.commentId)));
        const fresh = page.results.filter((c) => !seen.has(String(c.commentId)));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      setHasNext(page.hasNext && page.key != null && String(page.key) !== String(nextKey));
      setNextKey(page.key);
    } catch {
      // 다음 페이지 실패는 조용히 무시 — 이미 받은 답글은 유지한다.
    } finally {
      setLoadingMore(false);
    }
  }, [commentId, hasNext, nextKey, loadingMore, state]);

  return (
    <BottomSheet visible={comment != null} onClose={onClose} heightRatio={0.8}>
      <View className="flex-1">
        <View className="flex-row items-center justify-between px-5 pb-2 pt-1">
          <Text className="text-[15px] font-bold text-[#191f28]">답글</Text>
          <Text className="text-xs text-[#8b95a1]">{comment ? `${comment.statistic.replyCount}개` : ''}</Text>
        </View>

        {comment && (
          <View className="border-b-[6px] border-[#f2f4f6]">
            <CommentRow comment={comment} asParent />
          </View>
        )}

        {state === 'loading' ? (
          <View>
            {[1, 2, 3].map((i) => (
              <CommentSkeletonRow key={i} />
            ))}
          </View>
        ) : state === 'error' ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="alert-circle-outline" size={36} color="#8b95a1" style={{ marginBottom: 10 }} />
            <Text className="text-sm text-[#8b95a1]">답글을 불러오지 못했어요</Text>
          </View>
        ) : (
          <FlatList
            data={replies}
            keyExtractor={(item) => String(item.commentId)}
            renderItem={({ item }) => <CommentRow comment={item} />}
            contentContainerStyle={{ paddingBottom: 32, flexGrow: 1 }}
            onEndReachedThreshold={0.4}
            onEndReached={handleEndReached}
            ListEmptyComponent={
              <View className="flex-1 items-center justify-center px-8 py-12">
                <Ionicons name="chatbubble-outline" size={36} color="#8b95a1" style={{ marginBottom: 10 }} />
                <Text className="text-sm text-[#8b95a1]">아직 답글이 없어요</Text>
              </View>
            }
            ListFooterComponent={loadingMore ? <ActivityIndicator className="py-4" color="#3182f6" /> : null}
          />
        )}
      </View>
    </BottomSheet>
  );
}
