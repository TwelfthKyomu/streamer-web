import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { pointRules, pointTransactions, profiles } from "@/core/db/schema";

export type AwardOutcome =
  | { status: "awarded"; amount: number; balance: number }
  | { status: "skipped"; reason: SkipReason };

export type SkipReason =
  | "no_rule"
  | "disabled"
  | "cooldown"
  | "daily_cap"
  | "duplicate";

export type SpendOutcome =
  | { status: "spent"; balance: number; transactionId: number }
  | { status: "insufficient"; balance: number }
  | { status: "duplicate" };

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION
  );
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export async function award(params: {
  userId: string;
  eventType: string;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
}): Promise<AwardOutcome> {
  const rule = await db.query.pointRules.findFirst({
    where: eq(pointRules.eventType, params.eventType),
  });

  if (!rule) return { status: "skipped", reason: "no_rule" };
  if (!rule.enabled) return { status: "skipped", reason: "disabled" };

  if (rule.cooldownSeconds > 0) {
    const last = await db.query.pointTransactions.findFirst({
      where: and(
        eq(pointTransactions.userId, params.userId),
        eq(pointTransactions.reason, params.eventType),
      ),
      orderBy: [desc(pointTransactions.createdAt)],
    });

    if (last) {
      const elapsedMs = Date.now() - last.createdAt.getTime();
      if (elapsedMs < rule.cooldownSeconds * 1000) {
        return { status: "skipped", reason: "cooldown" };
      }
    }
  }

  if (rule.dailyCap !== null) {
    const [today] = await db
      .select({
        total: sql<number>`coalesce(sum(${pointTransactions.amount}), 0)::int`,
      })
      .from(pointTransactions)
      .where(
        and(
          eq(pointTransactions.userId, params.userId),
          eq(pointTransactions.reason, params.eventType),
          gte(pointTransactions.createdAt, startOfToday()),
        ),
      );

    if ((today?.total ?? 0) + rule.amount > rule.dailyCap) {
      return { status: "skipped", reason: "daily_cap" };
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(profiles)
        .set({
          pointsBalance: sql`${profiles.pointsBalance} + ${rule.amount}`,
        })
        .where(eq(profiles.userId, params.userId))
        .returning({ balance: profiles.pointsBalance });

      if (!updated) {
        throw new Error(`profile not found: ${params.userId}`);
      }

      await tx.insert(pointTransactions).values({
        userId: params.userId,
        amount: rule.amount,
        reason: params.eventType,
        refType: params.refType ?? null,
        refId: params.refId ?? null,
        idempotencyKey: params.idempotencyKey,
        balanceAfter: updated.balance,
      });

      return {
        status: "awarded" as const,
        amount: rule.amount,
        balance: updated.balance,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      return { status: "skipped", reason: "duplicate" };
    throw error;
  }
}

export async function spend(params: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
}): Promise<SpendOutcome> {
  if (params.amount <= 0) {
    throw new Error("spend amount must be positive");
  }

  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(profiles)
        .set({
          pointsBalance: sql`${profiles.pointsBalance} - ${params.amount}`,
        })
        .where(
          and(
            eq(profiles.userId, params.userId),
            gte(profiles.pointsBalance, params.amount),
          ),
        )
        .returning({ balance: profiles.pointsBalance });

      if (!updated) {
        const current = await tx.query.profiles.findFirst({
          where: eq(profiles.userId, params.userId),
        });
        return {
          status: "insufficient" as const,
          balance: current?.pointsBalance ?? 0,
        };
      }

      const [inserted] = await tx
        .insert(pointTransactions)
        .values({
          userId: params.userId,
          amount: -params.amount,
          reason: params.reason,
          refType: params.refType ?? null,
          refId: params.refId ?? null,
          idempotencyKey: params.idempotencyKey,
          balanceAfter: updated.balance,
        })
        .returning({ id: pointTransactions.id });

      if (!inserted) throw new Error("ledger insert returned no row");

      return {
        status: "spent" as const,
        balance: updated.balance,
        transactionId: inserted.id,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "duplicate" };
    throw error;
  }
}

export async function refund(params: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
}): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(profiles)
        .set({
          pointsBalance: sql`${profiles.pointsBalance} + ${params.amount}`,
        })
        .where(eq(profiles.userId, params.userId))
        .returning({ balance: profiles.pointsBalance });

      if (!updated) throw new Error(`profile not found: ${params.userId}`);

      await tx.insert(pointTransactions).values({
        userId: params.userId,
        amount: params.amount,
        reason: params.reason,
        refType: params.refType ?? null,
        refId: params.refId ?? null,
        idempotencyKey: params.idempotencyKey,
        balanceAfter: updated.balance,
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

export async function history(userId: string, limit = 50) {
  return db.query.pointTransactions.findMany({
    where: eq(pointTransactions.userId, userId),
    orderBy: [desc(pointTransactions.createdAt)],
    limit,
  });
}

export async function leaderboard(limit = 50) {
  return db
    .select({
      userId: profiles.userId,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      pointsBalance: profiles.pointsBalance,
    })
    .from(profiles)
    .where(eq(profiles.shadowBanned, false))
    .orderBy(desc(profiles.pointsBalance))
    .limit(limit);
}
