// 토스 커뮤니티 댓글/답글 공용 행 — 목록(CommentsPanel)과 답글 시트(RepliesSheet)가 같은 모양을 쓴다.
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatTossMessage, type TossComment, type TossCommentExecution } from '../../../lib/tossCommunity';

/** 뱃지 색 키 → 연한 배경 pill 톤(토스 토큰 계열). 알 수 없는 키는 중립 회색으로 안전하게 처리한다. */
const BADGE_COLOR: Record<string, { bg: string; fg: string }> = {
  yellow: { bg: '#fff6e0', fg: '#ffb331' },
  blue: { bg: '#eaf2ff', fg: '#3182f6' },
  green: { bg: '#e6f4ea', fg: '#03b26c' },
};
const DEFAULT_BADGE_COLOR = { bg: '#f7f9fc', fg: '#8b95a1' };

/** 본문 미리보기 상한(대략 6줄 분량의 문자 수 휴리스틱) — RN onTextLayout은 numberOfLines로 잘린 뒤 실측이라 넘침 여부를 신뢰성 있게 못 잡는다. */
const PREVIEW_CHAR_LIMIT = 220;

export function formatRelativeTime(iso: string): string {
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

/** "8월 29일 02:37" — 매매 공유 카드의 체결 시각(응답은 KST 벽시계 문자열). */
function formatExecutedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  return `${Number(m[2])}월 ${Number(m[3])}일 ${m[4]}:${m[5]}`;
}

/** 매매 공유 카드 — 토스 앱의 "[구매] SK하이닉스 1주 / 1주당 1,654,000원 8월 28일 19:12" 문법. */
function ExecutionCard({ execution }: { execution: TossCommentExecution }) {
  const buy = execution.orderSide === 'BUY';
  const price = execution.averageExecutionPriceKrw ?? null;
  const priceText = price !== null ? `1주당 ${Math.round(price).toLocaleString('ko-KR')}원` : execution.averageExecutionPriceUsd != null ? `1주당 ${execution.averageExecutionPriceUsd}` : '';
  const profit = execution.profitAmountKrw;
  const rate = execution.profitRateKrw;
  return (
    <View className="mt-2 rounded-xl px-3 py-2.5" style={{ backgroundColor: '#f7f9fc', borderWidth: 1, borderColor: '#e5e8eb' }}>
      <View className="flex-row items-center" style={{ gap: 6 }}>
        <View className="rounded px-1.5 py-0.5" style={{ backgroundColor: buy ? '#fdecee' : '#eaf2ff' }}>
          <Text className="text-[11px] font-bold" style={{ color: buy ? '#f04452' : '#3182f6' }}>
            {buy ? '구매' : '판매'}
          </Text>
        </View>
        <Text className="text-sm font-bold text-[#191f28]">
          {execution.stockName ?? ''} {execution.quantity}주
        </Text>
      </View>
      <Text className="mt-1 text-xs text-[#4e5968]">
        {priceText}
        {priceText ? '  ' : ''}
        <Text className="text-[#8b95a1]">{formatExecutedAt(execution.executedAt)}</Text>
      </Text>
      {!buy && profit != null && (
        <Text className="mt-0.5 text-xs font-semibold" style={{ color: profit > 0 ? '#f04452' : profit < 0 ? '#3182f6' : '#8b95a1' }}>
          {`${profit > 0 ? '+' : ''}${Math.round(profit).toLocaleString('ko-KR')}원${rate != null ? ` (${rate > 0 ? '+' : ''}${rate.toFixed(2)}%)` : ''}`}
        </Text>
      )}
    </View>
  );
}

export interface CommentRowProps {
  comment: TossComment;
  /** 누르면 답글 시트를 연다. 답글 시트 안에서는(=이미 상세) 넘기지 않는다. */
  onPress?: () => void;
  /** 답글 시트 맨 위 원문 — 항상 펼쳐 보여주고 구분선을 생략한다. */
  asParent?: boolean;
}

export function CommentRow({ comment, onPress, asParent = false }: CommentRowProps) {
  const [expanded, setExpanded] = useState(asParent);
  const message = formatTossMessage(comment.message.message ?? '');
  const truncated = !expanded && message.length > PREVIEW_CHAR_LIMIT;
  const badge = comment.author.badge;
  const badgeColor = badge ? (BADGE_COLOR[badge.color] ?? DEFAULT_BADGE_COLOR) : null;
  const replyCount = comment.statistic.replyCount;

  const body = (
    <>
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

      {/* 첨부 이미지 — 가로 꽉 채우고 비율(pictureRatio)대로. 여러 장이면 세로로. */}
      {(comment.media ?? [])
        .filter((m) => m.type === 'image' && m.url)
        .map((m, i) => (
          <Image
            key={`${m.url}-${i}`}
            source={{ uri: m.url }}
            resizeMode="cover"
            style={{ width: '100%', aspectRatio: m.pictureRatio && m.pictureRatio > 0 ? m.pictureRatio : 1.5, borderRadius: 12, marginTop: 8, backgroundColor: '#f2f4f6' }}
          />
        ))}

      {/* 매매 공유 카드 */}
      {comment.execution ? <ExecutionCard execution={comment.execution} /> : null}

      {/* 리포스트 원문 인용 */}
      {comment.repostComment?.message && (comment.repostComment.message.title || comment.repostComment.message.message) ? (
        <View className="mt-2 rounded-xl px-3 py-2.5" style={{ backgroundColor: '#f7f9fc', borderLeftWidth: 3, borderLeftColor: '#d1d6db' }}>
          {comment.repostComment.author?.nickname ? <Text className="text-xs font-semibold text-[#4e5968]">{comment.repostComment.author.nickname}</Text> : null}
          {comment.repostComment.message.title ? <Text className="mt-0.5 text-sm font-bold text-[#191f28]">{comment.repostComment.message.title}</Text> : null}
          {comment.repostComment.message.message ? (
            <Text className="mt-0.5 text-sm leading-5 text-[#4e5968]" numberOfLines={expanded ? undefined : 4}>
              {formatTossMessage(comment.repostComment.message.message)}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* 투표 — 항목과 득표수만 보여준다(투표는 토스 앱에서). */}
      {comment.vote && comment.vote.options?.length ? (
        <View className="mt-2 rounded-xl px-3 py-2" style={{ backgroundColor: '#f7f9fc', gap: 4 }}>
          {comment.vote.options.map((o) => {
            const pct = comment.vote!.votedCount > 0 ? Math.round((o.votedCount / comment.vote!.votedCount) * 100) : 0;
            return (
              <View key={String(o.id)} className="flex-row items-center justify-between">
                <Text className="flex-1 text-xs text-[#4e5968]" numberOfLines={1}>
                  {o.context}
                </Text>
                <Text className="ml-2 text-xs font-semibold text-[#191f28]">{pct}%</Text>
              </View>
            );
          })}
          <Text className="text-[11px] text-[#8b95a1]">{comment.vote.votedCount}명 참여</Text>
        </View>
      ) : null}

      <View className="mt-2 flex-row items-center" style={{ gap: 12 }}>
        <View className="flex-row items-center" style={{ gap: 3 }}>
          <Ionicons name="heart-outline" size={13} color="#8b95a1" />
          <Text className="text-xs text-[#8b95a1]">{comment.statistic.likeCount}</Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 3 }}>
          <Ionicons name="chatbubble-outline" size={13} color={replyCount > 0 && onPress ? '#3182f6' : '#8b95a1'} />
          <Text className={`text-xs ${replyCount > 0 && onPress ? 'font-semibold text-[#3182f6]' : 'text-[#8b95a1]'}`}>
            {replyCount > 0 && onPress ? `답글 ${replyCount}개` : replyCount}
          </Text>
        </View>
      </View>
    </>
  );

  if (!onPress) {
    return <View className={asParent ? 'px-5 py-4' : 'border-b border-[#f2f4f6] px-5 py-4'}>{body}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      className="border-b border-[#f2f4f6] px-5 py-4"
      android_ripple={{ color: '#f2f4f6' }}
      style={({ pressed }) => (pressed ? { backgroundColor: '#f7f9fc' } : null)}
      accessibilityRole="button"
      accessibilityLabel={`${comment.author.nickname}의 댓글, 답글 ${replyCount}개`}
    >
      {body}
    </Pressable>
  );
}

export function CommentSkeletonRow() {
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
