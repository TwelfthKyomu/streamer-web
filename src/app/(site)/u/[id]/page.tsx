import { eq } from "drizzle-orm";
import { CoinsIcon, ImageIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/core/db/client";
import { profiles } from "@/core/db/schema";
import { publicUrl } from "@/core/storage/s3";
import { listForUser } from "@/modules/achievements";
import { listByAuthor } from "@/modules/feed";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/empty";

export const dynamic = "force-dynamic";

async function loadProfile(id: string) {
  return db.query.profiles.findFirst({ where: eq(profiles.userId, id) });
}

export async function generateMetadata({
  params,
}: PageProps<"/u/[id]">): Promise<Metadata> {
  const { id } = await params;
  const profile = await loadProfile(id);

  return {
    title: profile?.displayName ?? "Профиль",
    description: profile?.bio ?? undefined,
  };
}

export default async function ProfilePage({ params }: PageProps<"/u/[id]">) {
  const { id } = await params;
  const profile = await loadProfile(id);

  if (!profile) notFound();

  const [badges, authored] = await Promise.all([
    listForUser(id),
    listByAuthor(id),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <Card className="flex flex-col items-center gap-4 p-6 text-center sm:flex-row sm:text-left">
        <Avatar className="size-20">
          {profile.avatarUrl ? (
            <AvatarImage src={profile.avatarUrl} alt="" />
          ) : null}
          <AvatarFallback className="text-xl">
            {profile.displayName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-bold text-2xl tracking-tight">
            {profile.displayName}
          </h1>
          {profile.bio ? (
            <p className="mt-1 text-muted-foreground text-sm">{profile.bio}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <Badge variant="secondary" className="gap-1.5">
              <CoinsIcon className="size-3" />
              <span className="tabular-nums">
                {profile.pointsBalance.toLocaleString("ru-RU")}
              </span>
            </Badge>
            {profile.role !== "user" ? (
              <Badge>{profile.role === "admin" ? "админ" : "модератор"}</Badge>
            ) : null}
            <Badge variant="outline">
              с {profile.createdAt.toLocaleDateString("ru-RU")}
            </Badge>
          </div>
        </div>
      </Card>

      {badges.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold text-lg">Достижения</h2>
          <div className="flex flex-wrap gap-2">
            {badges.map((badge) => (
              <Badge
                key={badge.code}
                variant="secondary"
                className="gap-1.5 py-1"
                title={`${badge.description} · открыто ${badge.unlockedAt.toLocaleDateString("ru-RU")}`}
              >
                <span aria-hidden>{badge.icon}</span>
                {badge.title}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-lg">Посты</h2>

        {authored.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ImageIcon />
              </EmptyMedia>
              <EmptyTitle>Пока ничего не опубликовано</EmptyTitle>
              <EmptyDescription>
                Одобренные модератором посты появятся здесь.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {authored.map((post) => (
              <Card key={post.id} className="overflow-hidden p-0">
                <img
                  src={
                    post.mediaVariants.poster
                      ? publicUrl(post.mediaVariants.poster)
                      : publicUrl(post.mediaKey)
                  }
                  alt={post.caption ?? "Пост"}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
