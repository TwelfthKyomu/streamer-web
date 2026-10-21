package debug

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func get(t *testing.T, srv *httptest.Server, path string) string {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", path, resp.StatusCode, body)
	}
	return string(body)
}

// Эти адреса забирает ruvo в удалённом режиме — см. docs/PLAN.md в ruvo.
func TestServesProfilesRuvoReads(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	if body := get(t, srv, "/debug/pprof/goroutine?debug=1"); !strings.Contains(body, "goroutine profile:") {
		t.Errorf("debug=1 dump looks wrong:\n%.200s", body)
	}
	if body := get(t, srv, "/debug/pprof/goroutine?debug=2"); !strings.Contains(body, "goroutine ") {
		t.Errorf("debug=2 dump looks wrong:\n%.200s", body)
	}
	get(t, srv, "/debug/pprof/goroutineleak?debug=1")
	get(t, srv, "/debug/pprof/trace?seconds=0.1")
	if body := get(t, srv, "/debug/pprof/"); !strings.Contains(body, "goroutineleak") {
		t.Errorf("pprof index does not list goroutineleak")
	}
}

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	if body := get(t, srv, "/healthz"); strings.TrimSpace(body) != "ok" {
		t.Fatalf("/healthz = %q; want ok", body)
	}
}
