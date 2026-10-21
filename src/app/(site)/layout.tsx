import { SiteHeader } from "@/app/_components/site-header";
import { emit } from "@/core/events/bus";
import { getCurrentUser } from "@/modules/auth";

export default async function SiteLayout({ children }: LayoutProps<"/">) {
  // getCurrentUser закэширован на запрос, так что страницам это не стоит
  // ничего лишнего. Начисление за заход отсекается по кулдауну в правилах.
  const user = await getCurrentUser();
  if (user && !user.isBanned) await emit("user.visit", { userId: user.id });

  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
    </>
  );
}
