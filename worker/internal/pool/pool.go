// Package pool — загрузчик и пул воркеров. Загрузчик берёт задачи из очереди
// по одной и отдаёт их воркерам через небуферизованный канал: пока все
// воркеры заняты, он стоит на отправке и новых задач не арендует.
package pool

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/pprof"
	"strconv"
	"sync"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
)

// Store — очередь задач. Реализация для Postgres — jobs.Store.
type Store interface {
	Claim(ctx context.Context) (jobs.Job, bool, error)
	Extend(ctx context.Context, job jobs.Job) error
	Complete(ctx context.Context, job jobs.Job, res jobs.Result) error
	Retry(ctx context.Context, job jobs.Job, delay time.Duration, cause error) error
	Fail(ctx context.Context, job jobs.Job, cause error) error
	Release(ctx context.Context, job jobs.Job) error
}

// Processor делает с видео всю работу: ffmpeg, загрузку в хранилище.
type Processor interface {
	Process(ctx context.Context, job jobs.Job) (jobs.Result, error)
}

// Notifier сообщает сайту об итоге. База уже обновлена к этому моменту,
// поэтому ошибка уведомления только логируется.
type Notifier interface {
	Notify(ctx context.Context, job jobs.Job, status string) error
}

const (
	StatusReady  = "ready"
	StatusFailed = "failed"
)

type Config struct {
	Workers         int
	MaxAttempts     int
	PollInterval    time.Duration
	HeartbeatEvery  time.Duration
	JobTimeout      time.Duration
	ShutdownTimeout time.Duration
}

type Pool struct {
	store  Store
	proc   Processor
	notify Notifier
	cfg    Config
	log    *slog.Logger
}

func New(store Store, proc Processor, notify Notifier, cfg Config, log *slog.Logger) *Pool {
	return &Pool{store: store, proc: proc, notify: notify, cfg: cfg, log: log}
}

// Run работает до отмены ctx. После отмены новые задачи не берутся, а
// начатые дорабатывают; кто не успел за ShutdownTimeout, прерывается и
// возвращается в очередь без списания попытки.
func (p *Pool) Run(ctx context.Context) {
	work, hardStop := context.WithCancel(context.WithoutCancel(ctx))
	defer hardStop()

	queue := make(chan jobs.Job)
	var wg sync.WaitGroup
	for range p.cfg.Workers {
		wg.Go(func() { p.worker(work, queue) })
	}

	p.dispatch(ctx, queue)
	close(queue)

	drained := make(chan struct{})
	go func() {
		wg.Wait()
		close(drained)
	}()

	select {
	case <-drained:
	case <-time.After(p.cfg.ShutdownTimeout):
		p.log.Warn("задачи не успели доработать, прерываем", "timeout", p.cfg.ShutdownTimeout)
		hardStop()
		<-drained
	}
}

func (p *Pool) worker(work context.Context, queue <-chan jobs.Job) {
	for job := range queue {
		p.handle(work, job)
	}
}

func (p *Pool) dispatch(ctx context.Context, queue chan<- jobs.Job) {
	failures := 0
	for {
		job, ok, err := p.claim(ctx)
		if ctx.Err() != nil {
			if ok {
				p.release(job, p.jobLog(job))
			}
			return
		}

		if err != nil {
			failures++
			p.log.Error("не удалось взять задачу из очереди", "err", err)
			// Сдвиг ограничен: после ~34 неудач подряд он переполнил бы
			// Duration, пауза стала бы отрицательной и загрузчик долбил бы базу.
			if !sleep(ctx, min(p.cfg.PollInterval<<min(failures, 10), 30*time.Second)) {
				return
			}
			continue
		}
		failures = 0

		if !ok {
			if !sleep(ctx, p.cfg.PollInterval) {
				return
			}
			continue
		}

		select {
		case queue <- job:
		case <-ctx.Done():
			p.release(job, p.jobLog(job))
			return
		}
	}
}

// claim не наследует отмену: прерванный на полпути запрос мог успеть
// арендовать задачу, и тогда она висела бы до конца аренды.
func (p *Pool) claim(ctx context.Context) (jobs.Job, bool, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	return p.store.Claim(ctx)
}

func (p *Pool) handle(work context.Context, job jobs.Job) {
	log := p.jobLog(job)

	if job.Attempt > p.cfg.MaxAttempts {
		p.fail(job, fmt.Errorf("attempt %d exceeds limit %d", job.Attempt, p.cfg.MaxAttempts), log)
		return
	}

	leased, loseLease := context.WithCancelCause(work)
	defer loseLease(nil)
	ctx, cancel := context.WithTimeout(leased, p.cfg.JobTimeout)
	defer cancel()

	stopHeartbeat := p.heartbeat(ctx, job, loseLease, log)

	var res jobs.Result
	var err error
	labels := pprof.Labels("media_job", strconv.FormatInt(job.ID, 10))
	pprof.Do(ctx, labels, func(ctx context.Context) {
		res, err = p.proc.Process(ctx, job)
	})
	stopHeartbeat()

	switch {
	case errors.Is(context.Cause(leased), jobs.ErrLeaseLost):
		log.Warn("аренду задачи перехватили, результат отброшен")
	case err == nil:
		p.complete(job, res, log)
	case work.Err() != nil:
		p.release(job, log)
	case jobs.IsPermanent(err), job.Attempt >= p.cfg.MaxAttempts:
		p.fail(job, err, log)
	default:
		p.retry(job, err, log)
	}
}

func (p *Pool) heartbeat(ctx context.Context, job jobs.Job, loseLease context.CancelCauseFunc, log *slog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})

	go func() {
		defer close(done)
		ticker := time.NewTicker(p.cfg.HeartbeatEvery)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				err := p.store.Extend(ctx, job)
				if errors.Is(err, jobs.ErrLeaseLost) {
					loseLease(jobs.ErrLeaseLost)
					return
				}
				if err != nil && ctx.Err() == nil {
					log.Warn("не удалось продлить аренду", "err", err)
				}
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}

func (p *Pool) complete(job jobs.Job, res jobs.Result, log *slog.Logger) {
	ctx, cancel := bookkeeping()
	defer cancel()

	// Если запись не прошла, аренда истечёт и видео обработается заново:
	// ключи результатов те же, повтор просто перезапишет файлы.
	if err := p.store.Complete(ctx, job, res); err != nil {
		log.Error("не удалось сохранить результат", "err", err)
		return
	}
	log.Info("видео обработано", "width", res.Width, "height", res.Height)
	p.sendNotification(ctx, job, StatusReady, log)
}

func (p *Pool) fail(job jobs.Job, cause error, log *slog.Logger) {
	ctx, cancel := bookkeeping()
	defer cancel()

	if err := p.store.Fail(ctx, job, cause); err != nil {
		log.Error("не удалось пометить задачу проваленной", "err", err, "cause", cause)
		return
	}
	log.Error("видео не обработано", "err", cause)
	p.sendNotification(ctx, job, StatusFailed, log)
}

func (p *Pool) retry(job jobs.Job, cause error, log *slog.Logger) {
	ctx, cancel := bookkeeping()
	defer cancel()

	delay := Backoff(job.Attempt)
	if err := p.store.Retry(ctx, job, delay, cause); err != nil {
		log.Error("не удалось вернуть задачу в очередь", "err", err, "cause", cause)
		return
	}
	log.Warn("попытка не удалась, повторим", "err", cause, "delay", delay)
}

func (p *Pool) release(job jobs.Job, log *slog.Logger) {
	ctx, cancel := bookkeeping()
	defer cancel()

	if err := p.store.Release(ctx, job); err != nil {
		log.Error("не удалось вернуть задачу в очередь", "err", err)
		return
	}
	log.Info("задача возвращена в очередь")
}

func (p *Pool) sendNotification(ctx context.Context, job jobs.Job, status string, log *slog.Logger) {
	if err := p.notify.Notify(ctx, job, status); err != nil {
		log.Warn("не удалось уведомить сайт", "err", err, "status", status)
	}
}

func (p *Pool) jobLog(job jobs.Job) *slog.Logger {
	return p.log.With("job", job.ID, "media", job.MediaID, "attempt", job.Attempt)
}

// Backoff — пауза перед следующей попыткой: 15 с, 1 мин, 4 мин, дальше 15 мин.
func Backoff(attempt int) time.Duration {
	const ceiling = 15 * time.Minute
	d := 15 * time.Second
	for range attempt - 1 {
		d *= 4
		if d >= ceiling {
			return ceiling
		}
	}
	return d
}

// bookkeeping — контекст для записи итога. Он не зависит от остановки:
// итог уже посчитан, и потерять его из-за Ctrl+C было бы обидно.
func bookkeeping() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
