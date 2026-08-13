import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "@/core/env";
import {
  channels,
  createConnectionToken,
  createSubscriptionToken,
} from "@/core/realtime/centrifugo";
import { resolveToken } from "@/modules/overlay";
import { OverlayClient } from "./_components/overlay-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Оверлей",
  robots: { index: false, follow: false },
};

export default async function OverlayPage({
  params,
}: PageProps<"/overlay/[token]">) {
  const { token } = await params;
  const streamerId = await resolveToken(token);

  if (!streamerId) notFound();

  const channel = channels.overlay(streamerId);
  const clientId = `overlay:${token.slice(0, 12)}`;

  const [connectionToken, subscriptionToken] = await Promise.all([
    createConnectionToken(clientId),
    createSubscriptionToken(channel, clientId),
  ]);

  return (
    <div className="min-h-screen bg-transparent">
      <OverlayClient
        wsUrl={env.NEXT_PUBLIC_CENTRIFUGO_WS_URL}
        channel={channel}
        connectionToken={connectionToken}
        subscriptionToken={subscriptionToken}
      />
    </div>
  );
}
