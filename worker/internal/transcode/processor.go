// Package transcode превращает загруженное видео в то, что можно отдавать
// зрителям: MP4 720p/480p для ленты, HLS из тех же файлов, превью-кадр и
// звук, выровненный по громкости.
package transcode

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
	"github.com/TwelfthDannis/streamer-web/worker/internal/storage"
)

// Storage — откуда берётся оригинал и куда кладётся результат. Отсутствие
// объекта Download сообщает ошибкой storage.ErrNotFound.
type Storage interface {
	Download(ctx context.Context, key, path string) error
	Upload(ctx context.Context, key, path, contentType string) error
}

type Config struct {
	FFmpeg, FFprobe string
	// TempDir — где лежат рабочие файлы задачи; пусто — системный каталог.
	TempDir string
	// Preset — пресет libx264: быстрее кодирует, крупнее файл.
	Preset string
	// MaxDuration — тот же лимит, что у сайта (MAX_VIDEO_DURATION_SEC).
	// Длительность сайту сообщает браузер, поэтому проверяется ещё раз по факту.
	MaxDuration time.Duration
}

var ErrTooLong = errors.New("video is longer than allowed")

// Лимит длительности сайт проверяет по данным браузера, а контейнер
// может оказаться на долю секунды длиннее заявленного.
const durationSlack = time.Second

const uploadConcurrency = 4

// sourceGuard ставится перед каждым чтением исходника. ffmpeg определяет
// формат по содержимому, а не по типу, который заявил браузер, поэтому
// разрешены только контейнеры, которые принимает сайт (mp4/mov и webm), и
// только локальный файл: подложенный плейлист не уведёт ffmpeg в сеть.
var sourceGuard = []string{"-format_whitelist", "mov,matroska", "-protocol_whitelist", "file"}

type Processor struct {
	storage Storage
	cfg     Config
}

func NewProcessor(storage Storage, cfg Config) *Processor {
	return &Processor{storage: storage, cfg: cfg}
}

// Process обрабатывает одно видео. Ключи результатов зависят только от
// владельца и media, поэтому повтор задачи перезаписывает те же объекты.
func (p *Processor) Process(ctx context.Context, job jobs.Job) (jobs.Result, error) {
	dir, err := os.MkdirTemp(p.cfg.TempDir, fmt.Sprintf("media-job-%d-", job.ID))
	if err != nil {
		return jobs.Result{}, fmt.Errorf("create work dir: %w", err)
	}
	defer os.RemoveAll(dir)
	if dir, err = filepath.Abs(dir); err != nil {
		return jobs.Result{}, err
	}

	source := filepath.Join(dir, "source"+path.Ext(job.StorageKey))
	if err := p.storage.Download(ctx, job.StorageKey, source); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return jobs.Result{}, jobs.Permanent(err)
		}
		return jobs.Result{}, err
	}

	src, err := p.probe(ctx, source)
	if err != nil {
		return jobs.Result{}, err
	}
	if p.cfg.MaxDuration > 0 && src.Duration > p.cfg.MaxDuration+durationSlack {
		return jobs.Result{}, jobs.Permanent(fmt.Errorf("%w: %v > %v", ErrTooLong, src.Duration, p.cfg.MaxDuration))
	}

	var loudness *Loudness
	if src.HasAudio {
		l, err := p.measureLoudness(ctx, source)
		if err != nil {
			return jobs.Result{}, err
		}
		if !l.Silent() {
			loudness = &l
		}
	}

	out := filepath.Join(dir, "out")
	hlsDir := filepath.Join(out, "hls")
	if err := os.MkdirAll(hlsDir, 0o755); err != nil {
		return jobs.Result{}, err
	}

	rungs := Ladder(src.Width, src.Height)
	if _, _, err := run(ctx, out, p.cfg.FFmpeg, p.encodeArgs(source, src, rungs, loudness)...); err != nil {
		return jobs.Result{}, fmt.Errorf("encode: %w", err)
	}
	if _, _, err := run(ctx, hlsDir, p.cfg.FFmpeg, hlsArgs(out, rungs, src.HasAudio)...); err != nil {
		return jobs.Result{}, fmt.Errorf("package hls: %w", err)
	}

	// Длительность берётся у готового файла: у исходника её может не быть.
	top := filepath.Join(out, rungs[0].Name+".mp4")
	encoded, err := p.probe(ctx, top)
	if err != nil {
		return jobs.Result{}, fmt.Errorf("probe encoded: %w", err)
	}
	if _, _, err := run(ctx, out, p.cfg.FFmpeg, posterArgs(top, encoded.Duration)...); err != nil {
		return jobs.Result{}, fmt.Errorf("poster: %w", err)
	}

	prefix := path.Join("media", job.OwnerID, job.MediaID)
	if err := p.upload(ctx, out, prefix); err != nil {
		return jobs.Result{}, err
	}

	return jobs.Result{
		Variants: jobs.Variants{
			HLS:    prefix + "/hls/master.m3u8",
			MP4720: prefix + "/" + rungs[0].Name + ".mp4",
			MP4480: prefix + "/" + rungs[len(rungs)-1].Name + ".mp4",
			Poster: prefix + "/poster.jpg",
		},
		Width:      src.Width,
		Height:     src.Height,
		DurationMs: int(encoded.Duration.Milliseconds()),
	}, nil
}

func (p *Processor) probe(ctx context.Context, file string) (Source, error) {
	args := append([]string{"-v", "error"}, sourceGuard...)
	args = append(args, "-print_format", "json", "-show_streams", "-show_format", file)
	stdout, _, err := run(ctx, "", p.cfg.FFprobe, args...)
	if err != nil {
		if ctx.Err() != nil {
			return Source{}, err
		}
		// ffprobe не открыл файл — значит, это не видео, и повтор не поможет.
		return Source{}, jobs.Permanent(err)
	}
	src, err := parseProbe(stdout)
	if err != nil {
		return Source{}, jobs.Permanent(err)
	}
	return src, nil
}

func (p *Processor) measureLoudness(ctx context.Context, file string) (Loudness, error) {
	args := append([]string{"-hide_banner", "-nostdin", "-nostats"}, sourceGuard...)
	args = append(args, "-i", file, "-map", "0:a:0", "-af", analyzeFilter, "-f", "null", "-")
	_, stderr, err := run(ctx, "", p.cfg.FFmpeg, args...)
	if err != nil {
		return Loudness{}, fmt.Errorf("measure loudness: %w", err)
	}
	return parseLoudnorm(stderr)
}

// encodeArgs кодирует все ступени за один запуск: исходник декодируется
// один раз, а звук нормализуется один раз и раздаётся всем ступеням.
func (p *Processor) encodeArgs(source string, src Source, rungs []Rung, loudness *Loudness) []string {
	n := len(rungs)
	var graph strings.Builder
	fmt.Fprintf(&graph, "[0:v:0]split=%d", n)
	for i := range rungs {
		fmt.Fprintf(&graph, "[s%d]", i)
	}
	for i, r := range rungs {
		fmt.Fprintf(&graph, ";[s%d]scale=%d:%d,setsar=1,format=yuv420p[v%d]", i, r.Width, r.Height, i)
	}
	if src.HasAudio {
		// loudnorm отдаёт 192 кГц, AAC столько не ждёт.
		audio := "aresample=48000"
		if loudness != nil {
			audio = loudness.Filter() + "," + audio
		}
		fmt.Fprintf(&graph, ";[0:a:0]%s,asplit=%d", audio, n)
		for i := range rungs {
			fmt.Fprintf(&graph, "[a%d]", i)
		}
	}

	args := append([]string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y"}, sourceGuard...)
	args = append(args, "-i", source, "-filter_complex", graph.String())

	for i, r := range rungs {
		args = append(args, "-map", fmt.Sprintf("[v%d]", i))
		if src.HasAudio {
			args = append(args, "-map", fmt.Sprintf("[a%d]", i),
				"-c:a", "aac", "-b:a", r.AudioBitrate, "-ac", "2")
		}
		args = append(args,
			"-c:v", "libx264", "-preset", p.cfg.Preset, "-profile:v", "high",
			"-crf", strconv.Itoa(r.CRF), "-maxrate", r.MaxRate, "-bufsize", r.BufSize,
			// Ключевой кадр ровно раз в 2 с: HLS режет сегменты только по ним,
			// а общая сетка у ступеней позволяет плееру переключаться без рывка.
			"-force_key_frames", "expr:gte(t,n_forced*2)", "-sc_threshold", "0",
			"-fpsmax", "30",
			// Телефоны пишут в метаданные координаты съёмки — наружу их не отдаём.
			"-map_metadata", "-1", "-map_chapters", "-1",
			"-movflags", "+faststart",
		)
		if p.cfg.MaxDuration > 0 {
			args = append(args, "-t", strconv.FormatFloat((p.cfg.MaxDuration+durationSlack).Seconds(), 'f', 3, 64))
		}
		args = append(args, r.Name+".mp4")
	}
	return args
}

// hlsArgs только переупаковывает готовые MP4 в сегменты, без перекодирования.
func hlsArgs(out string, rungs []Rung, hasAudio bool) []string {
	args := []string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y"}
	for _, r := range rungs {
		args = append(args, "-i", filepath.Join(out, r.Name+".mp4"))
	}

	streams := make([]string, 0, len(rungs))
	for i, r := range rungs {
		args = append(args, "-map", fmt.Sprintf("%d:v:0", i))
		entry := fmt.Sprintf("v:%d", i)
		if hasAudio {
			args = append(args, "-map", fmt.Sprintf("%d:a:0", i))
			entry += fmt.Sprintf(",a:%d", i)
		}
		streams = append(streams, entry+",name:"+r.Name)
	}

	return append(args,
		"-c", "copy",
		"-f", "hls",
		"-hls_time", "4",
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_flags", "independent_segments",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", "%v/seg_%03d.m4s",
		"-master_pl_name", "master.m3u8",
		"-var_stream_map", strings.Join(streams, " "),
		"%v/index.m3u8",
	)
}

// posterArgs берёт кадр не с самого начала: мемы часто стартуют с чёрного.
func posterArgs(video string, duration time.Duration) []string {
	at := min(time.Second, duration/3)
	return []string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y",
		"-ss", strconv.FormatFloat(at.Seconds(), 'f', 3, 64), "-i", video,
		"-frames:v", "1", "-q:v", "3", "poster.jpg"}
}

var contentTypes = map[string]string{
	".m3u8": "application/vnd.apple.mpegurl",
	".m4s":  "video/iso.segment",
	".mp4":  "video/mp4",
	".jpg":  "image/jpeg",
}

func (p *Processor) upload(ctx context.Context, dir, prefix string) error {
	var files []string
	err := filepath.WalkDir(dir, func(file string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			files = append(files, file)
		}
		return err
	})
	if err != nil {
		return fmt.Errorf("list results: %w", err)
	}

	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	queue := make(chan string)
	var wg sync.WaitGroup
	for range uploadConcurrency {
		wg.Go(func() {
			for file := range queue {
				rel, _ := filepath.Rel(dir, file)
				key := prefix + "/" + filepath.ToSlash(rel)
				contentType, ok := contentTypes[filepath.Ext(file)]
				if !ok {
					contentType = "application/octet-stream"
				}
				if err := p.storage.Upload(ctx, key, file, contentType); err != nil {
					cancel(err)
				}
			}
		})
	}

send:
	for _, file := range files {
		select {
		case queue <- file:
		case <-ctx.Done():
			break send
		}
	}
	close(queue)
	wg.Wait()

	if ctx.Err() != nil {
		return fmt.Errorf("upload results: %w", context.Cause(ctx))
	}
	return nil
}
