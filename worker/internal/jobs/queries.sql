-- name: ClaimJob :one
WITH next AS (
  SELECT id
  FROM media_jobs
  WHERE (status = 'queued' AND run_at <= now())
     OR (status = 'running' AND locked_until < now())
  ORDER BY run_at, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
), claimed AS (
  UPDATE media_jobs j
  SET status = 'running',
      attempts = j.attempts + 1,
      locked_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::float8),
      locked_by = sqlc.arg(worker_id)::text,
      updated_at = now()
  FROM next
  WHERE j.id = next.id
  RETURNING j.id, j.media_id, j.attempts
), touched AS (
  UPDATE media m
  SET processing_status = 'processing'
  FROM claimed c
  WHERE m.id = c.media_id
  RETURNING m.id, m.owner_id, m.storage_key
)
SELECT c.id, c.media_id, c.attempts, t.owner_id, t.storage_key
FROM claimed c
JOIN touched t ON t.id = c.media_id;

-- name: ExtendLease :execrows
UPDATE media_jobs
SET locked_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::float8),
    updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'running' AND attempts = sqlc.arg(attempts);

-- name: CompleteJob :execrows
UPDATE media_jobs
SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'running' AND attempts = sqlc.arg(attempts);

-- name: FailJob :execrows
UPDATE media_jobs
SET status = 'failed', locked_until = NULL, last_error = sqlc.arg(last_error)::text, updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'running' AND attempts = sqlc.arg(attempts);

-- name: RetryJob :execrows
UPDATE media_jobs
SET status = 'queued',
    run_at = now() + make_interval(secs => sqlc.arg(delay_seconds)::float8),
    locked_until = NULL,
    locked_by = NULL,
    last_error = sqlc.arg(last_error)::text,
    updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'running' AND attempts = sqlc.arg(attempts);

-- name: ReleaseJob :execrows
UPDATE media_jobs
SET status = 'queued',
    attempts = attempts - 1,
    run_at = now(),
    locked_until = NULL,
    locked_by = NULL,
    updated_at = now()
WHERE id = sqlc.arg(id) AND status = 'running' AND attempts = sqlc.arg(attempts);

-- name: MarkMediaReady :exec
UPDATE media
SET processing_status = 'ready',
    variants = sqlc.arg(variants),
    width = sqlc.arg(width)::int,
    height = sqlc.arg(height)::int,
    duration_ms = sqlc.arg(duration_ms)::int
WHERE id = sqlc.arg(id);

-- name: MarkMediaFailed :exec
UPDATE media SET processing_status = 'failed' WHERE id = sqlc.arg(id);
