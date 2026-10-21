// Package notify сообщает сайту, что видео готово или не получилось.
// Источник правды — media.processing_status в базе; публикация в Centrifugo
// нужна только для того, чтобы открытая страница узнала об этом сразу.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
)

// Centrifugo публикует через HTTP API, как publish() в
// src/core/realtime/centrifugo.ts. Канал — channels.media() оттуда же.
type Centrifugo struct {
	apiURL string
	apiKey string
	client *http.Client
}

func NewCentrifugo(apiURL, apiKey string) *Centrifugo {
	return &Centrifugo{apiURL: apiURL, apiKey: apiKey, client: &http.Client{Timeout: 5 * time.Second}}
}

func (c *Centrifugo) Notify(ctx context.Context, job jobs.Job, status string) error {
	body, err := json.Marshal(map[string]any{
		"channel": "media:" + job.OwnerID,
		"data": map[string]string{
			"type":    "media.processed",
			"mediaId": job.MediaID,
			"status":  status,
		},
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+"/publish", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("centrifugo publish: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("centrifugo publish failed: %d %s", resp.StatusCode, bytes.TrimSpace(raw))
	}

	// Centrifugo отвечает 200 и на отказ, а причину кладёт в тело.
	var reply struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(raw, &reply); err == nil && len(reply.Error) > 0 {
		return fmt.Errorf("centrifugo publish rejected: %s", reply.Error)
	}
	return nil
}

// Noop — когда Centrifugo не настроен: сайт всё равно увидит статус в базе.
type Noop struct{}

func (Noop) Notify(context.Context, jobs.Job, string) error { return nil }
