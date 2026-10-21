// Команда media-worker обрабатывает видео, загруженные на сайт: берёт
// задачи из media_jobs, делает MP4 720p/480p, HLS и превью с выровненной
// громкостью, кладёт всё в S3 и сообщает сайту через Centrifugo.
//
//	go run ./cmd/media-worker -env ../.env
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/TwelfthDannis/streamer-web/worker/internal/config"
	"github.com/TwelfthDannis/streamer-web/worker/internal/debug"
	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
	"github.com/TwelfthDannis/streamer-web/worker/internal/notify"
	"github.com/TwelfthDannis/streamer-web/worker/internal/pool"
	"github.com/TwelfthDannis/streamer-web/worker/internal/storage"
	"github.com/TwelfthDannis/streamer-web/worker/internal/transcode"
)

func main() {
	envFile := flag.String("env", "", "дополнить окружение переменными из .env (заданные явно не меняются)")
	flag.Parse()

	log := newLogger(os.Getenv("WORKER_LOG_FORMAT"))

	if *envFile != "" {
		if err := config.LoadDotenv(*envFile); err != nil {
			log.Error("не удалось прочитать .env", "err", err)
			os.Exit(1)
		}
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Error("неверная конфигурация", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// После первого сигнала обработчик снимается: второй Ctrl+C завершит
	// процесс сразу, не дожидаясь начатых задач.
	context.AfterFunc(ctx, stop)

	if err := run(ctx, cfg, log); err != nil {
		log.Error("воркер остановился с ошибкой", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	ffmpeg, err := exec.LookPath(cfg.FFmpeg)
	if err != nil {
		return fmt.Errorf("ffmpeg: %w", err)
	}
	ffprobe, err := exec.LookPath(cfg.FFprobe)
	if err != nil {
		return fmt.Errorf("ffprobe: %w", err)
	}

	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect postgres: %w", err)
	}
	defer db.Close()
	pingCtx, cancelPing := context.WithTimeout(ctx, 10*time.Second)
	err = db.Ping(pingCtx)
	cancelPing()
	if err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	s3, err := storage.NewS3(cfg.S3)
	if err != nil {
		return err
	}

	var notifier pool.Notifier = notify.Noop{}
	if cfg.CentrifugoURL != "" {
		notifier = notify.NewCentrifugo(cfg.CentrifugoURL, cfg.CentrifugoKey)
	} else {
		log.Warn("Centrifugo не настроен: о готовности сайт узнает только из базы")
	}

	ln, err := net.Listen("tcp", cfg.DebugAddr)
	if err != nil {
		return fmt.Errorf("debug listener: %w", err)
	}
	debugSrv := &http.Server{Handler: debug.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := debugSrv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			log.Error("служебный HTTP упал", "err", err)
		}
	}()
	log.Info("pprof доступен", "url", "http://"+ln.Addr().String()+"/debug/pprof/")

	host, _ := os.Hostname()
	workerID := fmt.Sprintf("%s:%d", host, os.Getpid())

	workers := pool.New(
		jobs.NewStore(db, workerID, cfg.Lease),
		transcode.NewProcessor(s3, transcode.Config{
			FFmpeg:      ffmpeg,
			FFprobe:     ffprobe,
			TempDir:     cfg.TempDir,
			Preset:      cfg.Preset,
			MaxDuration: cfg.MaxDuration,
		}),
		notifier,
		pool.Config{
			Workers:         cfg.Workers,
			MaxAttempts:     cfg.MaxAttempts,
			PollInterval:    cfg.PollInterval,
			HeartbeatEvery:  cfg.Lease / 4,
			JobTimeout:      cfg.JobTimeout,
			ShutdownTimeout: cfg.ShutdownTimeout,
		},
		log,
	)

	log.Info("воркер запущен", "worker", workerID, "workers", cfg.Workers)
	context.AfterFunc(ctx, func() {
		log.Info("остановка: новые задачи не берём, ждём начатые", "timeout", cfg.ShutdownTimeout)
	})
	workers.Run(ctx)

	// pprof живёт до самого конца: зависшую остановку тоже надо уметь разглядеть.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := debugSrv.Shutdown(shutdownCtx); err != nil {
		log.Warn("служебный HTTP не остановился", "err", err)
	}
	log.Info("воркер остановлен")
	return nil
}

func newLogger(format string) *slog.Logger {
	if format == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, nil))
}
