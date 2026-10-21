package pool

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/pprof"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
)

type fakeStore struct {
	mu         sync.Mutex
	queue      []jobs.Job
	claims     int
	claimCalls int
	claimErr   error
	extendErr  error
	extended   int
	completed  map[int64]jobs.Result
	retried    map[int64]time.Duration
	failed     map[int64]error
	released   []int64
}

func newFakeStore(queue ...jobs.Job) *fakeStore {
	return &fakeStore{
		queue:     queue,
		completed: map[int64]jobs.Result{},
		retried:   map[int64]time.Duration{},
		failed:    map[int64]error{},
	}
}

func (s *fakeStore) Claim(context.Context) (jobs.Job, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.claimCalls++
	// Предохранитель: загрузчик, который долбит очередь без пауз, иначе
	// не дал бы фальшивому времени сдвинуться, и тест бы просто завис.
	if s.claimErr != nil && s.claimCalls <= 1000 {
		return jobs.Job{}, false, s.claimErr
	}
	if len(s.queue) == 0 {
		return jobs.Job{}, false, nil
	}
	job := s.queue[0]
	s.queue = s.queue[1:]
	s.claims++
	return job, true, nil
}

func (s *fakeStore) Extend(context.Context, jobs.Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.extended++
	return s.extendErr
}

func (s *fakeStore) Complete(_ context.Context, job jobs.Job, res jobs.Result) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed[job.ID] = res
	return nil
}

func (s *fakeStore) Retry(_ context.Context, job jobs.Job, delay time.Duration, _ error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retried[job.ID] = delay
	return nil
}

func (s *fakeStore) Fail(_ context.Context, job jobs.Job, cause error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failed[job.ID] = cause
	return nil
}

func (s *fakeStore) Release(_ context.Context, job jobs.Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.released = append(s.released, job.ID)
	return nil
}

type processorFunc func(ctx context.Context, job jobs.Job) (jobs.Result, error)

func (f processorFunc) Process(ctx context.Context, job jobs.Job) (jobs.Result, error) {
	return f(ctx, job)
}

type fakeNotifier struct {
	mu   sync.Mutex
	sent []string
}

func (n *fakeNotifier) Notify(_ context.Context, job jobs.Job, status string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, fmt.Sprintf("%d:%s", job.ID, status))
	return nil
}

func job(id int64, attempt int) jobs.Job {
	return jobs.Job{ID: id, MediaID: fmt.Sprintf("media-%d", id), Attempt: attempt, OwnerID: "user-1"}
}

func testConfig() Config {
	return Config{
		Workers:         2,
		MaxAttempts:     3,
		PollInterval:    time.Second,
		HeartbeatEvery:  20 * time.Second,
		JobTimeout:      10 * time.Minute,
		ShutdownTimeout: time.Minute,
	}
}

func newPool(store Store, proc Processor, notifier Notifier, cfg Config) *Pool {
	return New(store, proc, notifier, cfg, slog.New(slog.DiscardHandler))
}

func run(p *Pool) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.Run(ctx)
	}()
	return func() {
		cancel()
		<-done
	}
}

func succeed(res jobs.Result) Processor {
	return processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) { return res, nil })
}

func fail(err error) Processor {
	return processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) { return jobs.Result{}, err })
}

func TestCompletesJobAndNotifiesReady(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1))
		notifier := &fakeNotifier{}
		want := jobs.Result{Width: 1280, Height: 720, DurationMs: 5000}

		stop := run(newPool(store, succeed(want), notifier, testConfig()))
		synctest.Wait()
		stop()

		if got, ok := store.completed[1]; !ok || got != want {
			t.Fatalf("completed[1] = %+v, %v; want %+v", got, ok, want)
		}
		if !slices.Equal(notifier.sent, []string{"1:ready"}) {
			t.Fatalf("notifications = %v; want [1:ready]", notifier.sent)
		}
	})
}

func TestTransientErrorIsRetriedWithBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1), job(2, 2))
		notifier := &fakeNotifier{}

		stop := run(newPool(store, fail(errors.New("s3 unavailable")), notifier, testConfig()))
		synctest.Wait()
		stop()

		if got := store.retried[1]; got != Backoff(1) {
			t.Fatalf("retry delay for attempt 1 = %v; want %v", got, Backoff(1))
		}
		if got := store.retried[2]; got != Backoff(2) {
			t.Fatalf("retry delay for attempt 2 = %v; want %v", got, Backoff(2))
		}
		if len(store.failed) != 0 || len(notifier.sent) != 0 {
			t.Fatalf("failed = %v, notifications = %v; want none", store.failed, notifier.sent)
		}
	})
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	want := []time.Duration{15 * time.Second, time.Minute, 4 * time.Minute, 15 * time.Minute, 15 * time.Minute}
	for i, w := range want {
		if got := Backoff(i + 1); got != w {
			t.Errorf("Backoff(%d) = %v; want %v", i+1, got, w)
		}
	}
}

func TestLastAttemptFailsJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := testConfig()
		store := newFakeStore(job(1, cfg.MaxAttempts))
		notifier := &fakeNotifier{}

		stop := run(newPool(store, fail(errors.New("ffmpeg crashed")), notifier, cfg))
		synctest.Wait()
		stop()

		if _, ok := store.failed[1]; !ok {
			t.Fatalf("job on last attempt was not failed; retried = %v", store.retried)
		}
		if !slices.Equal(notifier.sent, []string{"1:failed"}) {
			t.Fatalf("notifications = %v; want [1:failed]", notifier.sent)
		}
	})
}

func TestPermanentErrorFailsWithoutRetry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1))

		stop := run(newPool(store, fail(jobs.Permanent(errors.New("not a video"))), &fakeNotifier{}, testConfig()))
		synctest.Wait()
		stop()

		if _, ok := store.failed[1]; !ok {
			t.Fatal("permanent error did not fail the job")
		}
		if len(store.retried) != 0 {
			t.Fatalf("retried = %v; want none", store.retried)
		}
	})
}

func TestJobOverAttemptLimitFailsWithoutProcessing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := testConfig()
		store := newFakeStore(job(1, cfg.MaxAttempts+1))
		called := false
		proc := processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) {
			called = true
			return jobs.Result{}, nil
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, cfg))
		synctest.Wait()
		stop()

		if called {
			t.Fatal("job over the attempt limit was processed")
		}
		if _, ok := store.failed[1]; !ok {
			t.Fatal("job over the attempt limit was not failed")
		}
	})
}

func TestRunsAtMostWorkersJobsAtOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1), job(2, 1), job(3, 1), job(4, 1), job(5, 1))
		var mu sync.Mutex
		running, peak := 0, 0
		release := make(chan struct{})
		proc := processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) {
			mu.Lock()
			running++
			peak = max(peak, running)
			mu.Unlock()
			<-release
			mu.Lock()
			running--
			mu.Unlock()
			return jobs.Result{}, nil
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, testConfig()))
		synctest.Wait()

		mu.Lock()
		if running != 2 {
			t.Fatalf("running = %d; want 2", running)
		}
		mu.Unlock()
		// Третью задачу загрузчик уже взял и ждёт свободного воркера.
		store.mu.Lock()
		if store.claims != 3 {
			t.Fatalf("claims = %d; want 3", store.claims)
		}
		store.mu.Unlock()

		close(release)
		synctest.Wait()
		stop()

		if peak != 2 {
			t.Fatalf("peak concurrency = %d; want 2", peak)
		}
		if len(store.completed) != 5 {
			t.Fatalf("completed %d jobs; want 5", len(store.completed))
		}
	})
}

func TestShutdownWaitsForRunningJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1))
		proc := processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) {
			time.Sleep(30 * time.Second)
			return jobs.Result{Width: 1}, nil
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, testConfig()))
		synctest.Wait()
		start := time.Now()
		stop()

		if waited := time.Since(start); waited != 30*time.Second {
			t.Fatalf("shutdown returned after %v; want 30s", waited)
		}
		if _, ok := store.completed[1]; !ok {
			t.Fatal("running job was not completed during shutdown")
		}
	})
}

func TestShutdownTimeoutCancelsAndReleasesJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := testConfig()
		store := newFakeStore(job(1, 1))
		proc := processorFunc(func(ctx context.Context, _ jobs.Job) (jobs.Result, error) {
			<-ctx.Done()
			return jobs.Result{}, ctx.Err()
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, cfg))
		synctest.Wait()
		start := time.Now()
		stop()

		if waited := time.Since(start); waited != cfg.ShutdownTimeout {
			t.Fatalf("shutdown returned after %v; want %v", waited, cfg.ShutdownTimeout)
		}
		if !slices.Equal(store.released, []int64{1}) {
			t.Fatalf("released = %v; want [1]", store.released)
		}
		if len(store.retried) != 0 || len(store.failed) != 0 {
			t.Fatalf("retried = %v, failed = %v; want none", store.retried, store.failed)
		}
	})
}

func TestShutdownReleasesJobHeldByDispatcher(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := testConfig()
		cfg.Workers = 1
		store := newFakeStore(job(1, 1), job(2, 1))
		proc := processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) {
			time.Sleep(time.Second)
			return jobs.Result{}, nil
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, cfg))
		synctest.Wait()
		stop()

		if _, ok := store.completed[1]; !ok {
			t.Fatal("running job was not completed")
		}
		if !slices.Equal(store.released, []int64{2}) {
			t.Fatalf("released = %v; want [2]", store.released)
		}
	})
}

func TestHeartbeatExtendsLease(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1))
		proc := processorFunc(func(context.Context, jobs.Job) (jobs.Result, error) {
			time.Sleep(70 * time.Second)
			return jobs.Result{}, nil
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, testConfig()))
		time.Sleep(71 * time.Second)
		synctest.Wait()
		stop()

		if store.extended != 3 {
			t.Fatalf("lease extended %d times in 70s; want 3", store.extended)
		}
	})
}

func TestLostLeaseCancelsJobWithoutTouchingIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1))
		store.extendErr = jobs.ErrLeaseLost
		proc := processorFunc(func(ctx context.Context, _ jobs.Job) (jobs.Result, error) {
			<-ctx.Done()
			return jobs.Result{}, ctx.Err()
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, testConfig()))
		time.Sleep(time.Minute)
		synctest.Wait()
		stop()

		if len(store.completed)+len(store.retried)+len(store.failed)+len(store.released) != 0 {
			t.Fatalf("job with lost lease was touched: completed=%v retried=%v failed=%v released=%v",
				store.completed, store.retried, store.failed, store.released)
		}
	})
}

func TestJobTimeoutIsRetried(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := testConfig()
		cfg.HeartbeatEvery = time.Hour
		store := newFakeStore(job(1, 1))
		proc := processorFunc(func(ctx context.Context, _ jobs.Job) (jobs.Result, error) {
			<-ctx.Done()
			return jobs.Result{}, ctx.Err()
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, cfg))
		time.Sleep(cfg.JobTimeout + time.Second)
		synctest.Wait()
		stop()

		if _, ok := store.retried[1]; !ok {
			t.Fatalf("timed out job was not retried; failed = %v, released = %v", store.failed, store.released)
		}
	})
}

func TestClaimErrorDoesNotStopPool(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(1, 1))
		store.claimErr = errors.New("connection refused")

		stop := run(newPool(store, succeed(jobs.Result{}), &fakeNotifier{}, testConfig()))
		synctest.Wait()

		store.mu.Lock()
		store.claimErr = nil
		store.mu.Unlock()
		time.Sleep(time.Minute)
		synctest.Wait()
		stop()

		if _, ok := store.completed[1]; !ok {
			t.Fatal("pool did not recover after claim error")
		}
	})
}

func TestClaimBackoffStaysBoundedDuringLongOutage(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore()
		store.claimErr = errors.New("connection refused")

		stop := run(newPool(store, succeed(jobs.Result{}), &fakeNotifier{}, testConfig()))
		time.Sleep(time.Hour)
		synctest.Wait()
		stop()

		// Пауза растёт до 30 с и дальше не меняется: за час около 120 попыток.
		if store.claimCalls > 130 {
			t.Fatalf("claimed %d times during an hour of outage; want about 120", store.claimCalls)
		}
	})
}

func TestProcessorRunsWithJobLabel(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store := newFakeStore(job(42, 1))
		var label string
		proc := processorFunc(func(ctx context.Context, _ jobs.Job) (jobs.Result, error) {
			label, _ = pprof.Label(ctx, "media_job")
			return jobs.Result{}, nil
		})

		stop := run(newPool(store, proc, &fakeNotifier{}, testConfig()))
		synctest.Wait()
		stop()

		if label != "42" {
			t.Fatalf("pprof label media_job = %q; want 42", label)
		}
	})
}
