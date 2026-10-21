package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
)

// testS3 подключается к хранилищу из TEST_S3_URL вида
// http://minioadmin:minioadmin@localhost:9000/streamer-media — это MinIO
// из docker-compose.yml. Без переменной тест пропускается.
func testS3(t *testing.T) *S3 {
	t.Helper()
	raw := os.Getenv("TEST_S3_URL")
	if raw == "" {
		t.Skip("TEST_S3_URL is not set")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse TEST_S3_URL: %v", err)
	}
	secret, _ := u.User.Password()
	s3, err := NewS3(S3Config{
		Endpoint:  u.Scheme + "://" + u.Host,
		Region:    "ru-central1",
		Bucket:    u.Path[1:],
		AccessKey: u.User.Username(),
		SecretKey: secret,
	})
	if err != nil {
		t.Fatalf("NewS3: %v", err)
	}
	return s3
}

func TestUploadThenDownload(t *testing.T) {
	s3 := testS3(t)
	key := fmt.Sprintf("worker-tests/%d/playlist.m3u8", time.Now().UnixNano())
	t.Cleanup(func() {
		_ = s3.client.RemoveObject(context.Background(), s3.bucket, key, minio.RemoveObjectOptions{})
	})

	content := []byte("#EXTM3U\n")
	src := filepath.Join(t.TempDir(), "playlist.m3u8")
	if err := os.WriteFile(src, content, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s3.Upload(t.Context(), key, src, "application/vnd.apple.mpegurl"); err != nil {
		t.Fatalf("Upload: %v", err)
	}

	info, err := s3.client.StatObject(t.Context(), s3.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		t.Fatalf("stat uploaded object: %v", err)
	}
	if info.ContentType != "application/vnd.apple.mpegurl" {
		t.Errorf("content type = %q; want application/vnd.apple.mpegurl", info.ContentType)
	}

	dst := filepath.Join(t.TempDir(), "copy.m3u8")
	if err := s3.Download(t.Context(), key, dst); err != nil {
		t.Fatalf("Download: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("downloaded %q; want %q", got, content)
	}
}

func TestDownloadMissingObject(t *testing.T) {
	s3 := testS3(t)
	err := s3.Download(t.Context(), "worker-tests/does-not-exist.mp4", filepath.Join(t.TempDir(), "x.mp4"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Download(missing) error = %v; want ErrNotFound", err)
	}
}
