import { db } from "./client";
import { achievements, pointRules } from "./schema";

const rules = [
  {
    eventType: "post_approved",
    amount: 25,
    dailyCap: 150,
    cooldownSeconds: 0,
    description: "Пост прошёл модерацию",
  },
  {
    eventType: "post_liked",
    amount: 2,
    dailyCap: 100,
    cooldownSeconds: 0,
    description: "Лайк на вашем посте",
  },
  {
    eventType: "comment_created",
    amount: 1,
    dailyCap: 30,
    cooldownSeconds: 30,
    description: "Комментарий",
  },
  {
    eventType: "daily_visit",
    amount: 10,
    dailyCap: 10,
    cooldownSeconds: 82_800,
    description: "Заход на сайт раз в сутки",
  },
  {
    eventType: "stream_watch",
    amount: 5,
    dailyCap: 60,
    cooldownSeconds: 600,
    description: "Просмотр стрима",
  },
] satisfies (typeof pointRules.$inferInsert)[];

const badges = [
  {
    code: "first_post",
    title: "Дебют",
    description: "Первый одобренный пост",
    icon: "🎬",
    condition: { event: "post.approved", type: "count", threshold: 1 },
  },
  {
    code: "memelord",
    title: "Главный мемодел",
    description: "50 одобренных постов",
    icon: "👑",
    condition: { event: "post.approved", type: "count", threshold: 50 },
  },
  {
    code: "chat_veteran",
    title: "Ветеран чата",
    description: "Активность 30 разных дней",
    icon: "🎖️",
    condition: { event: "user.visit", type: "unique_days", threshold: 30 },
  },
  {
    code: "sniper",
    title: "Снайпер",
    description: "100 звуков в эфире",
    icon: "🎯",
    condition: { event: "sound.played", type: "count", threshold: 100 },
  },
  {
    code: "tastemaker",
    title: "Законодатель вкуса",
    description: "500 лайков на ваших постах",
    icon: "🔥",
    condition: { event: "post.liked", type: "count", threshold: 500 },
  },
] satisfies (typeof achievements.$inferInsert)[];

async function main() {
  await db
    .insert(pointRules)
    .values(rules)
    .onConflictDoUpdate({
      target: pointRules.eventType,
      set: {
        amount: pointRules.amount,
        dailyCap: pointRules.dailyCap,
        cooldownSeconds: pointRules.cooldownSeconds,
      },
    });

  await db.insert(achievements).values(badges).onConflictDoNothing();

  process.stdout.write(
    `правил: ${rules.length}, достижений: ${badges.length}\n`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
