package transcode

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
	"github.com/TwelfthDannis/streamer-web/worker/internal/storage"
)

type dirStorage struct {
	mu       sync.Mutex
	sources  map[string]string
	dir      string
	uploaded map[string]string
}

func newDirStorage(t *testing.T) *dirStorage {
	return &dirStorage{sources: map[string]string{}, dir: t.TempDir(), uploaded: map[string]string{}}
}

func (s *dirStorage) Download(_ context.Context, key, path string) error {
	s.mu.Lock()
	src, ok := s.sources[key]
	s.mu.Unlock()
	if !ok {
		return storage.ErrNotFound
	}
	return copyFile(src, path)
}

func (s *dirStorage) Upload(_ context.Context, key, path, contentType string) error {
	dst := filepath.Join(s.dir, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := copyFile(path, dst); err != nil {
		return err
	}
	s.mu.Lock()
	s.uploaded[key] = contentType
	s.mu.Unlock()
	return nil
}

func (s *dirStorage) path(key string) string {
	return filepath.Join(s.dir, filepath.FromSlash(key))
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func requireFFmpeg(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not found in PATH", bin)
		}
	}
}

// makeClip генерирует ролик тестовой таблицы. Громкость синуса задаётся в
// децибелах: тихий исходник проверяет, что нормализация действительно тянет
// звук к цели, а не просто копирует дорожку.
func makeClip(t *testing.T, width, height int, seconds float64, volumeDB float64, withAudio bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), fmt.Sprintf("clip_%dx%d.mp4", width, height))
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=30:duration=%g", width, height, seconds)}
	if withAudio {
		args = append(args, "-f", "lavfi", "-i",
			fmt.Sprintf("sine=frequency=440:sample_rate=44100:duration=%g,volume=%gdB", seconds, volumeDB))
	}
	args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
	if withAudio {
		args = append(args, "-c:a", "aac", "-shortest")
	}
	args = append(args, path)

	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("make clip: %v\n%s", err, out)
	}
	return path
}

func testProcessor(storage Storage) *Processor {
	return NewProcessor(storage, Config{
		FFmpeg:      "ffmpeg",
		FFprobe:     "ffprobe",
		Preset:      "ultrafast",
		MaxDuration: time.Minute,
	})
}

func probeFile(t *testing.T, path string) Source {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	src, err := parseProbe(out)
	if err != nil {
		t.Fatalf("parse probe of %s: %v", path, err)
	}
	return src
}

func integratedLoudness(t *testing.T, path string) float64 {
	t.Helper()
	out, _ := exec.Command("ffmpeg", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0",
		"-af", analyzeFilter, "-f", "null", "-").CombinedOutput()
	l, err := parseLoudnorm(out)
	if err != nil {
		t.Fatalf("measure loudness of %s: %v\n%s", path, err, out)
	}
	v, err := strconv.ParseFloat(l.I, 64)
	if err != nil {
		t.Fatalf("loudness of %s = %q", path, l.I)
	}
	return v
}

func videoJob(storageKey string) jobs.Job {
	return jobs.Job{ID: 7, MediaID: "0199f0aa-0000-7000-8000-000000000001", Attempt: 1, OwnerID: "user-1", StorageKey: storageKey}
}

func TestProcessLandscapeVideo(t *testing.T) {
	requireFFmpeg(t)
	storage := newDirStorage(t)
	job := videoJob("media/user-1/source.mp4")
	storage.sources[job.StorageKey] = makeClip(t, 1920, 1080, 5, -35, true)

	res, err := testProcessor(storage).Process(t.Context(), job)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}

	prefix := "media/user-1/" + job.MediaID + "/"
	wantVariants := jobs.Variants{
		HLS:    prefix + "hls/master.m3u8",
		MP4720: prefix + "720p.mp4",
		MP4480: prefix + "480p.mp4",
		Poster: prefix + "poster.jpg",
	}
	if res.Variants != wantVariants {
		t.Fatalf("variants = %+v; want %+v", res.Variants, wantVariants)
	}
	if res.Width != 1920 || res.Height != 1080 {
		t.Errorf("result size = %dx%d; want 1920x1080", res.Width, res.Height)
	}
	if res.DurationMs < 4900 || res.DurationMs > 5100 {
		t.Errorf("result duration = %d ms; want about 5000", res.DurationMs)
	}

	for key, want := range map[string]Source{
		res.Variants.MP4720: {Width: 1280, Height: 720, HasAudio: true},
		res.Variants.MP4480: {Width: 854, Height: 480, HasAudio: true},
	} {
		got := probeFile(t, storage.path(key))
		if got.Width != want.Width || got.Height != want.Height || !got.HasAudio {
			t.Errorf("%s = %+v; want %dx%d with audio", key, got, want.Width, want.Height)
		}
		if lufs := integratedLoudness(t, storage.path(key)); lufs < -17.5 || lufs > -14.5 {
			t.Errorf("%s loudness = %.2f LUFS; want about -16", key, lufs)
		}
	}

	master, err := os.ReadFile(storage.path(res.Variants.HLS))
	if err != nil {
		t.Fatalf("read master playlist: %v", err)
	}
	for _, want := range []string{"RESOLUTION=1280x720", "RESOLUTION=854x480", "720p/index.m3u8", "480p/index.m3u8"} {
		if !strings.Contains(string(master), want) {
			t.Errorf("master playlist lacks %q:\n%s", want, master)
		}
	}
	if hls := probeFile(t, storage.path(res.Variants.HLS)); hls.Width != 1280 {
		t.Errorf("HLS master does not play: %+v", hls)
	}

	wantTypes := map[string]string{
		".m3u8": "application/vnd.apple.mpegurl",
		".m4s":  "video/iso.segment",
		".mp4":  "video/mp4",
		".jpg":  "image/jpeg",
	}
	for key, contentType := range storage.uploaded {
		if !strings.HasPrefix(key, prefix) {
			t.Errorf("uploaded %s outside of %s", key, prefix)
		}
		if want := wantTypes[filepath.Ext(key)]; contentType != want {
			t.Errorf("%s uploaded as %q; want %q", key, contentType, want)
		}
	}

	poster := probeFile(t, storage.path(res.Variants.Poster))
	if poster.Width != 1280 || poster.Height != 720 {
		t.Errorf("poster = %dx%d; want 1280x720", poster.Width, poster.Height)
	}
}

func TestProcessSmallPortraitVideoWithoutAudio(t *testing.T) {
	requireFFmpeg(t)
	storage := newDirStorage(t)
	job := videoJob("media/user-1/source.mp4")
	storage.sources[job.StorageKey] = makeClip(t, 360, 640, 2, 0, false)

	res, err := testProcessor(storage).Process(t.Context(), job)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}

	if res.Variants.MP4720 != res.Variants.MP4480 {
		t.Errorf("small video has two different rungs: %+v", res.Variants)
	}
	got := probeFile(t, storage.path(res.Variants.MP4480))
	if got.Width != 360 || got.Height != 640 || got.HasAudio {
		t.Errorf("480p rung = %+v; want 360x640 without audio", got)
	}

	master, err := os.ReadFile(storage.path(res.Variants.HLS))
	if err != nil {
		t.Fatalf("read master playlist: %v", err)
	}
	if n := strings.Count(string(master), "#EXT-X-STREAM-INF"); n != 1 {
		t.Errorf("master playlist has %d variants; want 1:\n%s", n, master)
	}
}

// Телефон пишет кадры боком и кладёт поворот в метаданные. Исходник —
// белая левая половина и чёрная правая, повёрнутые на 90°: если поворот
// применён, половины в результате окажутся сверху и снизу.
func TestProcessAppliesPhoneRotation(t *testing.T) {
	requireFFmpeg(t)
	dir := t.TempDir()
	flat := filepath.Join(dir, "flat.mp4")
	rotated := filepath.Join(dir, "rotated.mp4")
	for _, args := range [][]string{
		{"-f", "lavfi", "-i", "color=white:size=640x720:duration=1", "-f", "lavfi", "-i", "color=black:size=640x720:duration=1",
			"-filter_complex", "hstack", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", flat},
		{"-display_rotation", "90", "-i", flat, "-c", "copy", rotated},
	} {
		if out, err := exec.Command("ffmpeg", append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("make rotated clip: %v\n%s", err, out)
		}
	}

	storage := newDirStorage(t)
	job := videoJob("media/user-1/rotated.mp4")
	storage.sources[job.StorageKey] = rotated

	res, err := testProcessor(storage).Process(t.Context(), job)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if res.Width != 720 || res.Height != 1280 {
		t.Fatalf("result size = %dx%d; want 720x1280", res.Width, res.Height)
	}

	// Первый кадр как он лежит в файле, без поворота при чтении, ужатый
	// до 2×2 в оттенках серого: [верх-лево, верх-право, низ-лево, низ-право].
	px, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-noautorotate", "-i", storage.path(res.Variants.MP4720), "-frames:v", "1",
		"-vf", "scale=2:2:flags=area,format=gray", "-f", "rawvideo", "-").Output()
	if err != nil || len(px) != 4 {
		t.Fatalf("sample poster: %v, %d bytes", err, len(px))
	}
	topBottom := absDiff(px[0], px[2]) > 100 && absDiff(px[1], px[3]) > 100
	leftRight := absDiff(px[0], px[1]) > 100
	if !topBottom || leftRight {
		t.Fatalf("frame pixels %v: halves are not stacked vertically, rotation was not applied", px)
	}
}

func absDiff(a, b byte) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

func TestProcessSilentVideoKeepsAudio(t *testing.T) {
	requireFFmpeg(t)
	storage := newDirStorage(t)
	job := videoJob("media/user-1/source.mp4")
	storage.sources[job.StorageKey] = makeClip(t, 640, 480, 2, -120, true)

	res, err := testProcessor(storage).Process(t.Context(), job)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if got := probeFile(t, storage.path(res.Variants.MP4480)); !got.HasAudio {
		t.Error("silent audio track was dropped")
	}
}

func TestProcessRejectsGarbageAsPermanent(t *testing.T) {
	requireFFmpeg(t)
	storage := newDirStorage(t)
	garbage := filepath.Join(t.TempDir(), "garbage.mp4")
	if err := os.WriteFile(garbage, []byte("definitely not a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	job := videoJob("media/user-1/garbage.mp4")
	storage.sources[job.StorageKey] = garbage

	_, err := testProcessor(storage).Process(t.Context(), job)
	if !jobs.IsPermanent(err) {
		t.Fatalf("Process(garbage) error = %v; want permanent", err)
	}
}

// Сайт принимает mp4, mov и webm; webm идёт через другой демультиплексор.
func TestProcessWebmSource(t *testing.T) {
	requireFFmpeg(t)
	webm := filepath.Join(t.TempDir(), "clip.webm")
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1",
		"-f", "lavfi", "-i", "sine=duration=1",
		"-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus", "-shortest", webm).CombinedOutput(); err != nil {
		t.Fatalf("make webm: %v\n%s", err, out)
	}
	storage := newDirStorage(t)
	job := videoJob("media/user-1/clip.webm")
	storage.sources[job.StorageKey] = webm

	if _, err := testProcessor(storage).Process(t.Context(), job); err != nil {
		t.Fatalf("Process(webm): %v", err)
	}
}

// Тип файла сайту сообщает браузер, а ffmpeg определяет формат по
// содержимому. Картинка под видом video/mp4 не должна стать «видео».
func TestProcessRejectsContainerSiteDoesNotAllow(t *testing.T) {
	requireFFmpeg(t)
	png := filepath.Join(t.TempDir(), "image.png")
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=320x240", "-frames:v", "1", png).CombinedOutput(); err != nil {
		t.Fatalf("make png: %v\n%s", err, out)
	}
	storage := newDirStorage(t)
	job := videoJob("media/user-1/not-a-video.mp4")
	storage.sources[job.StorageKey] = png

	_, err := testProcessor(storage).Process(t.Context(), job)
	if !jobs.IsPermanent(err) {
		t.Fatalf("Process(png as mp4) error = %v; want permanent", err)
	}
}

func TestProcessRejectsMissingSourceAsPermanent(t *testing.T) {
	requireFFmpeg(t)
	_, err := testProcessor(newDirStorage(t)).Process(t.Context(), videoJob("media/user-1/missing.mp4"))
	if !jobs.IsPermanent(err) {
		t.Fatalf("Process(missing) error = %v; want permanent", err)
	}
}

func TestProcessRejectsTooLongVideoAsPermanent(t *testing.T) {
	requireFFmpeg(t)
	storage := newDirStorage(t)
	job := videoJob("media/user-1/long.mp4")
	storage.sources[job.StorageKey] = makeClip(t, 320, 240, 5, 0, false)

	p := testProcessor(storage)
	p.cfg.MaxDuration = 2 * time.Second

	_, err := p.Process(t.Context(), job)
	if !jobs.IsPermanent(err) || !errors.Is(err, ErrTooLong) {
		t.Fatalf("Process(too long) error = %v; want permanent ErrTooLong", err)
	}
}

func TestProcessStopsFFmpegOnCancel(t *testing.T) {
	requireFFmpeg(t)
	storage := newDirStorage(t)
	job := videoJob("media/user-1/source.mp4")
	storage.sources[job.StorageKey] = makeClip(t, 1920, 1080, 30, -20, true)

	p := testProcessor(storage)
	p.cfg.Preset = "veryslow"

	ctx, cancel := context.WithTimeout(t.Context(), 1500*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := p.Process(ctx, job)
	if err == nil {
		t.Fatal("Process finished a 30s veryslow encode in 1.5s; cancellation is not exercised")
	}
	if jobs.IsPermanent(err) {
		t.Fatalf("cancelled job reported as permanent: %v", err)
	}
	// Прерванный результат выбрасывается, поэтому ждать, пока ffmpeg
	// дожмёт буфер кодировщика, незачем: на veryslow это секунды.
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("Process returned %v after a 1.5s deadline; ffmpeg was not killed promptly", elapsed)
	}
}
