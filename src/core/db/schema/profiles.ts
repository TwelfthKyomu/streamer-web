import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const userRole = pgEnum("user_role", ["user", "moderator", "admin"]);

export const profiles = pgTable(
  "profiles",
  {
    userId: text()
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text().notNull(),
    avatarUrl: text(),
    bio: text(),
    role: userRole().notNull().default("user"),

    pointsBalance: integer().notNull().default(0),

    bannedUntil: timestamp({ withTimezone: true }),

    shadowBanned: boolean().notNull().default(false),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("profiles_leaderboard_idx").on(t.pointsBalance.desc())],
);
