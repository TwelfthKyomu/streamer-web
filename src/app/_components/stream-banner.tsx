"use client";

import { Centrifuge } from "centrifuge";
import { RadioIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { StreamSnapshot } from "@/modules/twitch";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

function isSnapshot(data: unknown): data is StreamSnapshot & { type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data as { type: unknown }).type === "stream.status" &&
    "isLive" in data
  );
}

export function StreamBanner({
  initial,
  wsUrl,
  channel,
  connectionToken,
  subscriptionToken,
}: {
  initial: StreamSnapshot;
  wsUrl: string;
  channel: string;
  connectionToken: string;
  subscriptionToken: string;
}) {
  // Начальное состояние приходит с сервера, поэтому баннер верен ещё до того,
  // как поднимется сокет, и не мигает при загрузке.
  const [status, setStatus] = useState<StreamSnapshot>(initial);

  useEffect(() => {
    const centrifuge = new Centrifuge(wsUrl, { token: connectionToken });
    const subscription = centrifuge.newSubscription(channel, {
      token: subscriptionToken,
    });

    subscription.on("publication", (ctx) => {
      if (!isSnapshot(ctx.data)) return;
      const { isLive, title, game, startedAt } = ctx.data;
      setStatus({ isLive, title, game, startedAt });
    });

    subscription.subscribe();
    centrifuge.connect();

    return () => {
      subscription.unsubscribe();
      centrifuge.disconnect();
    };
  }, [wsUrl, channel, connectionToken, subscriptionToken]);

  return (
    <Card
      className={`hud notch flex flex-col gap-4 rounded-none border-0 p-6 sm:flex-row sm:items-center ${
        status.isLive
          ? "bg-gradient-to-br from-primary/15 via-primary/5 to-transparent"
          : "bg-card"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="relative flex size-2.5" aria-hidden>
          {status.isLive ? (
            <span className="absolute inline-flex size-full animate-ping bg-primary opacity-75" />
          ) : null}
          <span
            className={`relative inline-flex size-2.5 ${
              status.isLive ? "bg-primary" : "bg-muted-foreground/40"
            }`}
          />
        </span>

        <div>
          <p
            className={`label ${
              status.isLive ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {status.isLive ? "в эфире" : "офлайн"}
          </p>
          <p className="mt-1.5 font-semibold text-lg leading-tight">
            {status.isLive
              ? (status.title ?? "Без названия")
              : "Стрим сейчас не идёт"}
          </p>
          {status.isLive && status.game ? (
            <p className="mt-0.5 text-muted-foreground text-sm">
              {status.game}
            </p>
          ) : null}
        </div>
      </div>

      <Button
        className="rounded-sm sm:ml-auto"
        nativeButton={false}
        render={<Link href="/soundboard" />}
      >
        <RadioIcon className="size-4" />
        Соундборд
      </Button>
    </Card>
  );
}
