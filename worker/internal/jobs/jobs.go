// Package jobs описывает задачу воркера и хранит очередь в Postgres.
package jobs

import "errors"

// Job — задача, которую воркер держит в аренде. Attempt — номер попытки,
// он же маркер аренды: все изменения задачи проверяют его в WHERE.
type Job struct {
	ID         int64
	MediaID    string
	Attempt    int
	OwnerID    string
	StorageKey string
}

// Variants повторяет MediaVariants из src/core/db/schema/content.ts:
// в поля пишутся ключи объектов, публичный адрес собирает сайт.
type Variants struct {
	HLS    string `json:"hls,omitempty"`
	MP4720 string `json:"mp4_720,omitempty"`
	MP4480 string `json:"mp4_480,omitempty"`
	Poster string `json:"poster,omitempty"`
}

// Result — то, что воркер узнал о видео и куда положил результат.
type Result struct {
	Variants   Variants
	Width      int
	Height     int
	DurationMs int
}

// ErrLeaseLost значит, что задачу забрал кто-то другой: аренда истекла
// или номер попытки уже сменился.
var ErrLeaseLost = errors.New("job lease lost")

type permanentError struct{ err error }

func (e permanentError) Error() string { return e.err.Error() }
func (e permanentError) Unwrap() error { return e.err }

// Permanent помечает ошибку, которую повтор не исправит: битый файл,
// видео длиннее лимита. Такая задача сразу уходит в failed.
func Permanent(err error) error {
	if err == nil {
		return nil
	}
	return permanentError{err: err}
}

// IsPermanent сообщает, что ошибка помечена через Permanent.
func IsPermanent(err error) bool {
	var p permanentError
	return errors.As(err, &p)
}
