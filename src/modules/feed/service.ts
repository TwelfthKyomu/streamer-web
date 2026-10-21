import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { media, postLikes, posts, profiles } from "@/core/db/schema";
import { emit } from "@/core/events/bus";
import { consume } from "@/core/ratelimit";
import { publicUrl } from "@/core/storage/s3";

export type FeedPost = {
  id: string;
  caption: string | null;
  likeCount: number;
  commentCount: number;
  publishedAt: Date | null;
  likedByMe: boolean;
  author: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  };
  media: {
    kind: "image" | "video";
    url: string;
    /** master.m3u8 от ffmpeg-воркера; пока видео не обработано — null. */
    hls: string | null;
    poster: string | null;
    width: number | null;
    height: number | null;
  };
};

export type FeedPage = {
  items: FeedPost[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 12;

function encodeCursor(publishedAt: Date, id: string): string {
  return Buffer.from(`${publishedAt.toISOString()}|${id}`).toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string,
): { publishedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = raw.lastIndexOf("|");
    if (separator === -1) return null;

    const publishedAt = new Date(raw.slice(0, separator));
    const id = raw.slice(separator + 1);
    if (Number.isNaN(publishedAt.getTime()) || !id) return null;

    return { publishedAt, id };
  } catch {
    return null;
  }
}

export async function listFeed(params: {
  viewerId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<FeedPage> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;

  const rows = await db
    .select({
      id: posts.id,
      caption: posts.caption,
      likeCount: posts.likeCount,
      commentCount: posts.commentCount,
      publishedAt: posts.publishedAt,
      authorId: profiles.userId,
      authorName: profiles.displayName,
      authorAvatar: profiles.avatarUrl,
      mediaKind: media.kind,
      mediaKey: media.storageKey,
      mediaVariants: media.variants,
      mediaWidth: media.width,
      mediaHeight: media.height,
      likedByMe: params.viewerId
        ? sql<boolean>`exists (
            select 1 from ${postLikes}
            where ${postLikes.postId} = ${posts.id}
              and ${postLikes.userId} = ${params.viewerId}
          )`
        : sql<boolean>`false`,
    })
    .from(posts)
    .innerJoin(profiles, eq(posts.authorId, profiles.userId))
    .innerJoin(media, eq(posts.mediaId, media.id))
    .where(
      and(
        eq(posts.status, "approved"),
        cursor
          ? // Дату передаём строкой с явным приведением: в кортежном
            // сравнении Postgres не может вывести тип параметра сам, а
            // драйвер не умеет сериализовать Date в такой позиции.
            sql`(${posts.publishedAt}, ${posts.id}) < (${cursor.publishedAt.toISOString()}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(posts.publishedAt), desc(posts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => ({
      id: row.id,
      caption: row.caption,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      publishedAt: row.publishedAt,
      likedByMe: row.likedByMe,
      author: {
        id: row.authorId,
        displayName: row.authorName,
        avatarUrl: row.authorAvatar,
      },
      media: {
        kind: row.mediaKind,
        url: row.mediaVariants.mp4_720
          ? publicUrl(row.mediaVariants.mp4_720)
          : publicUrl(row.mediaKey),
        hls: row.mediaVariants.hls ? publicUrl(row.mediaVariants.hls) : null,
        poster: row.mediaVariants.poster
          ? publicUrl(row.mediaVariants.poster)
          : null,
        width: row.mediaWidth,
        height: row.mediaHeight,
      },
    })),
    nextCursor:
      hasMore && last?.publishedAt
        ? encodeCursor(last.publishedAt, last.id)
        : null,
  };
}

export type LikeOutcome =
  | { status: "ok"; liked: boolean; likeCount: number }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "not_found" };

export async function toggleLike(params: {
  postId: string;
  userId: string;
}): Promise<LikeOutcome> {
  const limited = await consume("like", params.userId);
  if (!limited.allowed) {
    return {
      status: "rate_limited",
      retryAfterSeconds: limited.retryAfterSeconds,
    };
  }

  const post = await db.query.posts.findFirst({
    where: and(eq(posts.id, params.postId), eq(posts.status, "approved")),
  });

  if (!post) return { status: "not_found" };

  const result = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(postLikes)
      .where(
        and(
          eq(postLikes.postId, params.postId),
          eq(postLikes.userId, params.userId),
        ),
      )
      .returning({ postId: postLikes.postId });

    const liked = deleted.length === 0;

    if (liked) {
      await tx
        .insert(postLikes)
        .values({ postId: params.postId, userId: params.userId });
    }

    const [updated] = await tx
      .update(posts)
      .set({
        likeCount: sql`${posts.likeCount} + ${liked ? 1 : -1}`,
      })
      .where(eq(posts.id, params.postId))
      .returning({ likeCount: posts.likeCount });

    return { liked, likeCount: updated?.likeCount ?? post.likeCount };
  });

  if (result.liked) {
    await emit("post.liked", {
      postId: params.postId,
      authorId: post.authorId,
      likedBy: params.userId,
    });
  } else {
    await emit("post.unliked", {
      postId: params.postId,
      authorId: post.authorId,
      unlikedBy: params.userId,
    });
  }

  return { status: "ok", liked: result.liked, likeCount: result.likeCount };
}

export async function listByAuthor(authorId: string, limit = 24) {
  return db
    .select({
      id: posts.id,
      caption: posts.caption,
      likeCount: posts.likeCount,
      publishedAt: posts.publishedAt,
      mediaKind: media.kind,
      mediaKey: media.storageKey,
      mediaVariants: media.variants,
    })
    .from(posts)
    .innerJoin(media, eq(posts.mediaId, media.id))
    .where(and(eq(posts.authorId, authorId), eq(posts.status, "approved")))
    .orderBy(desc(posts.publishedAt))
    .limit(limit);
}
