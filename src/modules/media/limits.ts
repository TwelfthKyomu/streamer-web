/**
 * Ограничения на загружаемые файлы. Файл чистый и без зависимостей: те же
 * правила применяет клиент до отправки и сервер до выдачи ссылки, а
 * расхождение между ними — это или проваленная загрузка, или дыра.
 */

export const imageMimes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const videoMimes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export type MediaKind = "image" | "video";

export type RejectionReason =
  | "empty"
  | "unsupported_type"
  | "too_large"
  | "too_long";

export type ValidationResult =
  | { ok: true; kind: MediaKind }
  | { ok: false; reason: RejectionReason };

const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function kindOf(mime: string): MediaKind | null {
  if ((imageMimes as readonly string[]).includes(mime)) return "image";
  if ((videoMimes as readonly string[]).includes(mime)) return "video";
  return null;
}

export function extensionFor(mime: string): string {
  return extensions[mime] ?? "bin";
}

export function describeRejection(
  reason: RejectionReason,
  limits: Limits,
): string {
  switch (reason) {
    case "empty":
      return "Файл пустой";
    case "unsupported_type":
      return "Такой формат не поддерживается: только jpg, png, webp, gif, mp4, webm и mov";
    case "too_large":
      return `Файл больше ${Math.round(limits.maxSizeBytes / (1024 * 1024))} МБ`;
    case "too_long":
      return `Видео длиннее ${Math.round(limits.maxDurationMs / 1000)} секунд`;
  }
}

export type Limits = {
  maxSizeBytes: number;
  maxDurationMs: number;
};

export function validateUpload(params: {
  mime: string;
  sizeBytes: number;
  /** Длительность известна только для видео и приходит от клиента. */
  durationMs?: number | undefined;
  limits: Limits;
}): ValidationResult {
  if (params.sizeBytes <= 0) return { ok: false, reason: "empty" };

  const kind = kindOf(params.mime);
  if (!kind) return { ok: false, reason: "unsupported_type" };

  if (params.sizeBytes > params.limits.maxSizeBytes) {
    return { ok: false, reason: "too_large" };
  }

  if (
    kind === "video" &&
    params.durationMs !== undefined &&
    params.durationMs > params.limits.maxDurationMs
  ) {
    return { ok: false, reason: "too_long" };
  }

  return { ok: true, kind };
}
