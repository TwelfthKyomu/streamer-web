import { CoinsIcon, VolumeXIcon } from "lucide-react";
import type { Metadata } from "next";
import { getCurrentUser } from "@/modules/auth";
import { list } from "@/modules/soundboard";
import { Card } from "@/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/empty";
import { SoundGrid } from "./_components/sound-grid";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Соундборд",
  description: "Запускайте мемные звуки прямо в трансляцию за баллы.",
};

export default async function SoundboardPage() {
  const [user, sounds] = await Promise.all([getCurrentUser(), list()]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl tracking-tight">Соундборд</h1>
          <p className="text-muted-foreground text-sm">
            Звук уходит прямо в трансляцию. Есть общий кулдаун — не спамьте.
          </p>
        </div>

        {user ? (
          <Card className="flex flex-row items-center gap-2 px-4 py-2">
            <CoinsIcon className="size-4 text-primary" />
            <span className="font-mono font-semibold tabular-nums">
              {user.pointsBalance}
            </span>
            <span className="text-muted-foreground text-sm">баллов</span>
          </Card>
        ) : null}
      </div>

      {sounds.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <VolumeXIcon />
            </EmptyMedia>
            <EmptyTitle>Звуков пока нет</EmptyTitle>
            <EmptyDescription>
              Загрузите первые звуки через админку — после нормализации
              громкости они появятся здесь.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SoundGrid
          sounds={sounds}
          canPlay={Boolean(user)}
          balance={user?.pointsBalance ?? 0}
        />
      )}
    </div>
  );
}
