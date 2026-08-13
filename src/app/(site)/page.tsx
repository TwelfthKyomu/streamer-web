import { count, eq, sql } from "drizzle-orm";
import { ImagePlusIcon, RadioIcon, TrophyIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { PostCard } from "@/app/_components/post-card";
import { db } from "@/core/db/client";
import { pointTransactions, posts, profiles } from "@/core/db/schema";
import { getCurrentUser } from "@/modules/auth";
import { listFeed } from "@/modules/feed";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/empty";

export const dynamic = "force-dynamic";

async function getStats() {
  const [members] = await db.select({ value: count() }).from(profiles);
  const [published] = await db
    .select({ value: count() })
    .from(posts)
    .where(eq(posts.status, "approved"));
  const [awarded] = await db
    .select({
      value: sql<number>`coalesce(sum(${pointTransactions.amount}) filter (where ${pointTransactions.amount} > 0), 0)::int`,
    })
    .from(pointTransactions);

  return {
    members: members?.value ?? 0,
    posts: published?.value ?? 0,
    points: awarded?.value ?? 0,
  };
}

async function StreamBanner() {
  const status = await db.query.streamStatus.findFirst();
  const isLive = status?.isLive ?? false;

  return (
    <Card className="flex flex-col gap-4 border-primary/25 bg-gradient-to-br from-primary/12 via-primary/5 to-transparent p-6 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <span className="relative flex size-3" aria-hidden>
          {isLive ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
          ) : null}
          <span
            className={`relative inline-flex size-3 rounded-full ${isLive ? "bg-primary" : "bg-muted-foreground/50"}`}
          />
        </span>

        <div>
          <p className="font-semibold">
            {isLive ? "Стрим идёт прямо сейчас" : "Стрим офлайн"}
          </p>
          <p className="text-muted-foreground text-sm">
            {isLive
              ? (status?.title ?? "Без названия")
              : "Загляните в ленту или загрузите свой мем"}
          </p>
        </div>
      </div>

      <Button
        className="sm:ml-auto"
        nativeButton={false}
        render={<Link href="/soundboard" />}
      >
        <RadioIcon className="size-4" />
        Соундборд
      </Button>
    </Card>
  );
}

function StatTile({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  return (
    <Card className="flex flex-row items-center gap-3 p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-lg leading-none tabular-nums">
          {value.toLocaleString("ru-RU")}
        </p>
        <p className="truncate text-muted-foreground text-xs">{label}</p>
      </div>
    </Card>
  );
}

export default async function HomePage() {
  const user = await getCurrentUser();
  const [stats, feed] = await Promise.all([
    getStats(),
    listFeed({ viewerId: user?.id, limit: 12 }),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <StreamBanner />

      <div className="grid grid-cols-3 gap-3">
        <StatTile
          icon={<UsersIcon className="size-4" />}
          value={stats.members}
          label="участников"
        />
        <StatTile
          icon={<ImagePlusIcon className="size-4" />}
          value={stats.posts}
          label="в ленте"
        />
        <StatTile
          icon={<TrophyIcon className="size-4" />}
          value={stats.points}
          label="баллов роздано"
        />
      </div>

      <div className="flex items-center justify-between">
        <h1 className="font-bold text-2xl tracking-tight">Лента</h1>
        {user ? (
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/upload" />}
          >
            <ImagePlusIcon className="size-4" />
            Загрузить
          </Button>
        ) : null}
      </div>

      {feed.items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ImagePlusIcon />
            </EmptyMedia>
            <EmptyTitle>Здесь пока пусто</EmptyTitle>
            <EmptyDescription>
              Первый мем ждёт своего автора. После проверки модератором он
              появится здесь.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {feed.items.map((post) => (
            <PostCard key={post.id} post={post} canInteract={Boolean(user)} />
          ))}
        </div>
      )}
    </div>
  );
}
