"use client";

import { Centrifuge } from "centrifuge";
import { useEffect, useRef, useState } from "react";

type SoundEvent = {
  type: "sound";
  soundId: string;
  name: string;
  url: string;
  playedBy: string;
};

type OverlayPayload = SoundEvent | { type: string };

function isSoundEvent(payload: OverlayPayload): payload is SoundEvent {
  return (
    payload.type === "sound" &&
    "url" in payload &&
    typeof payload.url === "string"
  );
}

export function OverlayClient({
  wsUrl,
  channel,
  connectionToken,
  subscriptionToken,
}: {
  wsUrl: string;
  channel: string;
  connectionToken: string;
  subscriptionToken: string;
}) {
  const [connected, setConnected] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const queueRef = useRef<SoundEvent[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    const playNext = () => {
      const next = queueRef.current.shift();
      if (!next) {
        busyRef.current = false;
        setNowPlaying(null);
        return;
      }

      busyRef.current = true;
      setNowPlaying(next.name);

      const audio = new Audio(next.url);
      audio.addEventListener("ended", playNext, { once: true });
      audio.addEventListener("error", playNext, { once: true });
      void audio.play().catch(playNext);
    };

    const centrifuge = new Centrifuge(wsUrl, { token: connectionToken });
    const subscription = centrifuge.newSubscription(channel, {
      token: subscriptionToken,
    });

    subscription.on("publication", (ctx) => {
      const payload = ctx.data as OverlayPayload;
      if (!isSoundEvent(payload)) return;

      queueRef.current.push(payload);
      if (!busyRef.current) playNext();
    });

    centrifuge.on("connected", () => setConnected(true));
    centrifuge.on("disconnected", () => setConnected(false));

    subscription.subscribe();
    centrifuge.connect();

    return () => {
      subscription.unsubscribe();
      centrifuge.disconnect();
    };
  }, [wsUrl, channel, connectionToken, subscriptionToken]);

  return (
    <div className="pointer-events-none fixed inset-0 p-6 font-sans">
      <div className="flex items-start gap-2">
        <span
          className={`size-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`}
          title={connected ? "подключено" : "нет связи"}
        />
      </div>

      {nowPlaying ? (
        <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-black/70 px-4 py-2 text-white text-sm shadow-lg backdrop-blur">
          <span className="size-2 animate-pulse rounded-full bg-violet-400" />
          {nowPlaying}
        </div>
      ) : null}
    </div>
  );
}
