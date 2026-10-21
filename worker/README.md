# media-worker

Go-воркер, который обрабатывает видео, загруженные на сайт. Из одного
исходника он делает:

- MP4 720p и 480p для ленты (`variants.mp4_720`, `variants.mp4_480`);
- HLS из этих же файлов, без повторного кодирования (`variants.hls`);
- превью-кадр (`variants.poster`);
- звук, выровненный по громкости до −16 LUFS (двухпроходный `loudnorm`).

Результат кладётся в тот же бакет S3 под `media/<owner>/<media>/`, в базе
`media` получает `processing_status = ready`, а сайт получает публикацию
в Centrifugo.

Кроме того, воркер служит подопытным для ruvo: у него открыт
`net/http/pprof`, и устроен он так, что пробки и утечки в нём видны
по-настоящему.

## Как устроено

```
сайт: publishUpload ──► media + media_jobs (одна транзакция)
                                  │
воркер:  загрузчик ── chan (без буфера) ──► воркеры ×N ──► ffmpeg
         Claim: FOR UPDATE SKIP LOCKED      продление аренды
                                            Complete / Retry / Fail / Release
                                  │
            S3 (MinIO) ◄── файлы   ├──► media.variants, processing_status
                                   └──► Centrifugo: media:<owner>
```

- **Очередь** — таблица `media_jobs` (схема в `src/core/db/schema/jobs.ts`,
  миграция `0001_media_jobs`). Задачу ставит `publishUpload` в той же
  транзакции, что и запись `media`. Воркер берёт задачу в аренду
  (`locked_until`) и продлевает её каждые `WORKER_LEASE / 4`. Если процесс
  упал, задачу заберёт следующий, когда аренда истечёт.
- **Номер попытки** (`attempts`) одновременно служит маркером аренды. Все
  изменения задачи сверяют его в `WHERE`, поэтому воркер, у которого задачу
  перехватили, ничего не перезапишет.
- **Пул.** Загрузчик отдаёт задачи воркерам через небуферизованный канал:
  пока все воркеры заняты, он стоит на отправке и новых задач не арендует.
  Каждая задача выполняется с меткой pprof `media_job=<id>`.
- **Повторы.** После ошибки задача ждёт 15 с, потом 1 мин, 4 мин, дальше по
  15 мин. Всего `WORKER_MAX_ATTEMPTS` попыток. Ошибку, которую повтор не
  исправит (не видео, нет файла, видео длиннее лимита), задача получает
  сразу как `failed`.
- **Остановка** по SIGINT/SIGTERM. Новые задачи воркер не берёт, начатые
  дорабатывают. Если за `WORKER_SHUTDOWN_TIMEOUT` они не закончились,
  ffmpeg убивается, а задачи возвращаются в очередь без списания попытки.
  Второй Ctrl+C завершает процесс сразу.
- **pprof и `/healthz`** — на `WORKER_DEBUG_ADDR`, по умолчанию
  `127.0.0.1:6060`. Есть всё, что читает ruvo: `goroutine?debug=1|2`,
  `goroutineleak`, `trace`.

## Запуск

Нужны Go 1.27+, ffmpeg и ffprobe в `PATH` (`brew install ffmpeg`), а также
Postgres с миграциями сайта и S3 из `docker-compose.yml`.

```bash
npm run worker:dev
```

Команда читает тот же `.env`, что и сайт. Переменные, заданные явно, важнее
файла. Например, чтобы запустить воркер на локальной базе, а не на той, что
указана в `.env`:

```bash
DATABASE_URL=postgres://streamer:streamer@localhost:5433/streamer npm run worker:dev
```

| Переменная | По умолчанию | |
|---|---|---|
| `DATABASE_URL`, `S3_*` | — | общие с сайтом, обязательны |
| `CENTRIFUGO_API_URL`, `CENTRIFUGO_API_KEY` | — | без них уведомлений нет, статус остаётся в базе |
| `MAX_VIDEO_DURATION_SEC` | 60 | общий с сайтом лимит, проверяется по факту |
| `WORKER_CONCURRENCY` | 2 | сколько видео обрабатывается одновременно |
| `WORKER_MAX_ATTEMPTS` | 5 | |
| `WORKER_LEASE` | 2m | срок аренды задачи |
| `WORKER_JOB_TIMEOUT` | 10m | |
| `WORKER_SHUTDOWN_TIMEOUT` | 1m | сколько ждать начатые задачи при остановке |
| `WORKER_POLL_INTERVAL` | 1s | как часто проверять пустую очередь |
| `WORKER_DEBUG_ADDR` | 127.0.0.1:6060 | pprof и `/healthz` |
| `WORKER_X264_PRESET` | veryfast | |
| `WORKER_TMP_DIR` | системный | рабочие файлы задачи |
| `FFMPEG_PATH`, `FFPROBE_PATH` | из `PATH` | |
| `WORKER_LOG_FORMAT` | json | `text` — для чтения глазами |

## Сайту

- Готовность: `media.processing_status` проходит `uploaded → processing →
  ready | failed`. Варианты лежат в `media.variants` в виде ключей объектов,
  адрес собирает `publicUrl()`. Лента и модерация играют `hls`
  (запасной вариант — `mp4_720`) и показывают `poster`.
- Событие: канал `media:<ownerUserId>` (`channels.media()` в
  `src/core/realtime/centrifugo.ts`, пространство `media` в
  `infra/centrifugo/config.json`). Подписка только по токену,
  данные — `{ type: "media.processed", mediaId, status }`. Его слушает
  страница `/upload`, чтобы показать статус обработки.

## Тесты

```bash
npm run worker:test
```

Тесты с ffmpeg пропускаются, если его нет. Интеграционные тесты включаются
переменными окружения: им нужны Postgres и MinIO из `docker-compose.yml`.

```bash
cd worker && TEST_DATABASE_URL=postgres://streamer:streamer@localhost:5433/postgres \
  TEST_S3_URL=http://minioadmin:minioadmin@localhost:9000/streamer-media go test -race ./...
```

Каждый тест на базе создаёт временную базу, накатывает на неё
`src/core/db/migrations` и удаляет её после себя.

## Запросы к базе

Запросы лежат в `internal/jobs/queries.sql`, код по ним генерирует sqlc,
схему он берёт из миграций drizzle:

```bash
cd worker && sqlc generate
```
