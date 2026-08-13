"use client";

import { CoinsIcon, LogOutIcon, ShieldIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { CurrentUser } from "@/modules/auth";
import { signIn, signOut } from "@/modules/auth/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

export function SignInButton() {
  const [pending, setPending] = useState(false);

  const handleSignIn = async () => {
    setPending(true);
    const { error } = await signIn.social({
      provider: "twitch",
      callbackURL: "/",
    });

    if (error) {
      setPending(false);
      toast.error("Не удалось начать вход", { description: error.message });
    }
  };

  return (
    <Button onClick={handleSignIn} disabled={pending}>
      {pending ? "Переходим…" : "Войти через Twitch"}
    </Button>
  );
}

export function UserMenu({ user }: { user: CurrentUser }) {
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";

  const handleSignOut = async () => {
    await signOut();
    router.refresh();
  };

  return (
    <div className="flex items-center gap-3">
      <span
        className="hidden items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 font-mono text-sm tabular-nums sm:flex"
        title="Баллы за активность"
      >
        <CoinsIcon className="size-3.5 text-primary" />
        {user.pointsBalance}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Меню профиля"
            />
          }
        >
          <Avatar className="size-9">
            {user.avatarUrl ? (
              <AvatarImage src={user.avatarUrl} alt="" />
            ) : null}
            <AvatarFallback>
              {user.displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="truncate">
            {user.displayName}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            render={<Link href={`/u/${user.id}`} />}
            className="gap-2"
          >
            <UserIcon className="size-4" />
            Мой профиль
          </DropdownMenuItem>

          {isStaff ? (
            <DropdownMenuItem
              render={<Link href="/moderation" />}
              className="gap-2"
            >
              <ShieldIcon className="size-4" />
              Модерация
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut} className="gap-2">
            <LogOutIcon className="size-4" />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
