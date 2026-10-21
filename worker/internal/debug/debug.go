// Package debug — служебный HTTP: net/http/pprof и проверка живости.
// Через pprof к воркеру подключается ruvo и видит, где стоят горутины.
package debug

import (
	"io"
	"net/http"
	"net/http/pprof"
)

// Handler собирает свой mux, а не берёт http.DefaultServeMux: импорт
// net/http/pprof регистрирует профили там неявно, и любой случайный
// обработчик на DefaultServeMux оказался бы рядом с ними.
func Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})
	return mux
}
