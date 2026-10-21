/**
 * Точка, где приложение подписывается на собственную шину событий.
 * Next вызывает register() один раз при старте сервера — до этого файла
 * обработчики никто не регистрировал, и emit уходил в никуда.
 */
export async function register(): Promise<void> {
  // Шина работает с базой, поэтому в edge-рантайме ей делать нечего.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ registerPointsSubscribers }, { registerAchievementSubscribers }] =
    await Promise.all([
      import("@/modules/points"),
      import("@/modules/achievements"),
    ]);

  registerPointsSubscribers();
  registerAchievementSubscribers();
}
