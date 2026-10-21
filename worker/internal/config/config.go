// Package config читает настройки из окружения. Общие с сайтом переменные
// называются так же, как в .env.example, поэтому локально хватает одного
// файла .env на оба процесса.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/storage"
)

type Config struct {
	DatabaseURL string
	S3          storage.S3Config

	// Пустой адрес — уведомлений нет, сайт узнаёт о готовности из базы.
	CentrifugoURL string
	CentrifugoKey string

	MaxDuration time.Duration

	Workers         int
	MaxAttempts     int
	PollInterval    time.Duration
	Lease           time.Duration
	JobTimeout      time.Duration
	ShutdownTimeout time.Duration

	// DebugAddr — net/http/pprof и /healthz. По умолчанию только localhost:
	// профили раскрывают устройство процесса, наружу им незачем.
	DebugAddr string

	FFmpeg, FFprobe string
	Preset          string
	TempDir         string
}

// Load собирает конфигурацию и сразу перечисляет все ошибки: чинить .env
// по одной переменной за запуск утомительно.
func Load(getenv func(string) string) (Config, error) {
	r := reader{getenv: getenv}

	cfg := Config{
		DatabaseURL: r.required("DATABASE_URL"),
		S3: storage.S3Config{
			Endpoint:  r.required("S3_ENDPOINT"),
			Region:    r.required("S3_REGION"),
			Bucket:    r.required("S3_BUCKET"),
			AccessKey: r.required("S3_ACCESS_KEY_ID"),
			SecretKey: r.required("S3_SECRET_ACCESS_KEY"),
		},
		CentrifugoURL: getenv("CENTRIFUGO_API_URL"),
		CentrifugoKey: getenv("CENTRIFUGO_API_KEY"),

		MaxDuration: time.Duration(r.positiveInt("MAX_VIDEO_DURATION_SEC", 60)) * time.Second,

		Workers:         r.positiveInt("WORKER_CONCURRENCY", 2),
		MaxAttempts:     r.positiveInt("WORKER_MAX_ATTEMPTS", 5),
		PollInterval:    r.duration("WORKER_POLL_INTERVAL", time.Second),
		Lease:           r.duration("WORKER_LEASE", 2*time.Minute),
		JobTimeout:      r.duration("WORKER_JOB_TIMEOUT", 10*time.Minute),
		ShutdownTimeout: r.duration("WORKER_SHUTDOWN_TIMEOUT", time.Minute),
		DebugAddr:       r.str("WORKER_DEBUG_ADDR", "127.0.0.1:6060"),

		FFmpeg:  r.str("FFMPEG_PATH", "ffmpeg"),
		FFprobe: r.str("FFPROBE_PATH", "ffprobe"),
		Preset:  r.str("WORKER_X264_PRESET", "veryfast"),
		TempDir: getenv("WORKER_TMP_DIR"),
	}

	if (cfg.CentrifugoURL == "") != (cfg.CentrifugoKey == "") {
		r.errs = append(r.errs, errors.New("CENTRIFUGO_API_URL and CENTRIFUGO_API_KEY must be set together"))
	}
	return cfg, errors.Join(r.errs...)
}

type reader struct {
	getenv func(string) string
	errs   []error
}

func (r *reader) required(key string) string {
	v := r.getenv(key)
	if v == "" {
		r.errs = append(r.errs, fmt.Errorf("%s is required", key))
	}
	return v
}

func (r *reader) str(key, fallback string) string {
	if v := r.getenv(key); v != "" {
		return v
	}
	return fallback
}

func (r *reader) positiveInt(key string, fallback int) int {
	v := r.getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		r.errs = append(r.errs, fmt.Errorf("%s=%q: want a positive integer", key, v))
		return fallback
	}
	return n
}

func (r *reader) duration(key string, fallback time.Duration) time.Duration {
	v := r.getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		r.errs = append(r.errs, fmt.Errorf("%s=%q: want a positive duration like 90s", key, v))
		return fallback
	}
	return d
}

// LoadDotenv дописывает в окружение переменные из файла. Уже заданные не
// трогает: явное окружение важнее файла, как у node --env-file.
func LoadDotenv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	vars, err := parseDotenv(f)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	for k, v := range vars {
		if _, set := os.LookupEnv(k); !set {
			if err := os.Setenv(k, v); err != nil {
				return err
			}
		}
	}
	return nil
}

func parseDotenv(r io.Reader) (map[string]string, error) {
	vars := map[string]string{}
	scanner := bufio.NewScanner(r)
	for n := 1; scanner.Scan(); n++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: want KEY=value", n)
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		vars[strings.TrimSpace(key)] = value
	}
	return vars, scanner.Err()
}
