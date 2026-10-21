import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { and, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import * as schema from "@/core/db/schema";
import { env } from "@/core/env";
import { emit } from "@/core/events/bus";
import { logger } from "@/core/logger";
import {
  fetchUserById,
  getAppToken,
  getBroadcasterId,
  linkAccount,
} from "@/modules/twitch";

const socialProviders = {
  twitch: {
    clientId: env.TWITCH_CLIENT_ID,
    clientSecret: env.TWITCH_CLIENT_SECRET,
  },
  ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {}),
};

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.NEXT_PUBLIC_APP_URL],

  emailAndPassword: { enabled: false },

  socialProviders,

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          // Связка вешается на создание сессии, а не аккаунта: аккаунт
          // создаётся один раз, и пользователи, вошедшие раньше, иначе
          // остались бы без twitch_links навсегда.
          try {
            if (await getBroadcasterId(session.userId)) return;

            const twitchAccount = await db.query.account.findFirst({
              where: and(
                eq(schema.account.userId, session.userId),
                eq(schema.account.providerId, "twitch"),
              ),
            });

            if (!twitchAccount) return;

            const token = await getAppToken();
            const profile = await fetchUserById(token, twitchAccount.accountId);

            await linkAccount({
              userId: session.userId,
              twitchUserId: twitchAccount.accountId,
              login: profile?.login ?? twitchAccount.accountId,
            });

            logger.info(
              { userId: session.userId },
              "аккаунт Twitch связан с профилем",
            );
          } catch (error) {
            logger.error(
              { err: error, userId: session.userId },
              "не удалось связать аккаунт Twitch",
            );
          }
        },
      },
    },

    user: {
      create: {
        after: async (createdUser) => {
          await db
            .insert(schema.profiles)
            .values({
              userId: createdUser.id,
              displayName:
                createdUser.name || `user_${createdUser.id.slice(0, 8)}`,
              avatarUrl: createdUser.image ?? null,
            })
            .onConflictDoNothing();

          logger.info(
            { userId: createdUser.id },
            "Зарегистрирован пользователь",
          );
          await emit("user.registered", { userId: createdUser.id });
        },
      },
    },
  },

  plugins: [nextCookies()],
});

export type Auth = typeof auth;
