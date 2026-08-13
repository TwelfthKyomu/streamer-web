import { SignJWT } from "jose";
import { env } from "@/core/env";

const secret = new TextEncoder().encode(env.CENTRIFUGO_TOKEN_HMAC_SECRET);

export const channels = {
  overlay: (streamerUserId: string) => `overlay:${streamerUserId}`,
  feed: () => "feed:global",
} as const;

export async function createConnectionToken(
  userId: string,
  ttlSeconds = 3600,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret);
}

export async function createSubscriptionToken(
  channel: string,
  clientId: string,
  ttlSeconds = 3600,
): Promise<string> {
  return new SignJWT({ channel })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret);
}

export async function publish(
  channel: string,
  data: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${env.CENTRIFUGO_API_URL}/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.CENTRIFUGO_API_KEY,
    },
    body: JSON.stringify({ channel, data }),
  });

  if (!response.ok) {
    throw new Error(
      `centrifugo publish failed: ${response.status} ${await response.text()}`,
    );
  }

  const body: unknown = await response.json();
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error
  ) {
    throw new Error(`centrifugo publish rejected: ${JSON.stringify(body)}`);
  }
}
