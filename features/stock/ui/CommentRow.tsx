// 토스 커뮤니티 댓글/답글 공용 행 — 목록(CommentsPanel)과 답글 시트(RepliesSheet)가 같은 모양을 쓴다.
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatTossMessage, type TossComment } from '../../../lib/tossCommunity';

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
