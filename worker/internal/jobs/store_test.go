package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/TwelfthDannis/streamer-web/worker/internal/testenv"
)

func testDB(t *testing.T) *pgxpool.Pool {
	pool, _ := testenv.Database(t)
	return pool
}

func seedVideo(t *testing.T, pool *pgxpool.Pool) (mediaID string) {
	owner := fmt.Sprintf("user-%d", time.Now().UnixNano())
	return testenv.SeedVideo(t, pool, owner, "media/"+owner+"/source.mp4")
}

type jobRow struct {
	Status    string
	Attempts  int
	LockedBy  *string
	LastError *string
	RunAt     time.Time
}

func readJob(t *testing.T, pool *pgxpool.Pool, mediaID string) jobRow {
	t.Helper()
	var r jobRow
	err := pool.QueryRow(context.Background(), `
		SELECT status::text, attempts, locked_by, last_error, run_at
		FROM media_jobs WHERE media_id = $1`, mediaID).
		Scan(&r.Status, &r.Attempts, &r.LockedBy, &r.LastError, &r.RunAt)
	if err != nil {
		t.Fatalf("read job: %v", err)
	}
	return r
}

func mediaStatus(t *testing.T, pool *pgxpool.Pool, mediaID string) string {
	t.Helper()
	var status string
	err := pool.QueryRow(context.Background(), `SELECT processing_status::text FROM media WHERE id = $1`, mediaID).Scan(&status)
	if err != nil {
		t.Fatalf("read media: %v", err)
	}
	return status
}

func mustClaim(t *testing.T, s *Store) Job {
	t.Helper()
	job, ok, err := s.Claim(context.Background())
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if !ok {
		t.Fatal("Claim found no job")
	}
	return job
}

func TestClaimLeasesJobAndMarksMediaProcessing(t *testing.T) {
	pool := testDB(t)
	mediaID := seedVideo(t, pool)
	store := NewStore(pool, "worker-a", time.Minute)

	job := mustClaim(t, store)

	if job.MediaID != mediaID || job.Attempt != 1 || job.OwnerID == "" || job.StorageKey == "" {
		t.Fatalf("claimed %+v; want media %s, attempt 1, owner and key filled", job, mediaID)
	}
	row := readJob(t, pool, mediaID)
	if row.Status != "running" || row.LockedBy == nil || *row.LockedBy != "worker-a" {
		t.Fatalf("job row = %+v; want running, locked by worker-a", row)
	}
	if got := mediaStatus(t, pool, mediaID); got != "processing" {
		t.Fatalf("media status = %s; want processing", got)
	}
}

func TestClaimSkipsLeasedJob(t *testing.T) {
	pool := testDB(t)
	seedVideo(t, pool)
	mustClaim(t, NewStore(pool, "worker-a", time.Minute))

	_, ok, err := NewStore(pool, "worker-b", time.Minute).Claim(context.Background())
	if err != nil || ok {
		t.Fatalf("second Claim = ok %v, err %v; want nothing while lease is valid", ok, err)
	}
}

func TestClaimTakesOverExpiredLease(t *testing.T) {
	pool := testDB(t)
	seedVideo(t, pool)
	first := NewStore(pool, "worker-a", 50*time.Millisecond)
	stale := mustClaim(t, first)

	time.Sleep(100 * time.Millisecond)
	fresh := mustClaim(t, NewStore(pool, "worker-b", time.Minute))

	if fresh.Attempt != 2 {
		t.Fatalf("takeover attempt = %d; want 2", fresh.Attempt)
	}
	if err := first.Complete(context.Background(), stale, Result{}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Complete with stale lease error = %v; want ErrLeaseLost", err)
	}
	if err := first.Extend(context.Background(), stale); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("Extend with stale lease error = %v; want ErrLeaseLost", err)
	}
}

func TestCompleteWritesVariantsAndReadyStatus(t *testing.T) {
	pool := testDB(t)
	mediaID := seedVideo(t, pool)
	store := NewStore(pool, "worker-a", time.Minute)
	job := mustClaim(t, store)

	if err := store.Extend(context.Background(), job); err != nil {
		t.Fatalf("Extend: %v", err)
	}

	want := Variants{HLS: "p/hls/master.m3u8", MP4720: "p/720p.mp4", MP4480: "p/480p.mp4", Poster: "p/poster.jpg"}
	if err := store.Complete(context.Background(), job, Result{Variants: want, Width: 1080, Height: 1920, DurationMs: 4990}); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	var (
		status            string
		raw               []byte
		width, height, ms int
	)
	err := pool.QueryRow(context.Background(), `
		SELECT processing_status::text, variants, width, height, duration_ms FROM media WHERE id = $1`, mediaID).
		Scan(&status, &raw, &width, &height, &ms)
	if err != nil {
		t.Fatal(err)
	}
	var got Variants
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("variants %s: %v", raw, err)
	}
	if status != "ready" || got != want || width != 1080 || height != 1920 || ms != 4990 {
		t.Fatalf("media = %s %+v %dx%d %dms; want ready %+v 1080x1920 4990ms", status, got, width, height, ms, want)
	}
	if row := readJob(t, pool, mediaID); row.Status != "done" {
		t.Fatalf("job status = %s; want done", row.Status)
	}
}

func TestFailMarksJobAndMediaFailed(t *testing.T) {
	pool := testDB(t)
	mediaID := seedVideo(t, pool)
	store := NewStore(pool, "worker-a", time.Minute)
	job := mustClaim(t, store)

	if err := store.Fail(context.Background(), job, errors.New("not a video")); err != nil {
		t.Fatalf("Fail: %v", err)
	}

	row := readJob(t, pool, mediaID)
	if row.Status != "failed" || row.LastError == nil || *row.LastError != "not a video" {
		t.Fatalf("job row = %+v; want failed with last error", row)
	}
	if got := mediaStatus(t, pool, mediaID); got != "failed" {
		t.Fatalf("media status = %s; want failed", got)
	}
}

func TestRetryDelaysNextClaim(t *testing.T) {
	pool := testDB(t)
	mediaID := seedVideo(t, pool)
	store := NewStore(pool, "worker-a", time.Minute)
	job := mustClaim(t, store)

	if err := store.Retry(context.Background(), job, time.Hour, errors.New("s3 timeout")); err != nil {
		t.Fatalf("Retry: %v", err)
	}

	row := readJob(t, pool, mediaID)
	if row.Status != "queued" || row.LastError == nil || *row.LastError != "s3 timeout" || time.Until(row.RunAt) < 59*time.Minute {
		t.Fatalf("job row = %+v; want queued for an hour with last error", row)
	}
	if _, ok, err := store.Claim(context.Background()); ok || err != nil {
		t.Fatalf("Claim before run_at = ok %v, err %v; want nothing", ok, err)
	}
}

func TestRetryCountsAttempt(t *testing.T) {
	pool := testDB(t)
	seedVideo(t, pool)
	store := NewStore(pool, "worker-a", time.Minute)

	if err := store.Retry(context.Background(), mustClaim(t, store), 0, errors.New("boom")); err != nil {
		t.Fatalf("Retry: %v", err)
	}
	if again := mustClaim(t, store); again.Attempt != 2 {
		t.Fatalf("attempt after retry = %d; want 2", again.Attempt)
	}
}

func TestReleaseDoesNotCountAttempt(t *testing.T) {
	pool := testDB(t)
	mediaID := seedVideo(t, pool)
	store := NewStore(pool, "worker-a", time.Minute)

	if err := store.Release(context.Background(), mustClaim(t, store)); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if row := readJob(t, pool, mediaID); row.Status != "queued" || row.Attempts != 0 || row.LockedBy != nil {
		t.Fatalf("job row after release = %+v; want queued, 0 attempts, unlocked", row)
	}
	if again := mustClaim(t, store); again.Attempt != 1 {
		t.Fatalf("attempt after release = %d; want 1", again.Attempt)
	}
}
