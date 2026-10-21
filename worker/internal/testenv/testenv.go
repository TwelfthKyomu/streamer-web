// Package testenv — окружение для интеграционных тестов: временная база с
// миграциями сайта и MinIO из docker-compose.yml. Без TEST_DATABASE_URL и
// TEST_S3_URL такие тесты пропускаются, обычный go test их не требует.
package testenv

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/TwelfthDannis/streamer-web/worker/internal/storage"
)

// Database создаёт пустую базу, накатывает миграции drizzle из
// src/core/db/migrations и удаляет базу после теста. TEST_DATABASE_URL —
// подключение с правом CREATE DATABASE:
// postgres://streamer:streamer@localhost:5433/postgres.
func Database(t *testing.T) (pool *pgxpool.Pool, connString string) {
	t.Helper()
	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()

	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(func() { admin.Close(context.Background()) })

	name := fmt.Sprintf("worker_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)")
	})

	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	u.Path = "/" + name
	connString = u.String()

	pool, err = pgxpool.New(ctx, connString)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(pool.Close)

	migrations, err := filepath.Glob(filepath.Join(repoRoot(), "src", "core", "db", "migrations", "*.sql"))
	if err != nil || len(migrations) == 0 {
		t.Fatalf("find migrations: %v (%d files)", err, len(migrations))
	}
	slices.Sort(migrations)
	for _, file := range migrations {
		sql, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("apply %s: %v", filepath.Base(file), err)
		}
	}
	return pool, connString
}

// SeedVideo делает то же, что publishUpload на сайте: пользователь, запись
// media и задача на неё.
func SeedVideo(t *testing.T, pool *pgxpool.Pool, ownerID, storageKey string) (mediaID string) {
	t.Helper()
	ctx := context.Background()

	_, err := pool.Exec(ctx, `INSERT INTO "user" (id, name, email) VALUES ($1, $1, $1 || '@test')
		ON CONFLICT DO NOTHING`, ownerID)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	err = pool.QueryRow(ctx, `
		INSERT INTO media (id, owner_id, kind, storage_key, mime, size_bytes, checksum)
		VALUES (gen_random_uuid(), $1, 'video', $2, 'video/mp4', 1024, 'sum')
		RETURNING id::text`, ownerID, storageKey).Scan(&mediaID)
	if err != nil {
		t.Fatalf("insert media: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO media_jobs (media_id) VALUES ($1)`, mediaID); err != nil {
		t.Fatalf("insert job: %v", err)
	}
	return mediaID
}

// S3 читает TEST_S3_URL вида http://minioadmin:minioadmin@localhost:9000/streamer-media
// и удаляет всё под prefix после теста.
func S3(t *testing.T, prefix string) storage.S3Config {
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
	cfg := storage.S3Config{
		Endpoint:  u.Scheme + "://" + u.Host,
		Region:    "ru-central1",
		Bucket:    u.Path[1:],
		AccessKey: u.User.Username(),
		SecretKey: secret,
	}

	t.Cleanup(func() { removePrefix(t, cfg, prefix) })
	return cfg
}

func removePrefix(t *testing.T, cfg storage.S3Config, prefix string) {
	u, _ := url.Parse(cfg.Endpoint)
	client, err := minio.New(u.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       u.Scheme == "https",
		BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		t.Logf("clean up test objects: %v", err)
		return
	}
	ctx := context.Background()
	objects := client.ListObjects(ctx, cfg.Bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true})
	for err := range client.RemoveObjects(ctx, cfg.Bucket, objects, minio.RemoveObjectsOptions{}) {
		t.Logf("remove test object %s: %v", err.ObjectName, err.Err)
	}
}

func repoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..")
}
