"use client";

import { CoinsIcon, PlayIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { playSoundAction } from "@/app/_actions/soundboard";
import type { Sound } from "@/modules/soundboard";
import { Card } from "@/ui/card";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/ui/utils";

export function SoundGrid({
  sounds,
  canPlay,
  balance,
}: {
  sounds: Sound[];
  canPlay: boolean;
  balance: number;
}) {
  const [pending, startTransition] = useTransition();
  const [activeId, setActiveId] = useState<string | null>(null);

  const handlePlay = (sound: Sound) => {
    if (!canPlay) {
      toast.info("Войдите, чтобы запускать звуки");
      return;
    }

    if (sound.cost > balance) {
      toast.error("Не хватает баллов", {
        description: `Нужно ${sound.cost}, у вас ${balance}`,
      });
      return;
    }

    setActiveId(sound.id);
    startTransition(async () => {
      const result = await playSoundAction(sound.id);
      setActiveId(null);

      switch (result.status) {
        case "played":
          toast.success(`${sound.name} — в эфире`);
          break;
        case "cooldown":
          toast.warning("Слишком быстро", {
            description: `Ещё ${result.retryAfterSeconds} с`,
          });
          break;
        case "rate_limited":
          toast.error("Слишком много нажатий", {
            description: `Перерыв ${result.retryAfterSeconds} с`,
          });
          break;
        case "insufficient":
          toast.error("Не хватает баллов", {
            description: `Нужно ${result.cost}, у вас ${result.balance}`,
          });
          break;
        case "offline":
          toast.error("Оверлей не подключён");
          break;
        case "not_found":
          toast.error("Звук недоступен");
          break;
        case "failed":
          toast.error("Звук не дошёл до трансляции", {
            description: "Баллы возвращены",
          });
          break;
      }
    });
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {sounds.map((sound) => {
        const isActive = pending && activeId === sound.id;
        const tooExpensive = canPlay && sound.cost > balance;

        return (
          <Card
            key={sound.id}
            className={cn(
              "group relative overflow-hidden p-0 transition-colors",
              tooExpensive ? "opacity-50" : "hover:border-primary/50",
            )}
          >
            <button
              type="button"
              onClick={() => handlePlay(sound)}
              disabled={pending}
              className="flex w-full flex-col items-start gap-3 p-4 text-left disabled:cursor-progress"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                {isActive ? (
                  <Spinner className="size-4" />
                ) : (
                  <PlayIcon className="size-4 fill-current" />
                )}
              </span>

              <span className="w-full">
                <span className="block truncate font-medium text-sm">
                  {sound.name}
                </span>
                <span className="mt-1 flex items-center gap-3 text-muted-foreground text-xs">
                  <span className="tabular-nums">
                    {(sound.durationMs / 1000).toFixed(1)} с
                  </span>
                  {sound.cost > 0 ? (
                    <span className="flex items-center gap-1 tabular-nums">
                      <CoinsIcon className="size-3" />
                      {sound.cost}
                    </span>
                  ) : (
                    <span>бесплатно</span>
                  )}
                </span>
              </span>
            </button>
          </Card>
        );
      })}
    </div>
  );
}
