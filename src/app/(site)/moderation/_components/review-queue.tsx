"use client";

import { CheckIcon, XIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { decideAction } from "@/app/_actions/moderation";
import { VideoPlayer } from "@/app/_components/video-player";
import type { PendingPost } from "@/modules/moderation";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

export function ReviewQueue({ initial }: { initial: PendingPost[] }) {
  const [queue, setQueue] = useState(initial);
  const [pending, startTransition] = useTransition();

  const handleDecide = (postId: string, approve: boolean) => {
    startTransition(async () => {
      const result = await decideAction({ postId, approve });

      if (result.status === "ok") {
        setQueue((current) => current.filter((post) => post.id !== postId));
        toast.success(approve ? "Опубликовано" : "Отклонено");
        return;
      }

      if (result.status === "already_decided") {
        setQueue((current) => current.filter((post) => post.id !== postId));
        toast.info("Решение уже принято");
        return;
      }

      toast.error("Не удалось применить решение");
    });
  };

  if (queue.length === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="font-medium">Очередь пуста</p>
        <p className="text-muted-foreground text-sm">Всё разобрано.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {queue.map((post) => (
        <Card key={post.id} className="overflow-hidden p-0">
          <div className="flex items-center gap-3 p-4">
            <Avatar className="size-8">
              {post.author.avatarUrl ? (
                <AvatarImage src={post.author.avatarUrl} alt="" />
              ) : null}
              <AvatarFallback>
                {post.author.displayName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-sm">
                {post.author.displayName}
              </p>
              <p className="text-muted-foreground text-xs">
                {post.createdAt.toLocaleString("ru-RU")}
              </p>
            </div>
          </div>

          {post.caption ? (
            <p className="px-4 pb-3 text-sm">{post.caption}</p>
          ) : null}

          <div className="bg-muted/40">
            {post.media.kind === "video" ? (
              <VideoPlayer
                hls={post.media.hls}
                src={post.media.url}
                poster={post.media.poster}
                className="max-h-96 w-full object-contain"
              />
            ) : (
              <img
                src={post.media.url}
                alt=""
                className="max-h-96 w-full object-contain"
              />
            )}
          </div>

          <div className="flex gap-2 p-3">
            <Button
              className="flex-1"
              disabled={pending}
              onClick={() => handleDecide(post.id, true)}
            >
              <CheckIcon className="size-4" />
              Опубликовать
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={pending}
              onClick={() => handleDecide(post.id, false)}
            >
              <XIcon className="size-4" />
              Отклонить
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
