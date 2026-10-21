import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/core/env";
import {
  channels,
  createConnectionToken,
  createSubscriptionToken,
} from "@/core/realtime/centrifugo";
import { getCurrentUser } from "@/modules/auth";
import { limits } from "@/modules/media";
import { UploadForm } from "./_components/upload-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Загрузка",
};

export default async function UploadPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  // Канал личный, поэтому и подключение, и подписка выписываются на
  // пользователя: статус обработки видео приходит только его автору.
  const channel = channels.media(user.id);
  const [connectionToken, subscriptionToken] = await Promise.all([
    createConnectionToken(user.id),
    createSubscriptionToken(channel, user.id),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      <div className="border-border/60 border-b pb-3">
        <h1 className="font-bold text-2xl tracking-tight">Загрузить</h1>
        <p className="mt-1.5 text-muted-foreground text-sm">
          Картинка или короткое видео. После проверки модератором пост появится
          в ленте, а вам начислятся баллы.
        </p>
      </div>

      {user.isBanned ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          Загрузка недоступна: аккаунт ограничен модератором.
        </p>
      ) : (
        <UploadForm
          limits={limits()}
          realtime={{
            wsUrl: env.NEXT_PUBLIC_CENTRIFUGO_WS_URL,
            channel,
            connectionToken,
            subscriptionToken,
          }}
        />
      )}
    </div>
  );
}
