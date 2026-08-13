import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export type AchievementCondition = {
  event: string;
  type: "count" | "streak" | "unique_days";
  threshold: number;

  window?: string;
};

export const achievements = pgTable("achievements", {
  code: text().primaryKey(),
  title: text().notNull(),
  description: text().notNull(),
  icon: text().notNull(),
  condition: jsonb().$type<AchievementCondition>().notNull(),

  hidden: boolean().notNull().default(false),
  enabled: boolean().notNull().default(true),
});

export const userAchievements = pgTable(
  "user_achievements",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    achievementCode: text()
      .notNull()
      .references(() => achievements.code, { onDelete: "cascade" }),
    unlockedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.achievementCode] }),
    index("user_achievements_recent_idx").on(t.unlockedAt.desc()),
  ],
);
