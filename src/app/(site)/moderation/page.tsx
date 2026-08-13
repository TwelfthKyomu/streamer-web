import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ForbiddenError,
  requireModerator,
  UnauthorizedError,
} from "@/modules/auth";
import { listPending } from "@/modules/moderation";
import { Badge } from "@/ui/badge";
import { ReviewQueue } from "./_components/review-queue";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Модерация",
};

export default async function ModerationPage() {
  try {
    await requireModerator();
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      notFound();
    }
    throw error;
  }

  const queue = await listPending();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <div className="flex items-center gap-3">
        <h1 className="font-bold text-2xl tracking-tight">Модерация</h1>
        <Badge variant="secondary" className="tabular-nums">
          {queue.length}
        </Badge>
      </div>

      <ReviewQueue initial={queue} />
    </div>
  );
}
