package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

func env(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func required() map[string]string {
	return map[string]string{
		"DATABASE_URL":         "postgres://streamer:streamer@localhost:5433/streamer",
		"S3_ENDPOINT":          "http://localhost:9000",
		"S3_REGION":            "ru-central1",
		"S3_BUCKET":            "streamer-media",
		"S3_ACCESS_KEY_ID":     "minioadmin",
		"S3_SECRET_ACCESS_KEY": "minioadmin",
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(required()))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.S3.Bucket != "streamer-media" || cfg.S3.Endpoint != "http://localhost:9000" {
		t.Errorf("S3 = %+v", cfg.S3)
	}
	checks := []struct {
		name      string
		got, want any
	}{
		{"Workers", cfg.Workers, 2},
		{"MaxAttempts", cfg.MaxAttempts, 5},
		{"MaxDuration", cfg.MaxDuration, 60 * time.Second},
		{"PollInterval", cfg.PollInterval, time.Second},
		{"Lease", cfg.Lease, 2 * time.Minute},
		{"JobTimeout", cfg.JobTimeout, 10 * time.Minute},
		{"ShutdownTimeout", cfg.ShutdownTimeout, time.Minute},
		{"DebugAddr", cfg.DebugAddr, "127.0.0.1:6060"},
		{"Preset", cfg.Preset, "veryfast"},
		{"FFmpeg", cfg.FFmpeg, "ffmpeg"},
		{"FFprobe", cfg.FFprobe, "ffprobe"},
		{"CentrifugoURL", cfg.CentrifugoURL, ""},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v; want %v", c.name, c.got, c.want)
		}
	}
}

func TestLoadOverrides(t *testing.T) {
	vars := required()
	vars["WORKER_CONCURRENCY"] = "4"
	vars["WORKER_SHUTDOWN_TIMEOUT"] = "90s"
	vars["MAX_VIDEO_DURATION_SEC"] = "30"
	vars["WORKER_DEBUG_ADDR"] = "0.0.0.0:7070"
	vars["CENTRIFUGO_API_URL"] = "http://localhost:8000/api"
	vars["CENTRIFUGO_API_KEY"] = "key"

	cfg, err := Load(env(vars))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Workers != 4 || cfg.ShutdownTimeout != 90*time.Second || cfg.MaxDuration != 30*time.Second ||
		cfg.DebugAddr != "0.0.0.0:7070" || cfg.CentrifugoURL != "http://localhost:8000/api" || cfg.CentrifugoKey != "key" {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
}

func TestLoadReportsMissingVariables(t *testing.T) {
	vars := required()
	delete(vars, "DATABASE_URL")
	delete(vars, "S3_BUCKET")

	_, err := Load(env(vars))
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") || !strings.Contains(err.Error(), "S3_BUCKET") {
		t.Fatalf("Load error = %v; want both missing variables named", err)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	for key, value := range map[string]string{
		"WORKER_CONCURRENCY":      "zero",
		"WORKER_SHUTDOWN_TIMEOUT": "soon",
		"WORKER_MAX_ATTEMPTS":     "0",
		"CENTRIFUGO_API_URL":      "http://localhost:8000/api",
	} {
		vars := required()
		vars[key] = value
		if _, err := Load(env(vars)); err == nil {
			t.Errorf("Load accepted %s=%q", key, value)
		}
	}
}

func TestParseDotenv(t *testing.T) {
	src := `# --- База данных ---
DATABASE_URL="postgres://streamer:streamer@localhost:5433/streamer"
# DATABASE_URL_UNPOOLED=""
S3_BUCKET=streamer-media
export WORKER_CONCURRENCY='3'

EMPTY=""
`
	got, err := parseDotenv(strings.NewReader(src))
	if err != nil {
		t.Fatalf("parseDotenv: %v", err)
	}
	want := map[string]string{
		"DATABASE_URL":       "postgres://streamer:streamer@localhost:5433/streamer",
		"S3_BUCKET":          "streamer-media",
		"WORKER_CONCURRENCY": "3",
		"EMPTY":              "",
	}
	if len(got) != len(want) {
		t.Fatalf("parseDotenv = %v; want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q; want %q", k, got[k], v)
		}
	}
}

func TestLoadDotenvKeepsExistingEnvironment(t *testing.T) {
	path := t.TempDir() + "/.env"
	if err := os.WriteFile(path, []byte("WORKER_TEST_A=from-file\nWORKER_TEST_B=from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WORKER_TEST_A", "from-env")

	if err := LoadDotenv(path); err != nil {
		t.Fatalf("LoadDotenv: %v", err)
	}
	t.Cleanup(func() { _ = os.Unsetenv("WORKER_TEST_B") })

	if got := os.Getenv("WORKER_TEST_A"); got != "from-env" {
		t.Errorf("WORKER_TEST_A = %q; want from-env", got)
	}
	if got := os.Getenv("WORKER_TEST_B"); got != "from-file" {
		t.Errorf("WORKER_TEST_B = %q; want from-file", got)
	}
}
