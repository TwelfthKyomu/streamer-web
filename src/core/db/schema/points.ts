import {
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const pointTransactions = pgTable(
  "point_transactions",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    amount: integer().notNull(),

    reason: text().notNull(),

    refType: text(),
    refId: text(),

    idempotencyKey: text().notNull(),

    balanceAfter: integer().notNull(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("point_tx_idempotency_idx").on(t.idempotencyKey),
    index("point_tx_user_idx").on(t.userId, t.createdAt.desc()),

    index("point_tx_daily_cap_idx").on(t.userId, t.reason, t.createdAt),
  ],
);

export const pointRules = pgTable("point_rules", {
  eventType: text().primaryKey(),
  amount: integer().notNull(),

  dailyCap: integer(),
  cooldownSeconds: integer().notNull().default(0),
  enabled: boolean().notNull().default(true),
  description: text(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
