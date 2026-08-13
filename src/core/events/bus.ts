import { logger } from "@/core/logger";
import type {
  DomainEvent,
  DomainEventName,
  DomainEvents,
  EventHandler,
} from "./types";

const handlers = new Map<DomainEventName, Set<EventHandler<never>>>();

export function on<K extends DomainEventName>(
  name: K,
  handler: EventHandler<K>,
): () => void {
  const existing = handlers.get(name) ?? new Set<EventHandler<never>>();
  existing.add(handler as EventHandler<never>);
  handlers.set(name, existing);

  return () => {
    existing.delete(handler as EventHandler<never>);
  };
}

export async function emit<K extends DomainEventName>(
  name: K,
  payload: DomainEvents[K],
): Promise<void> {
  const subscribers = handlers.get(name);
  if (!subscribers || subscribers.size === 0) return;

  const event: DomainEvent<K> = { name, payload, occurredAt: new Date() };

  const results = await Promise.allSettled(
    [...subscribers].map(async (handler) => {
      await (handler as EventHandler<K>)(event);
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      logger.error({ event: name, err: result.reason }, "event handler failed");
    }
  }
}

export function resetHandlers(): void {
  handlers.clear();
}
