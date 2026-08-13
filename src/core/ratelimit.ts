import { RateLimiterRedis } from "rate-limiter-flexible";
import { redis } from "@/core/redis";

function limiter(keyPrefix: string, points: number, durationSeconds: number) {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix,
    points,
    duration: durationSeconds,
  });
}

export const rateLimiters = {
  upload: limiter("rl:upload", 10, 3600),

  soundboard: limiter("rl:sound", 20, 600),

  comment: limiter("rl:comment", 30, 600),

  like: limiter("rl:like", 120, 60),

  report: limiter("rl:report", 20, 3600),
} as const;

export type RateLimiterName = keyof typeof rateLimiters;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export async function consume(
  name: RateLimiterName,
  key: string,
): Promise<RateLimitResult> {
  try {
    await rateLimiters[name].consume(key);
    return { allowed: true };
  } catch (rejection) {
    const msBeforeNext =
      typeof rejection === "object" &&
      rejection !== null &&
      "msBeforeNext" in rejection &&
      typeof rejection.msBeforeNext === "number"
        ? rejection.msBeforeNext
        : 60_000;

    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(msBeforeNext / 1000),
    };
  }
}
