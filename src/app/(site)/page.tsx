import { count, eq, sql } from "drizzle-orm";
import { ImagePlusIcon, TrophyIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { FeedList } from "@/app/_components/feed-list";
import { StreamBanner } from "@/app/_components/stream-banner";
import { db } from "@/core/db/client";
import { pointTransactions, posts, profiles } from "@/core/db/schema";
import { env } from "@/core/env";
import { newId } from "@/core/id";
import {
  channels,
  createConnectionToken,
  createSubscriptionToken,
} from "@/core/realtime/centrifugo";
import { getCurrentUser } from "@/modules/auth";
import { listFeed } from "@/modules/feed";
import { getStatus } from "@/modules/twitch";
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
    <Card className="flex flex-col gap-2 rounded-none border-border/60 p-4 transition-colors hover:border-primary/40">
      <span className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="label truncate">{label}</span>
      </span>
      <p className="font-bold font-mono text-2xl leading-none tabular-nums">
        {value.toLocaleString("ru-RU")}
      </p>
    </Card>
  );
}

export default async function HomePage() {
  const user = await getCurrentUser();
  const [stats, feed, streamStatus] = await Promise.all([
    getStats(),
    listFeed({ viewerId: user?.id, limit: 12 }),
    getStatus(),
  ]);

  // Гостям тоже нужен статус эфира, поэтому подключение к Centrifugo
  // подписывается на разовый идентификатор, а не на пользователя.
  const streamChannel = channels.stream();
  const clientId = user?.id ?? `visitor:${newId()}`;

  const [connectionToken, subscriptionToken] = await Promise.all([
    createConnectionToken(clientId),
    createSubscriptionToken(streamChannel, clientId),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <StreamBanner
        initial={streamStatus}
        wsUrl={env.NEXT_PUBLIC_CENTRIFUGO_WS_URL}
        channel={streamChannel}
        connectionToken={connectionToken}
        subscriptionToken={subscriptionToken}
      />

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

      <div className="flex items-end justify-between gap-4 border-border/60 border-b pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-bold text-2xl tracking-tight">Лента</h1>
          <span className="label text-muted-foreground">
            {feed.items.length.toString().padStart(2, "0")}
          </span>
        </div>
        {user ? (
          <Button
            variant="outline"
            className="rounded-sm"
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
        <FeedList
          initialItems={feed.items}
          initialCursor={feed.nextCursor}
          canInteract={Boolean(user)}
        />
      )}
    </div>
  );
}
