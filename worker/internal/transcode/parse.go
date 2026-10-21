package transcode

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"
)

// Rung — одна ступень лесенки качеств.
type Rung struct {
	Name          string
	Width, Height int
	CRF           int
	MaxRate       string
	BufSize       string
	AudioBitrate  string
}

var ladder = []struct {
	name                    string
	short                   int
	crf                     int
	maxRate, bufSize, audio string
}{
	{"720p", 720, 23, "2800k", "5600k", "128k"},
	{"480p", 480, 24, "1200k", "2400k", "96k"},
}

// Ladder считает размеры ступеней по короткой стороне, поэтому вертикальное
// видео 1080×1920 даёт 720×1280, а не сплющенные 405×720. Исходник не
// растягивается: из 360p получается одна ступень «480p» в родном размере.
func Ladder(width, height int) []Rung {
	short := min(width, height)
	var rungs []Rung

	for i, l := range ladder {
		last := i == len(ladder)-1
		if !last && short <= ladder[i+1].short {
			continue
		}

		target := min(l.short, short)
		target -= target % 2

		w, h := target, even(float64(height)*float64(target)/float64(width))
		if width > height {
			w, h = even(float64(width)*float64(target)/float64(height)), target
		}

		rungs = append(rungs, Rung{
			Name:         l.name,
			Width:        w,
			Height:       h,
			CRF:          l.crf,
			MaxRate:      l.maxRate,
			BufSize:      l.bufSize,
			AudioBitrate: l.audio,
		})
	}
	return rungs
}

func even(x float64) int {
	return int(math.Round(x/2)) * 2
}

// Source — исходник глазами зрителя: стороны уже с учётом поворота,
// который телефоны пишут в метаданные вместо того, чтобы вращать кадры.
type Source struct {
	Width, Height int
	// Duration равна нулю, если контейнер её не знает (webm из MediaRecorder).
	Duration time.Duration
	HasAudio bool
}

type probeOutput struct {
	Streams []struct {
		CodecType   string `json:"codec_type"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
		SideDataList []struct {
			Rotation float64 `json:"rotation"`
		} `json:"side_data_list"`
		Tags struct {
			Rotate string `json:"rotate"`
		} `json:"tags"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

var errNoVideo = errors.New("no video stream")

func parseProbe(data []byte) (Source, error) {
	var out probeOutput
	if err := json.Unmarshal(data, &out); err != nil {
		return Source{}, fmt.Errorf("parse ffprobe output: %w", err)
	}

	var src Source
	found := false
	for _, s := range out.Streams {
		switch {
		case s.CodecType == "audio":
			src.HasAudio = true
		// Обложка у mp3 тоже числится видеопотоком, но видео из неё не выйдет.
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && !found:
			found = true
			src.Width, src.Height = s.Width, s.Height

			rotation := 0.0
			if len(s.SideDataList) > 0 {
				rotation = s.SideDataList[0].Rotation
			} else if s.Tags.Rotate != "" {
				rotation, _ = strconv.ParseFloat(s.Tags.Rotate, 64)
			}
			if int(math.Abs(rotation))%180 == 90 {
				src.Width, src.Height = src.Height, src.Width
			}
		}
	}

	if !found || src.Width <= 0 || src.Height <= 0 {
		return Source{}, errNoVideo
	}

	if seconds, err := strconv.ParseFloat(out.Format.Duration, 64); err == nil {
		src.Duration = time.Duration(math.Round(seconds*1000)) * time.Millisecond
	}
	return src, nil
}

// Цель громкости — −16 LUFS, как у большинства площадок с роликами: мем,
// записанный в упор к микрофону, не оглушит, а шёпот станет слышен.
const (
	targetI   = "-16"
	targetTP  = "-1.5"
	targetLRA = "11"
)

var analyzeFilter = fmt.Sprintf("loudnorm=I=%s:TP=%s:LRA=%s:print_format=json", targetI, targetTP, targetLRA)

// Loudness — замер первого прохода loudnorm. Значения хранятся строками,
// как их напечатал ffmpeg, и так же возвращаются во второй проход.
type Loudness struct {
	I, TP, LRA, Thresh, Offset string
}

func parseLoudnorm(stderr []byte) (Loudness, error) {
	start := bytes.LastIndexByte(stderr, '{')
	end := bytes.LastIndexByte(stderr, '}')
	if start < 0 || end < start {
		return Loudness{}, errors.New("loudnorm report not found")
	}

	var report struct {
		I      string `json:"input_i"`
		TP     string `json:"input_tp"`
		LRA    string `json:"input_lra"`
		Thresh string `json:"input_thresh"`
		Offset string `json:"target_offset"`
	}
	if err := json.Unmarshal(stderr[start:end+1], &report); err != nil {
		return Loudness{}, fmt.Errorf("parse loudnorm report: %w", err)
	}
	if report.I == "" {
		return Loudness{}, errors.New("loudnorm report has no input_i")
	}
	return Loudness(report), nil
}

// Silent — дорожка тише порога измерения. Нормализовать тишину нечего,
// а второй проход на -inf просто упадёт.
func (l Loudness) Silent() bool {
	v, err := strconv.ParseFloat(l.I, 64)
	return err != nil || v < -70
}

// Filter — второй проход: линейное усиление по замеру, без «дыхания»
// динамической компрессии.
func (l Loudness) Filter() string {
	return fmt.Sprintf(
		"loudnorm=I=%s:TP=%s:LRA=%s:measured_I=%s:measured_TP=%s:measured_LRA=%s:measured_thresh=%s:offset=%s:linear=true",
		targetI, targetTP, targetLRA, l.I, l.TP, l.LRA, l.Thresh, l.Offset,
	)
}
