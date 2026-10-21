import { asc, count, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { media, moderationActions, posts, profiles } from "@/core/db/schema";
import { emit } from "@/core/events/bus";
import { publicUrl } from "@/core/storage/s3";

export type PendingPost = {
  id: string;
  caption: string | null;
  createdAt: Date;
  author: { id: string; displayName: string; avatarUrl: string | null };
  media: {
    kind: "image" | "video";
    url: string;
    hls: string | null;
    poster: string | null;
  };
};

export async function pendingCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posts)
    .where(eq(posts.status, "pending"));
  return row?.value ?? 0;
}

export async function listPending(limit = 50): Promise<PendingPost[]> {
  const rows = await db
    .select({
      id: posts.id,
      caption: posts.caption,
      createdAt: posts.createdAt,
      authorId: profiles.userId,
      authorName: profiles.displayName,
      authorAvatar: profiles.avatarUrl,
      mediaKind: media.kind,
      mediaKey: media.storageKey,
      mediaVariants: media.variants,
    })
    .from(posts)
    .innerJoin(profiles, eq(posts.authorId, profiles.userId))
    .innerJoin(media, eq(posts.mediaId, media.id))
    .where(eq(posts.status, "pending"))
    .orderBy(asc(posts.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    caption: row.caption,
    createdAt: row.createdAt,
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
    },
  }));
}

export type DecisionOutcome =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "already_decided" };

export async function decide(params: {
  postId: string;
  moderatorId: string;
  approve: boolean;
  reason?: string;
}): Promise<DecisionOutcome> {
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, params.postId),
  });

  if (!post) return { status: "not_found" };
  if (post.status !== "pending") return { status: "already_decided" };

  await db.transaction(async (tx) => {
    await tx
      .update(posts)
      .set({
        status: params.approve ? "approved" : "rejected",
        publishedAt: params.approve ? new Date() : null,
      })
      .where(eq(posts.id, params.postId));

    await tx.insert(moderationActions).values({
      moderatorId: params.moderatorId,
      targetType: "post",
      targetId: params.postId,
      action: params.approve ? "approve" : "reject",
      reason: params.reason ?? null,
    });
  });

  await emit(params.approve ? "post.approved" : "post.rejected", {
    postId: params.postId,
    authorId: post.authorId,
    moderatorId: params.moderatorId,
  });

  return { status: "ok" };
}
