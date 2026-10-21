// Package storage — S3-совместимое хранилище: локально MinIO, на проде
// Yandex Object Storage или Selectel. Меняются только переменные окружения.
package storage

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ErrNotFound — объекта по ключу нет. Повтор этого не исправит.
var ErrNotFound = errors.New("object not found")

type S3Config struct {
	// Endpoint — адрес со схемой, как S3_ENDPOINT у сайта: http://localhost:9000.
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
}

type S3 struct {
	client *minio.Client
	bucket string
}

func NewS3(cfg S3Config) (*S3, error) {
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || endpoint.Host == "" {
		return nil, fmt.Errorf("invalid S3 endpoint %q", cfg.Endpoint)
	}

	client, err := minio.New(endpoint.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: endpoint.Scheme == "https",
		Region: cfg.Region,
		// Как forcePathStyle у сайта: MinIO не держит бакеты поддоменами.
		BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		return nil, fmt.Errorf("create S3 client: %w", err)
	}
	return &S3{client: client, bucket: cfg.Bucket}, nil
}

func (s *S3) Download(ctx context.Context, key, path string) error {
	err := s.client.FGetObject(ctx, s.bucket, key, path, minio.GetObjectOptions{})
	if minio.ToErrorResponse(err).Code == minio.NoSuchKey {
		return fmt.Errorf("%s: %w", key, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("download %s: %w", key, err)
	}
	return nil
}

func (s *S3) Upload(ctx context.Context, key, path, contentType string) error {
	_, err := s.client.FPutObject(ctx, s.bucket, key, path, minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}
	return nil
}
