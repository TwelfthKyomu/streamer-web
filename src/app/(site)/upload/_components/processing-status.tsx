"use client";

import { Centrifuge } from "centrifuge";
import { CheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { mediaStatusAction } from "@/app/_actions/upload";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Spinner } from "@/ui/spinner";

export type MediaRealtime = {
  wsUrl: string;
  channel: string;
  connectionToken: string;
  subscriptionToken: string;
};

type Status = "processing" | "ready" | "failed";

type Processed = {
  type: "media.processed";
  mediaId: string;
  status: "ready" | "failed";
};

function isProcessed(data: unknown): data is Processed {
  if (typeof data !== "object" || data === null) return false;
  const event = data as Record<string, unknown>;
  return (
    event.type === "media.processed" &&
    typeof event.mediaId === "string" &&
    (event.status === "ready" || event.status === "failed")
  );
}

const copy: Record<Status, { label: string; text: string }> = {
  processing: {
    label: "обрабатывается…",
    text: "Сжимаем видео для ленты и выравниваем звук. Страницу можно закрыть — обработка продолжится.",
  },
  ready: {
    label: "готово",
    text: "Видео обработано. Пост появится в ленте после проверки модератором.",
  },
  failed: {
    label: "не получилось",
    text: "Видео не удалось обработать. Пост всё равно уйдёт на проверку модератору.",
  },
};

export function ProcessingStatus({
  mediaId,
  realtime,
  onReset,
}: {
  mediaId: string;
  realtime: MediaRealtime;
  onReset: () => void;
}) {
  const [status, setStatus] = useState<Status>("processing");
  const { wsUrl, channel, connectionToken, subscriptionToken } = realtime;

  useEffect(() => {
    if (status !== "processing") return;

    const centrifuge = new Centrifuge(wsUrl, { token: connectionToken });
    const subscription = centrifuge.newSubscription(channel, {
      token: subscriptionToken,
    });

    subscription.on("publication", (ctx) => {
      if (isProcessed(ctx.data) && ctx.data.mediaId === mediaId) {
        setStatus(ctx.data.status);
      }
    });

    // Событие не ждёт подписчиков: повторно загруженный файл обработан давно,
    // а свежий мог успеть, пока сокет поднимался или переподключался. Поэтому
    // после каждой подписки статус сверяется с базой.
    subscription.on("subscribed", () => {
      mediaStatusAction(mediaId)
        .then((current) => {
          if (current === "ready" || current === "failed") setStatus(current);
        })
        .catch(() => undefined);
    });

    subscription.subscribe();
    centrifuge.connect();

    return () => {
      subscription.unsubscribe();
      centrifuge.disconnect();
    };
  }, [status, mediaId, wsUrl, channel, connectionToken, subscriptionToken]);

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-start gap-3" aria-live="polite">
        <span className="mt-0.5 shrink-0">
          {status === "processing" ? (
            <Spinner aria-hidden className="text-muted-foreground" />
          ) : status === "ready" ? (
            <CheckIcon className="size-4 text-primary" />
          ) : (
            <XIcon className="size-4 text-destructive" />
          )}
        </span>

        <div>
          <p className="font-semibold">Отправлено на модерацию</p>
          <p
            className={`label mt-2 ${
              status === "ready"
                ? "text-primary"
                : status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            Видео: {copy[status].label}
          </p>
          <p className="mt-2 text-muted-foreground text-sm">
            {copy[status].text}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onReset}>
          Загрузить ещё
        </Button>
        <Button
          className="flex-1"
          nativeButton={false}
          render={<Link href="/" />}
        >
          В ленту
        </Button>
      </div>
    </Card>
  );
}
