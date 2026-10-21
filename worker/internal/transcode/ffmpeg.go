package transcode

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// run запускает ffmpeg или ffprobe. При отмене процесс убивается сразу:
// на SIGTERM ffmpeg сначала дожимает буфер кодировщика, на медленном пресете
// это секунды, а результат прерванного запуска всё равно выбрасывается.
func run(ctx context.Context, dir, bin string, args ...string) (stdout, stderr []byte, err error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.WaitDelay = 5 * time.Second

	var out bytes.Buffer
	errTail := &tailBuffer{limit: 64 << 10}
	cmd.Stdout = &out
	cmd.Stderr = errTail

	err = cmd.Run()
	if ctx.Err() != nil {
		return nil, nil, fmt.Errorf("%s interrupted: %w", filepath.Base(bin), context.Cause(ctx))
	}
	if err != nil {
		return out.Bytes(), errTail.buf, fmt.Errorf("%s: %w: %s", filepath.Base(bin), err, lastLines(errTail.buf, 3))
	}
	return out.Bytes(), errTail.buf, nil
}

// tailBuffer хранит только конец вывода: ffmpeg на длинном ролике пишет
// мегабайты, а нужны последние строки — там ошибка и отчёт loudnorm.
type tailBuffer struct {
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.limit {
		t.buf = t.buf[len(t.buf)-t.limit:]
	}
	return len(p), nil
}

func lastLines(b []byte, n int) string {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
