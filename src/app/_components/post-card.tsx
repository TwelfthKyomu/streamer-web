"use client";

import { HeartIcon, MessageCircleIcon } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { likeAction } from "@/app/_actions/feed";
import { VideoPlayer } from "@/app/_components/video-player";
import type { FeedPost } from "@/modules/feed";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Card } from "@/ui/card";
import { cn } from "@/ui/utils";

const relative = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

function timeAgo(date: Date | null): string {
  if (!date) return "";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit);
    }
  }
  return relative.format(seconds, "second");
}

export function PostCard({
  post,
  canInteract,
}: {
  post: FeedPost;
  canInteract: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(
    { liked: post.likedByMe, count: post.likeCount },
    (state, liked: boolean) => ({
      liked,
      count: state.count + (liked ? 1 : -1),
    }),
  );

  const handleLike = () => {
    if (!canInteract) {
      toast.info("Войдите, чтобы ставить лайки");
      return;
    }

    startTransition(async () => {
      setOptimistic(!optimistic.liked);
      const result = await likeAction(post.id);

      if (result.status === "rate_limited") {
        toast.error("Слишком часто", {
          description: `Попробуйте через ${result.retryAfterSeconds} с`,
        });
      } else if (result.status === "not_found") {
        toast.error("Пост недоступен");
      }
    });
  };

  return (
    <Card className="overflow-hidden p-0 transition-colors hover:border-primary/40">
      <div className="flex items-center gap-3 border-border/60 border-b p-3">
        <Avatar className="size-8 rounded-sm">
          {post.author.avatarUrl ? (
            <AvatarImage src={post.author.avatarUrl} alt="" />
          ) : null}
          <AvatarFallback className="rounded-sm font-mono text-xs">
            {post.author.displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <Link
            href={`/u/${post.author.id}`}
            className="truncate font-medium text-sm decoration-primary underline-offset-4 hover:underline"
          >
            {post.author.displayName}
          </Link>
        </div>

        <span className="label shrink-0 text-muted-foreground">
          {timeAgo(post.publishedAt)}
        </span>
      </div>

      {post.caption ? (
        <p className="px-4 pb-3 text-sm leading-relaxed">{post.caption}</p>
      ) : null}

      <div className="bg-muted/40">
        {post.media.kind === "video" ? (
          <VideoPlayer
            hls={post.media.hls}
            src={post.media.url}
            poster={post.media.poster}
            className="max-h-[32rem] w-full object-contain"
          />
        ) : (
          <img
            src={post.media.url}
            alt={post.caption ?? "Пост"}
            loading="lazy"
            className="max-h-[32rem] w-full object-contain"
          />
        )}
      </div>

      <div className="flex items-center gap-1 border-border/60 border-t p-2">
        <button
          type="button"
          onClick={handleLike}
          disabled={pending}
          aria-pressed={optimistic.liked}
          className={cn(
            "inline-flex items-center gap-2 rounded-sm px-3 py-2 font-mono text-sm transition-colors hover:bg-accent disabled:opacity-60",
            optimistic.liked ? "text-primary" : "text-muted-foreground",
          )}
        >
          <HeartIcon
            className={cn("size-4", optimistic.liked && "fill-current")}
          />
          <span className="tabular-nums">{optimistic.count}</span>
        </button>

        <span className="inline-flex items-center gap-2 rounded-sm px-3 py-2 font-mono text-muted-foreground text-sm">
          <MessageCircleIcon className="size-4" />
          <span className="tabular-nums">{post.commentCount}</span>
        </span>
      </div>
    </Card>
  );
}
