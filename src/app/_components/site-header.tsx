import Link from "next/link";
import { ThemeToggle } from "@/app/_components/theme-toggle";
import { SignInButton, UserMenu } from "@/app/_components/user-menu";
import { getCurrentUser } from "@/modules/auth";

const navigation = [
  { href: "/", label: "Лента" },
  { href: "/soundboard", label: "Соундборд" },
  { href: "/leaderboard", label: "Рейтинг" },
] as const;

export async function SiteHeader() {
  const user = await getCurrentUser();

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="font-bold text-lg tracking-tight">
          <span className="text-primary">/</span>портал
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {user ? <UserMenu user={user} /> : <SignInButton />}
        </div>
      </div>
    </header>
  );
}
