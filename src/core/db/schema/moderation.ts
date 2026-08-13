import {
  bigserial,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/core/id";
import { user } from "./auth";

export const reportTargetType = pgEnum("report_target_type", [
  "post",
  "comment",
  "user",
]);
export const reportStatus = pgEnum("report_status", [
  "open",
  "resolved",
  "rejected",
]);

export const reports = pgTable(
  "reports",
  {
    id: uuid().primaryKey().$defaultFn(newId),
    reporterId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetType: reportTargetType().notNull(),
    targetId: text().notNull(),
    reason: text().notNull(),
    status: reportStatus().notNull().default("open"),
    resolvedBy: text().references(() => user.id, { onDelete: "set null" }),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reports_queue_idx").on(t.status, t.createdAt),
    index("reports_target_idx").on(t.targetType, t.targetId),
  ],
);

export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    moderatorId: text()
      .notNull()
      .references(() => user.id, { onDelete: "set null" }),
    targetType: reportTargetType().notNull(),
    targetId: text().notNull(),

    action: text().notNull(),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("moderation_actions_target_idx").on(t.targetType, t.targetId),
    index("moderation_actions_moderator_idx").on(
      t.moderatorId,
      t.createdAt.desc(),
    ),
  ],
);
