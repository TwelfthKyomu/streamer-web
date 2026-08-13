import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const twitchLinks = pgTable(
  "twitch_links",
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    twitchUserId: text().notNull().unique(),
    login: text().notNull(),
    isSubscriber: boolean().notNull().default(false),

    subTier: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("twitch_links_login_idx").on(t.login)],
);

export const twitchEvents = pgTable(
  "twitch_events",
  {
    messageId: text().primaryKey(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("twitch_events_type_idx").on(t.type, t.receivedAt.desc())],
);

export const streamStatus = pgTable("stream_status", {
  id: integer().primaryKey().default(1),
  isLive: boolean().notNull().default(false),
  title: text(),
  game: text(),
  startedAt: timestamp({ withTimezone: true }),
  viewerCount: integer(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
