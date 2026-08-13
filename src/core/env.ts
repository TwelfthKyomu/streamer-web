import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),

    TWITCH_CLIENT_ID: z.string().min(1),
    TWITCH_CLIENT_SECRET: z.string().min(1),
    TWITCH_EVENTSUB_SECRET: z.string().min(10).max(100),

    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    VK_CLIENT_ID: z.string().optional(),
    VK_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_PUBLIC_URL: z.url(),

    CENTRIFUGO_API_URL: z.url(),
    CENTRIFUGO_API_KEY: z.string().min(1),
    CENTRIFUGO_TOKEN_HMAC_SECRET: z.string().min(1),

    MAX_VIDEO_DURATION_SEC: z.coerce.number().int().positive().default(60),
    MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(100),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.url(),
    NEXT_PUBLIC_CENTRIFUGO_WS_URL: z.string().min(1),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CENTRIFUGO_WS_URL: process.env.NEXT_PUBLIC_CENTRIFUGO_WS_URL,
  },
  emptyStringAsUndefined: true,
});
