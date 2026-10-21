package transcode

import (
	"testing"
	"time"
)

func TestLadder(t *testing.T) {
	type size struct {
		name          string
		width, height int
	}
	cases := []struct {
		name          string
		width, height int
		want          []size
	}{
		{"landscape 1080p", 1920, 1080, []size{{"720p", 1280, 720}, {"480p", 854, 480}}},
		{"portrait 1080p", 1080, 1920, []size{{"720p", 720, 1280}, {"480p", 480, 854}}},
		{"exactly 720p", 1280, 720, []size{{"720p", 1280, 720}, {"480p", 854, 480}}},
		{"between rungs is not upscaled", 960, 540, []size{{"720p", 960, 540}, {"480p", 854, 480}}},
		{"below 480p keeps one rung", 640, 360, []size{{"480p", 640, 360}}},
		{"odd sides are rounded to even", 1279, 719, []size{{"720p", 1278, 718}, {"480p", 854, 480}}},
		{"square", 1080, 1080, []size{{"720p", 720, 720}, {"480p", 480, 480}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Ladder(tc.width, tc.height)
			if len(got) != len(tc.want) {
				t.Fatalf("Ladder(%d, %d) = %d rungs; want %d: %+v", tc.width, tc.height, len(got), len(tc.want), got)
			}
			for i, w := range tc.want {
				g := got[i]
				if g.Name != w.name || g.Width != w.width || g.Height != w.height {
					t.Errorf("rung %d = %s %dx%d; want %s %dx%d", i, g.Name, g.Width, g.Height, w.name, w.width, w.height)
				}
			}
		})
	}
}

const probeLandscape = `{
  "streams": [
    {"index": 0, "codec_type": "video", "width": 1920, "height": 1080, "duration": "5.000000"},
    {"index": 1, "codec_type": "audio", "sample_rate": "44100", "channels": 1}
  ],
  "format": {"duration": "5.023000"}
}`

const probeRotated = `{
  "streams": [
    {"index": 0, "codec_type": "video", "width": 1920, "height": 1080,
     "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]}
  ],
  "format": {"duration": "12.5"}
}`

const probeUpsideDown = `{
  "streams": [
    {"index": 0, "codec_type": "video", "width": 1920, "height": 1080,
     "side_data_list": [{"side_data_type": "Display Matrix", "rotation": 180}]}
  ],
  "format": {"duration": "1"}
}`

const probeNoDuration = `{
  "streams": [{"index": 0, "codec_type": "video", "width": 640, "height": 480}],
  "format": {}
}`

const probeAudioOnly = `{
  "streams": [{"index": 0, "codec_type": "audio"}],
  "format": {"duration": "3"}
}`

func TestParseProbe(t *testing.T) {
	cases := []struct {
		name string
		json string
		want Source
	}{
		{"video with audio", probeLandscape, Source{Width: 1920, Height: 1080, Duration: 5023 * time.Millisecond, HasAudio: true}},
		{"rotated phone video", probeRotated, Source{Width: 1080, Height: 1920, Duration: 12500 * time.Millisecond}},
		{"upside down keeps sides", probeUpsideDown, Source{Width: 1920, Height: 1080, Duration: time.Second}},
		{"unknown duration", probeNoDuration, Source{Width: 640, Height: 480}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseProbe([]byte(tc.json))
			if err != nil {
				t.Fatalf("parseProbe: %v", err)
			}
			if got != tc.want {
				t.Fatalf("parseProbe = %+v; want %+v", got, tc.want)
			}
		})
	}
}

func TestParseProbeRejectsFileWithoutVideo(t *testing.T) {
	if _, err := parseProbe([]byte(probeAudioOnly)); err == nil {
		t.Fatal("parseProbe accepted a file without a video stream")
	}
}

const loudnormStderr = `[out#0/null @ 0x76f0804300] video:0KiB audio:1875KiB
[Parsed_loudnorm_0 @ 0x76f0804a80]
{
	"input_i" : "-22.68",
	"input_tp" : "-18.55",
	"input_lra" : "0.10",
	"input_thresh" : "-32.68",
	"output_i" : "-16.00",
	"output_tp" : "-11.86",
	"output_lra" : "0.10",
	"output_thresh" : "-26.00",
	"normalization_type" : "dynamic",
	"target_offset" : "0.00"
}
size=N/A time=00:00:05.00 bitrate=N/A speed=42.4x elapsed=0:00:00.11
`

func TestParseLoudnorm(t *testing.T) {
	got, err := parseLoudnorm([]byte(loudnormStderr))
	if err != nil {
		t.Fatalf("parseLoudnorm: %v", err)
	}
	want := Loudness{I: "-22.68", TP: "-18.55", LRA: "0.10", Thresh: "-32.68", Offset: "0.00"}
	if got != want {
		t.Fatalf("parseLoudnorm = %+v; want %+v", got, want)
	}
	if got.Silent() {
		t.Fatal("-22.68 LUFS reported as silent")
	}
}

func TestParseLoudnormWithoutReport(t *testing.T) {
	if _, err := parseLoudnorm([]byte("Invalid data found when processing input\n")); err == nil {
		t.Fatal("parseLoudnorm accepted output without a report")
	}
}

func TestSilentLoudness(t *testing.T) {
	for _, i := range []string{"-inf", "-75.00"} {
		if !(Loudness{I: i}).Silent() {
			t.Errorf("Loudness{I: %q}.Silent() = false; want true", i)
		}
	}
}

func TestLoudnessFilterUsesMeasuredValues(t *testing.T) {
	l := Loudness{I: "-22.68", TP: "-18.55", LRA: "0.10", Thresh: "-32.68", Offset: "0.00"}
	want := "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-22.68:measured_TP=-18.55:measured_LRA=0.10:measured_thresh=-32.68:offset=0.00:linear=true"
	if got := l.Filter(); got != want {
		t.Fatalf("Filter() =\n%s\nwant\n%s", got, want)
	}
}
