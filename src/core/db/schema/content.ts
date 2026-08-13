import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/core/id";
import { user } from "./auth";

export const mediaKind = pgEnum("media_kind", ["image", "video"]);
export const mediaProcessingStatus = pgEnum("media_processing_status", [
  "uploaded",
  "processing",
  "ready",
  "failed",
]);
export const postStatus = pgEnum("post_status", [
  "pending",
  "approved",
  "rejected",
  "removed",
]);
export const commentStatus = pgEnum("comment_status", ["visible", "removed"]);

export type MediaVariants = {
  hls?: string;
  mp4_720?: string;
  mp4_480?: string;
  poster?: string;
};

export const media = pgTable(
  "media",
  {
    id: uuid().primaryKey().$defaultFn(newId),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: mediaKind().notNull(),
    storageKey: text().notNull(),
    mime: text().notNull(),
    sizeBytes: integer().notNull(),
    width: integer(),
    height: integer(),
    durationMs: integer(),

    checksum: text().notNull(),

    variants: jsonb().$type<MediaVariants>().notNull().default({}),
    processingStatus: mediaProcessingStatus().notNull().default("uploaded"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("media_checksum_idx").on(t.checksum),
    index("media_owner_idx").on(t.ownerId, t.createdAt.desc()),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid().primaryKey().$defaultFn(newId),
    authorId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mediaId: uuid()
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    caption: text(),
    status: postStatus().notNull().default("pending"),

    likeCount: integer().notNull().default(0),
    commentCount: integer().notNull().default(0),

    publishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posts_feed_idx").on(t.status, t.publishedAt.desc(), t.id.desc()),
    index("posts_author_idx").on(t.authorId, t.createdAt.desc()),

    index("posts_moderation_queue_idx")
      .on(t.createdAt)
      .where(sql`status = 'pending'`),
  ],
);

export const postLikes = pgTable(
  "post_likes",
  {
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.userId] }),
    index("post_likes_user_idx").on(t.userId, t.createdAt.desc()),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid().primaryKey().$defaultFn(newId),
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    parentId: uuid().references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    body: text().notNull(),
    status: commentStatus().notNull().default("visible"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_post_idx").on(t.postId, t.createdAt)],
);
