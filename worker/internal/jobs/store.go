package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs/queries"
)

// Store — очередь media_jobs в Postgres. Каждое изменение задачи сверяет
// номер попытки: воркер, у которого задачу перехватили, ничего не испортит.
type Store struct {
	pool     *pgxpool.Pool
	q        *queries.Queries
	workerID string
	lease    time.Duration
}

func NewStore(pool *pgxpool.Pool, workerID string, lease time.Duration) *Store {
	return &Store{pool: pool, q: queries.New(pool), workerID: workerID, lease: lease}
}

// Claim арендует самую раннюю готовую задачу или задачу с истёкшей арендой.
func (s *Store) Claim(ctx context.Context) (Job, bool, error) {
	row, err := s.q.ClaimJob(ctx, queries.ClaimJobParams{
		LeaseSeconds: s.lease.Seconds(),
		WorkerID:     s.workerID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, fmt.Errorf("claim job: %w", err)
	}
	return Job{
		ID:         row.ID,
		MediaID:    row.MediaID.String(),
		Attempt:    int(row.Attempts),
		OwnerID:    row.OwnerID,
		StorageKey: row.StorageKey,
	}, true, nil
}

func (s *Store) Extend(ctx context.Context, job Job) error {
	n, err := s.q.ExtendLease(ctx, queries.ExtendLeaseParams{
		LeaseSeconds: s.lease.Seconds(),
		ID:           job.ID,
		Attempts:     int32(job.Attempt),
	})
	return fenced("extend lease", n, err)
}

// Complete закрывает задачу и выставляет media готовность одной
// транзакцией: сайт не увидит ready без вариантов и наоборот.
func (s *Store) Complete(ctx context.Context, job Job, res Result) error {
	variants, err := json.Marshal(res.Variants)
	if err != nil {
		return fmt.Errorf("encode variants: %w", err)
	}
	mediaID, err := uuid(job.MediaID)
	if err != nil {
		return err
	}

	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		n, err := q.CompleteJob(ctx, queries.CompleteJobParams{ID: job.ID, Attempts: int32(job.Attempt)})
		if err := fenced("complete job", n, err); err != nil {
			return err
		}
		return q.MarkMediaReady(ctx, queries.MarkMediaReadyParams{
			ID:         mediaID,
			Variants:   variants,
			Width:      int32(res.Width),
			Height:     int32(res.Height),
			DurationMs: int32(res.DurationMs),
		})
	})
}

func (s *Store) Fail(ctx context.Context, job Job, cause error) error {
	mediaID, err := uuid(job.MediaID)
	if err != nil {
		return err
	}

	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		n, err := q.FailJob(ctx, queries.FailJobParams{
			ID:        job.ID,
			Attempts:  int32(job.Attempt),
			LastError: describe(cause),
		})
		if err := fenced("fail job", n, err); err != nil {
			return err
		}
		return q.MarkMediaFailed(ctx, mediaID)
	})
}

func (s *Store) Retry(ctx context.Context, job Job, delay time.Duration, cause error) error {
	n, err := s.q.RetryJob(ctx, queries.RetryJobParams{
		ID:           job.ID,
		Attempts:     int32(job.Attempt),
		DelaySeconds: delay.Seconds(),
		LastError:    describe(cause),
	})
	return fenced("retry job", n, err)
}

// Release возвращает задачу без списания попытки: её прервала остановка
// воркера, а не ошибка в самом видео.
func (s *Store) Release(ctx context.Context, job Job) error {
	n, err := s.q.ReleaseJob(ctx, queries.ReleaseJobParams{ID: job.ID, Attempts: int32(job.Attempt)})
	return fenced("release job", n, err)
}

func fenced(op string, rows int64, err error) error {
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	if rows == 0 {
		return fmt.Errorf("%s: %w", op, ErrLeaseLost)
	}
	return nil
}

func uuid(s string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(s); err != nil {
		return id, fmt.Errorf("media id %q: %w", s, err)
	}
	return id, nil
}

// describe обрезает текст ошибки: в last_error он нужен человеку, а stderr
// ffmpeg бывает длинным.
func describe(err error) string {
	const limit = 2000
	msg := err.Error()
	if len(msg) > limit {
		msg = msg[:limit]
	}
	return msg
}
