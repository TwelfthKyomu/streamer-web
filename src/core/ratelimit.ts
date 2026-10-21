import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { logger } from "@/core/logger";
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

/**
 * BullMQ требует maxRetriesPerRequest: null, а с ним ioredis не отклоняет
 * команды при недоступном Redis, а копит их в очереди — то есть проверка
 * лимита не упадёт, а зависнет вместе с запросом пользователя. Поэтому
 * ограничиваем ожидание сами.
 */
const limiterTimeoutMs = 1000;

class LimiterTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new LimiterTimeout("лимитер не ответил вовремя")),
        limiterTimeoutMs,
      ),
    ),
  ]);
}

export async function consume(
  name: RateLimiterName,
  key: string,
): Promise<RateLimitResult> {
  try {
    await withTimeout(rateLimiters[name].consume(key));
    return { allowed: true };
  } catch (rejection) {
    // Библиотека отвергает промис в двух совершенно разных случаях: лимит
    // исчерпан (RateLimiterRes) и хранилище недоступно (Error). Раньше оба
    // считались превышением, и при упавшем Redis пользователь видел
    // "слишком много запросов" вместо честной ошибки — а заодно сайт
    // блокировал сам себя целиком.
    if (rejection instanceof RateLimiterRes) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(rejection.msBeforeNext / 1000),
      };
    }

    logger.error(
      { err: rejection, limiter: name },
      "лимитер недоступен, пропускаем запрос без ограничения",
    );

    return { allowed: true };
  }
}
