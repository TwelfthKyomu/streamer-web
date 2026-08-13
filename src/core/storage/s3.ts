import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/core/env";

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export async function createUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: expiresInSeconds },
  );
}

export async function createDownloadUrl(
  key: string,
  expiresInSeconds = 900,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

export function publicUrl(key: string): string {
  return `${env.S3_PUBLIC_URL}/${key}`;
}

export async function statObject(
  key: string,
): Promise<{ sizeBytes: number; contentType: string } | null> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    );
    return {
      sizeBytes: head.ContentLength ?? 0,
      contentType: head.ContentType ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
