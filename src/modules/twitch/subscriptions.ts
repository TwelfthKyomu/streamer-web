import { env } from "@/core/env";

const helix = "https://api.twitch.tv/helix";
const idApi = "https://id.twitch.tv/oauth2";

/** Типы, на которые подписывается сайт. Больше пока не нужно. */
export const watchedTypes = [
  "stream.online",
  "stream.offline",
  "channel.update",
] as const;

export type WatchedType = (typeof watchedTypes)[number];

export type Subscription = {
  id: string;
  type: string;
  status: string;
  condition: Record<string, string>;
  transport: { method: string; callback?: string };
  created_at: string;
};

export function callbackUrl(): string {
  return (
    env.TWITCH_EVENTSUB_CALLBACK_URL ??
    `${env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`
  );
}

/**
 * App access token: подписками управляет приложение, а не пользователь,
 * поэтому здесь client_credentials, а не токен вошедшего стримера.
 */
export async function getAppToken(): Promise<string> {
  const response = await fetch(`${idApi}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(`Twitch не выдал app token: ${JSON.stringify(body)}`);
  }

  const token =
    typeof body === "object" && body !== null && "access_token" in body
      ? body.access_token
      : null;

  if (typeof token !== "string") {
    throw new Error("В ответе Twitch нет access_token");
  }

  return token;
}

async function helixRequest(
  path: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...rest } = init;

  return fetch(`${helix}${path}`, {
    ...rest,
    headers: {
      ...rest.headers,
      Authorization: `Bearer ${token}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
    },
  });
}

export async function listSubscriptions(
  token: string,
): Promise<Subscription[]> {
  const response = await helixRequest("/eventsub/subscriptions", {
    method: "GET",
    token,
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(`Не удалось получить подписки: ${JSON.stringify(body)}`);
  }

  return typeof body === "object" && body !== null && "data" in body
    ? (body.data as Subscription[])
    : [];
}

export async function createSubscription(params: {
  token: string;
  type: WatchedType;
  broadcasterUserId: string;
}): Promise<Subscription> {
  const response = await helixRequest("/eventsub/subscriptions", {
    method: "POST",
    token: params.token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: params.type,
      // Версия 2 только у channel.update, остальные типы живут на 1.
      version: params.type === "channel.update" ? "2" : "1",
      condition: { broadcaster_user_id: params.broadcasterUserId },
      transport: {
        method: "webhook",
        callback: callbackUrl(),
        secret: env.TWITCH_EVENTSUB_SECRET,
      },
    }),
  });

  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(
      `Не удалось создать подписку ${params.type}: ${JSON.stringify(body)}`,
    );
  }

  const created =
    typeof body === "object" && body !== null && "data" in body
      ? (body.data as Subscription[])[0]
      : undefined;

  if (!created) throw new Error("Twitch не вернул созданную подписку");

  return created;
}

export async function deleteSubscription(
  token: string,
  id: string,
): Promise<void> {
  const response = await helixRequest(
    `/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
    { method: "DELETE", token },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Не удалось удалить подписку ${id}: ${await response.text()}`,
    );
  }
}

export type TwitchUser = { id: string; login: string; displayName: string };

export async function fetchUserById(
  token: string,
  twitchUserId: string,
): Promise<TwitchUser | null> {
  const response = await helixRequest(
    `/users?id=${encodeURIComponent(twitchUserId)}`,
    { method: "GET", token },
  );

  if (!response.ok) return null;

  const body: unknown = await response.json();
  const entry =
    typeof body === "object" && body !== null && "data" in body
      ? (body.data as Array<Record<string, unknown>>)[0]
      : undefined;

  if (!entry) return null;

  const id = typeof entry.id === "string" ? entry.id : null;
  const login = typeof entry.login === "string" ? entry.login : null;
  if (!id || !login) return null;

  return {
    id,
    login,
    displayName:
      typeof entry.display_name === "string" ? entry.display_name : login,
  };
}
