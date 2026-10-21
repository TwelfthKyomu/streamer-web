"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  publishUploadAction,
  requestUploadAction,
} from "@/app/_actions/upload";
import {
  describeRejection,
  imageMimes,
  kindOf,
  type Limits,
  validateUpload,
  videoMimes,
} from "@/modules/media/client";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { Textarea } from "@/ui/textarea";
import { type MediaRealtime, ProcessingStatus } from "./processing-status";

// exactOptionalPropertyTypes требует явного undefined: метаданные могут
// не прочитаться, и это нормальное состояние, а не отсутствие ключа.
type Meta = {
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
};

type Phase = "idle" | "hashing" | "uploading" | "saving";

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Размеры и длительность читаем в браузере: сервер без ffmpeg их не узнает,
 * а лимит на длину видео проверять надо до загрузки ста мегабайт.
 */
async function readMeta(file: File): Promise<Meta> {
  const kind = kindOf(file.type);

  if (kind === "image") {
    try {
      const bitmap = await createImageBitmap(file);
      const meta = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return meta;
    } catch {
      return {};
    }
  }

  if (kind !== "video") return {};

  return new Promise<Meta>((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);

    const done = (meta: Meta) => {
      URL.revokeObjectURL(url);
      resolve(meta);
    };

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      done({
        width: video.videoWidth,
        height: video.videoHeight,
        durationMs: Number.isFinite(video.duration)
          ? Math.round(video.duration * 1000)
          : undefined,
      });
    };
    video.onerror = () => done({});
    video.src = url;
  });
}

/** fetch не отдаёт прогресс отправки, поэтому здесь XHR. */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open("PUT", url);
    request.setRequestHeader("Content-Type", file.type);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Хранилище ответило ${request.status}`));
    };
    request.onerror = () =>
      reject(new Error("Не удалось связаться с хранилищем"));

    request.send(file);
  });
}

export function UploadForm({
  limits,
  realtime,
}: {
  limits: Limits;
  realtime: MediaRealtime;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta>({});
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const accept = useMemo(
    () =>
      Object.fromEntries(
        [...imageMimes, ...videoMimes].map((mime) => [mime, []]),
      ),
    [],
  );

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const picked = accepted[0];
      if (!picked) return;

      const nextMeta = await readMeta(picked);
      const validation = validateUpload({
        mime: picked.type,
        sizeBytes: picked.size,
        durationMs: nextMeta.durationMs,
        limits,
      });

      if (!validation.ok) {
        toast.error(describeRejection(validation.reason, limits));
        return;
      }

      setPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(picked);
      });
      setMeta(nextMeta);
      setFile(picked);
    },
    [limits],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted) => {
      void onDrop(accepted);
    },
    accept,
    multiple: false,
    maxFiles: 1,
    disabled: phase !== "idle",
  });

  const busy = phase !== "idle";

  const handleSubmit = async () => {
    if (!file) return;

    try {
      setPhase("hashing");
      const checksum = await sha256Hex(file);

      const ticket = await requestUploadAction({
        mime: file.type,
        sizeBytes: file.size,
        checksum,
        ...(meta.durationMs !== undefined
          ? { durationMs: meta.durationMs }
          : {}),
      });

      if (ticket.status === "unauthorized") {
        toast.error("Нужно войти заново");
        setPhase("idle");
        return;
      }

      if (ticket.status === "rejected") {
        toast.error(describeRejection(ticket.reason, limits));
        setPhase("idle");
        return;
      }

      if (ticket.status === "rate_limited") {
        toast.error("Слишком много загрузок", {
          description: `Попробуйте через ${Math.ceil(ticket.retryAfterSeconds / 60)} мин.`,
        });
        setPhase("idle");
        return;
      }

      if (ticket.status === "ready") {
        setPhase("uploading");
        setProgress(0);
        await putWithProgress(ticket.uploadUrl, file, setProgress);
      }

      setPhase("saving");

      const published = await publishUploadAction({
        caption,
        checksum,
        mime: file.type,
        sizeBytes: file.size,
        ...(ticket.status === "ready"
          ? { storageKey: ticket.storageKey }
          : { mediaId: ticket.mediaId }),
        ...(meta.width !== undefined ? { width: meta.width } : {}),
        ...(meta.height !== undefined ? { height: meta.height } : {}),
        ...(meta.durationMs !== undefined
          ? { durationMs: meta.durationMs }
          : {}),
      });

      if (published.status !== "ok") {
        toast.error(
          published.status === "mismatch"
            ? "Файл в хранилище не совпал с заявленным"
            : "Не удалось сохранить пост",
        );
        setPhase("idle");
        return;
      }

      // Видео ещё сжимает воркер: остаёмся на странице и ждём его события.
      if (kindOf(file.type) === "video") {
        setProcessingId(published.mediaId);
        setPhase("idle");
        return;
      }

      toast.success("Отправлено на модерацию", {
        description: "Пост появится в ленте после проверки.",
      });
      router.push("/");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Не удалось загрузить файл",
      );
      setPhase("idle");
    }
  };

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(null);
    setMeta({});
    setCaption("");
    setProgress(0);
    setProcessingId(null);
  };

  if (processingId) {
    return (
      <ProcessingStatus
        mediaId={processingId}
        realtime={realtime}
        onReset={reset}
      />
    );
  }

  const maxMb = Math.round(limits.maxSizeBytes / (1024 * 1024));
  const maxSec = Math.round(limits.maxDurationMs / 1000);

  return (
    <div className="flex flex-col gap-4">
      <div
        {...getRootProps()}
        className={`flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors ${
          isDragActive ? "border-primary bg-primary/5" : "border-border"
        } ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <input {...getInputProps()} />

        {preview && file ? (
          file.type.startsWith("video/") ? (
            <video
              src={preview}
              className="max-h-64 rounded-md"
              controls
              muted
              playsInline
            >
              <track kind="captions" />
            </video>
          ) : (
            <img src={preview} alt="" className="max-h-64 rounded-md" />
          )
        ) : (
          <>
            <p className="font-medium">Перетащите файл или нажмите</p>
            <p className="text-muted-foreground text-sm">
              jpg, png, webp, gif, mp4, webm, mov — до {maxMb} МБ, видео до{" "}
              {maxSec} сек.
            </p>
          </>
        )}
      </div>

      {file ? (
        <p className="text-muted-foreground text-sm">
          {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} МБ
          {meta.durationMs
            ? ` · ${(meta.durationMs / 1000).toFixed(1)} сек.`
            : ""}
        </p>
      ) : null}

      <Textarea
        value={caption}
        onChange={(event) => setCaption(event.target.value)}
        placeholder="Подпись (необязательно)"
        maxLength={500}
        disabled={busy}
        rows={3}
      />

      {phase === "uploading" ? <Progress value={progress} /> : null}

      <Button onClick={handleSubmit} disabled={!file || busy}>
        {phase === "hashing"
          ? "Считаем контрольную сумму…"
          : phase === "uploading"
            ? `Загружаем… ${progress}%`
            : phase === "saving"
              ? "Сохраняем…"
              : "Отправить на модерацию"}
      </Button>
    </div>
  );
}
