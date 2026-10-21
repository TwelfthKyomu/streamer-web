import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { media } from "./content";

export const mediaJobStatus = pgEnum("media_job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

/**
 * Очередь ffmpeg-воркера из `worker/`. Сайт ставит задачу в той же
 * транзакции, что и запись media, поэтому видео без задачи не бывает.
 * Воркер забирает строку через FOR UPDATE SKIP LOCKED и держит аренду
 * (locked_until): упавший процесс отпускает задачу сам, по истечении срока.
 */
export const mediaJobs = pgTable(
  "media_jobs",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    mediaId: uuid()
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    status: mediaJobStatus().notNull().default("queued"),

    // Номер попытки заодно служит маркером аренды: воркер с устаревшим
    // номером не может ни завершить задачу, ни вернуть её в очередь.
    attempts: integer().notNull().default(0),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp({ withTimezone: true }),
    lockedBy: text(),
    lastError: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("media_jobs_media_idx").on(t.mediaId),
    index("media_jobs_queued_idx").on(t.runAt).where(sql`status = 'queued'`),
    index("media_jobs_running_idx")
      .on(t.lockedUntil)
      .where(sql`status = 'running'`),
  ],
);
