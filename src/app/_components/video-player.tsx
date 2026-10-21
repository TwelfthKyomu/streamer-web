"use client";

import type Hls from "hls.js";
import { PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/ui/utils";

const hlsMime = "application/vnd.apple.mpegurl";

/**
 * Видео поста. До клика это только постер: ни ролик, ни hls.js не грузятся,
 * поэтому лента из десятка видео не тянет мегабайты зря.
 *
 * Источник — HLS от воркера: в Safari нативно, в остальных через hls.js.
 * Если HLS нет или он сломался, играет `src` (mp4_720 или оригинал).
 */
export function VideoPlayer({
  hls,
  src,
  poster,
  className,
}: {
  hls: string | null;
  src: string;
  poster: string | null;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Hls | null>(null);
  const sourceRef = useRef<"hls" | "src" | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => () => playerRef.current?.destroy(), []);

  const play = (video: HTMLVideoElement) => {
    // Без звука браузер может не дать стартовать сам — тогда зритель
    // нажмёт play в контролах.
    video.play().catch(() => undefined);
  };

  const playSrc = (video: HTMLVideoElement) => {
    playerRef.current?.destroy();
    playerRef.current = null;
    sourceRef.current = "src";
    video.src = src;
    play(video);
  };

  const playWithHlsJs = async (video: HTMLVideoElement, manifest: string) => {
    const { default: HlsJs } = await import("hls.js");
    if (videoRef.current !== video || sourceRef.current !== "hls") return;

    if (!HlsJs.isSupported()) {
      playSrc(video);
      return;
    }

    const player = new HlsJs();
    playerRef.current = player;
    player.on(HlsJs.Events.ERROR, (_event, data) => {
      if (data.fatal && playerRef.current === player) playSrc(video);
    });
    player.once(HlsJs.Events.MANIFEST_PARSED, () => play(video));
    player.loadSource(manifest);
    player.attachMedia(video);
  };

  const start = () => {
    const video = videoRef.current;
    if (!video) return;
    setStarted(true);

    if (!hls) {
      playSrc(video);
      return;
    }

    sourceRef.current = "hls";

    // Нативный HLS запускаем синхронно, внутри клика: Safari строже
    // остальных к тому, откуда вызван play().
    if (video.canPlayType(hlsMime)) {
      video.src = hls;
      play(video);
      return;
    }

    playWithHlsJs(video, hls).catch(() => playSrc(video));
  };

  const handleError = () => {
    const video = videoRef.current;
    if (video && sourceRef.current === "hls") playSrc(video);
  };

  return (
    <div className="relative">
      <video
        ref={videoRef}
        poster={poster ?? undefined}
        controls={started}
        playsInline
        preload="none"
        onError={handleError}
        className={className}
      >
        <track kind="captions" />
      </video>

      {started ? null : (
        <button
          type="button"
          onClick={start}
          aria-label="Смотреть видео"
          className="group absolute inset-0 flex items-center justify-center"
        >
          <span
            className={cn(
              "flex size-14 items-center justify-center rounded-sm border border-border/60 bg-background/80 backdrop-blur transition-colors",
              "group-hover:border-primary group-hover:text-primary",
            )}
          >
            <PlayIcon className="size-6 fill-current" />
          </span>
        </button>
      )}
    </div>
  );
}
