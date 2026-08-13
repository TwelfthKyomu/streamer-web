import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { db } from "@/core/db/client";
import { profiles } from "@/core/db/schema";
import { auth } from "./server";

export type CurrentUser = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
  pointsBalance: number;
  isBanned: boolean;
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.userId, session.user.id),
  });
  if (!profile) return null;

  return {
    id: profile.userId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    role: profile.role,
    pointsBalance: profile.pointsBalance,
    isBanned: profile.bannedUntil !== null && profile.bannedUntil > new Date(),
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  if (user.isBanned) throw new BannedError();
  return user;
}

export async function requireModerator(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "moderator" && user.role !== "admin") {
    throw new ForbiddenError();
  }
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Требуется вход");
    this.name = "UnauthorizedError";
  }
}

export class BannedError extends Error {
  constructor() {
    super("Доступ ограничен");
    this.name = "BannedError";
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super("Недостаточно прав");
    this.name = "ForbiddenError";
  }
}
