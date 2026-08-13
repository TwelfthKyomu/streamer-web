import { TrophyIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/modules/auth";
import { leaderboard } from "@/modules/points";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Card } from "@/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/empty";
import { cn } from "@/ui/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Рейтинг",
  description: "Топ участников сообщества по баллам за активность.",
};

const medals = ["🥇", "🥈", "🥉"];

export default async function LeaderboardPage() {
  const [user, rows] = await Promise.all([getCurrentUser(), leaderboard(50)]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      <div>
        <h1 className="font-bold text-2xl tracking-tight">Рейтинг</h1>
        <p className="text-muted-foreground text-sm">
          Баллы начисляются за посты, лайки и активность на стриме.
        </p>
      </div>

      {rows.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TrophyIcon />
            </EmptyMedia>
            <EmptyTitle>Рейтинг пуст</EmptyTitle>
            <EmptyDescription>
              Как только появятся участники, они займут места здесь.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="divide-y p-0">
          {rows.map((row, index) => (
            <Link
              key={row.userId}
              href={`/u/${row.userId}`}
              className={cn(
                "flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/50",
                row.userId === user?.id && "bg-primary/5",
              )}
            >
              <span className="w-8 shrink-0 text-center font-mono text-muted-foreground text-sm tabular-nums">
                {medals[index] ?? index + 1}
              </span>

              <Avatar className="size-8">
                {row.avatarUrl ? (
                  <AvatarImage src={row.avatarUrl} alt="" />
                ) : null}
                <AvatarFallback>
                  {row.displayName.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>

              <span className="min-w-0 flex-1 truncate font-medium text-sm">
                {row.displayName}
              </span>

              <span className="font-mono font-semibold text-sm tabular-nums">
                {row.pointsBalance.toLocaleString("ru-RU")}
              </span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
