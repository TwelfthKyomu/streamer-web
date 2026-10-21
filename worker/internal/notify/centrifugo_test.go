package notify

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TwelfthDannis/streamer-web/worker/internal/jobs"
)

func TestNotifyPublishesToOwnerChannel(t *testing.T) {
	var got struct {
		Channel string `json:"channel"`
		Data    struct {
			Type    string `json:"type"`
			MediaID string `json:"mediaId"`
			Status  string `json:"status"`
		} `json:"data"`
	}
	var path, key string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, key = r.URL.Path, r.Header.Get("X-API-Key")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Errorf("request body %s: %v", body, err)
		}
		_, _ = io.WriteString(w, `{"result":{}}`)
	}))
	defer srv.Close()

	c := NewCentrifugo(srv.URL+"/api", "secret")
	err := c.Notify(t.Context(), jobs.Job{MediaID: "m-1", OwnerID: "user-1"}, "ready")
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}

	if path != "/api/publish" || key != "secret" {
		t.Errorf("request to %s with key %q; want /api/publish with key secret", path, key)
	}
	if got.Channel != "media:user-1" || got.Data.Type != "media.processed" || got.Data.MediaID != "m-1" || got.Data.Status != "ready" {
		t.Errorf("published %+v; want media.processed ready for m-1 in media:user-1", got)
	}
}

func TestNotifyReportsRejectedPublication(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"error":{"code":102,"message":"unknown channel"}}`)
	}))
	defer srv.Close()

	err := NewCentrifugo(srv.URL, "secret").Notify(t.Context(), jobs.Job{OwnerID: "u"}, "ready")
	if err == nil {
		t.Fatal("Notify ignored an error in the response body")
	}
}

func TestNotifyReportsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "invalid api key", http.StatusUnauthorized)
	}))
	defer srv.Close()

	err := NewCentrifugo(srv.URL, "wrong").Notify(t.Context(), jobs.Job{OwnerID: "u"}, "ready")
	if err == nil {
		t.Fatal("Notify ignored HTTP 401")
	}
}
