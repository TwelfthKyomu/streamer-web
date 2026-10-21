import Link from "next/link";
import { ThemeToggle } from "@/app/_components/theme-toggle";
import { SignInButton, UserMenu } from "@/app/_components/user-menu";
import { getCurrentUser } from "@/modules/auth";

const navigation = [
  { href: "/", label: "лента" },
  { href: "/soundboard", label: "соундборд" },
  { href: "/leaderboard", label: "рейтинг" },
] as const;

export async function SiteHeader() {
  const user = await getCurrentUser();

  return (
    <header className="sticky top-0 z-40 border-border/60 border-b bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-4">
        <Link
          href="/"
          className="group flex items-center font-bold font-mono text-base tracking-tight"
        >
          <span className="text-primary transition-transform group-hover:-translate-x-0.5">
            [
          </span>
          <span className="px-0.5">портал</span>
          <span className="text-primary transition-transform group-hover:translate-x-0.5">
            ]
          </span>
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="label relative text-muted-foreground transition-colors after:absolute after:-bottom-1.5 after:left-0 after:h-px after:w-0 after:bg-primary after:transition-all hover:text-foreground hover:after:w-full"
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
