package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/config"
	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
	"github.com/TwelfthDannis/streamer-web/worker/internal/storage"
	"github.com/TwelfthDannis/streamer-web/worker/internal/testenv"
)

type publication struct {
	Channel string            `json:"channel"`
	Data    map[string]string `json:"data"`
}

// Путь целиком: сайт положил оригинал в MinIO и поставил задачу, воркер
// её забрал, обработал, записал результат и сообщил в Centrifugo, а потом
// корректно остановился по отмене контекста.
func TestWorkerProcessesUploadedVideo(t *testing.T) {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not found in PATH", bin)
		}
	}
	pool, dbURL := testenv.Database(t)
	owner := fmt.Sprintf("e2e-%d", time.Now().UnixNano())
	s3cfg := testenv.S3(t, "media/"+owner+"/")

	clip := filepath.Join(t.TempDir(), "clip.mp4")
	out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=3",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=3",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip).CombinedOutput()
	if err != nil {
		t.Fatalf("make clip: %v\n%s", err, out)
	}

	s3, err := storage.NewS3(s3cfg)
	if err != nil {
		t.Fatal(err)
	}
	sourceKey := "media/" + owner + "/source.mp4"
	if err := s3.Upload(t.Context(), sourceKey, clip, "video/mp4"); err != nil {
		t.Fatalf("upload source: %v", err)
	}
	mediaID := testenv.SeedVideo(t, pool, owner, sourceKey)

	published := make(chan publication, 4)
	centrifugo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p publication
		_ = json.NewDecoder(r.Body).Decode(&p)
		published <- p
		_, _ = io.WriteString(w, `{"result":{}}`)
	}))
	defer centrifugo.Close()

	cfg := config.Config{
		DatabaseURL:     dbURL,
		S3:              s3cfg,
		CentrifugoURL:   centrifugo.URL,
		CentrifugoKey:   "test",
		MaxDuration:     time.Minute,
		Workers:         2,
		MaxAttempts:     3,
		PollInterval:    100 * time.Millisecond,
		Lease:           time.Minute,
		JobTimeout:      time.Minute,
		ShutdownTimeout: 10 * time.Second,
		DebugAddr:       "127.0.0.1:0",
		FFmpeg:          "ffmpeg",
		FFprobe:         "ffprobe",
		Preset:          "ultrafast",
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- run(ctx, cfg, slog.New(slog.NewTextHandler(t.Output(), nil))) }()

	select {
	case p := <-published:
		want := publication{Channel: "media:" + owner, Data: map[string]string{"type": "media.processed", "mediaId": mediaID, "status": "ready"}}
		if p.Channel != want.Channel || p.Data["mediaId"] != mediaID || p.Data["status"] != "ready" || p.Data["type"] != "media.processed" {
			t.Fatalf("published %+v; want %+v", p, want)
		}
	case err := <-stopped:
		t.Fatalf("worker stopped before processing: %v", err)
	case <-time.After(time.Minute):
		t.Fatal("no notification within a minute")
	}

	cancel()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("run returned %v after shutdown", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("worker did not stop after cancel")
	}

	var (
		status string
		raw    []byte
	)
	err = pool.QueryRow(t.Context(), `SELECT processing_status::text, variants FROM media WHERE id = $1`, mediaID).Scan(&status, &raw)
	if err != nil {
		t.Fatal(err)
	}
	var variants jobs.Variants
	if err := json.Unmarshal(raw, &variants); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || variants.HLS == "" || variants.MP4720 == "" || variants.Poster == "" {
		t.Fatalf("media = %s %+v; want ready with all variants", status, variants)
	}

	for _, key := range []string{variants.HLS, variants.MP4720, variants.MP4480, variants.Poster} {
		if err := s3.Download(t.Context(), key, filepath.Join(t.TempDir(), filepath.Base(key))); err != nil {
			t.Errorf("result %s is not in storage: %v", key, err)
		}
	}
}

func TestRunFailsFastOnBadConfig(t *testing.T) {
	cfg := config.Config{DatabaseURL: "postgres://nobody@127.0.0.1:1/none", FFmpeg: "ffmpeg-that-does-not-exist", FFprobe: "ffprobe"}
	err := run(t.Context(), cfg, slog.New(slog.DiscardHandler))
	if err == nil {
		t.Fatal("run started with a missing ffmpeg binary")
	}
}
