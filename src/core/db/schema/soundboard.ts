import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/core/id";
import { user } from "./auth";
import { pointTransactions } from "./points";

export const sounds = pgTable(
  "sounds",
  {
    id: uuid().primaryKey().$defaultFn(newId),
    name: text().notNull(),
    storageKey: text().notNull(),
    durationMs: integer().notNull(),

    cost: integer().notNull().default(0),

    cooldownSeconds: integer().notNull().default(30),

    enabled: boolean().notNull().default(true),
    addedBy: text().references(() => user.id, { onDelete: "set null" }),

    isNormalized: boolean().notNull().default(false),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sounds_enabled_idx").on(t.enabled, t.name)],
);

export const soundPlays = pgTable(
  "sound_plays",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    soundId: uuid()
      .notNull()
      .references(() => sounds.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    transactionId: bigint({ mode: "number" }).references(
      () => pointTransactions.id,
      { onDelete: "set null" },
    ),
    playedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sound_plays_sound_idx").on(t.soundId, t.playedAt.desc()),
    index("sound_plays_user_idx").on(t.userId, t.playedAt.desc()),
  ],
);

export const overlayTokens = pgTable(
  "overlay_tokens",
  {
    id: uuid().primaryKey().$defaultFn(newId),
    streamerUserId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),

    scopes: text().array().notNull().default([]),
    lastSeenAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("overlay_tokens_streamer_idx").on(t.streamerUserId)],
);
