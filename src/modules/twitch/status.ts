/**
 * Разбор пейлоадов EventSub. Файл намеренно чистый — без базы, сети и
 * окружения, — чтобы логику маппинга можно было проверять тестами напрямую.
 */

/** Что делает с состоянием эфира конкретное уведомление. */
export type StatusChange =
  | { kind: "online"; startedAt: Date }
  | { kind: "offline" }
  | { kind: "meta"; title: string | null; game: string | null }
  | { kind: "ignored" };

function readString(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toStatusChange(
  subscriptionType: string,
  event: unknown,
): StatusChange {
  switch (subscriptionType) {
    case "stream.online": {
      const startedAtRaw = readString(event, "started_at");
      const parsed = startedAtRaw ? Date.parse(startedAtRaw) : Number.NaN;

      // Без внятного started_at берём текущее время: потерять факт начала
      // эфира хуже, чем показать неточную длительность.
      return {
        kind: "online",
        startedAt: Number.isNaN(parsed) ? new Date() : new Date(parsed),
      };
    }

    case "stream.offline":
      return { kind: "offline" };

    case "channel.update":
      return {
        kind: "meta",
        title: readString(event, "title"),
        game: readString(event, "category_name"),
      };

    default:
      return { kind: "ignored" };
  }
}
