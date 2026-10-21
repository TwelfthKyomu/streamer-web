import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingPost } from "@/modules/moderation";

vi.mock("@/app/_actions/moderation", () => ({ decideAction: vi.fn() }));

const { ReviewQueue } = await import("./review-queue");

function makePost(media: Partial<PendingPost["media"]> = {}): PendingPost {
  return {
    id: "post-1",
    caption: null,
    createdAt: new Date(),
    author: { id: "user-1", displayName: "Автор", avatarUrl: null },
    media: {
      kind: "video",
      url: "https://cdn.test/original.mov",
      hls: null,
      poster: null,
      ...media,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReviewQueue", () => {
  it("обработанное видео модератор смотрит через HLS", () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
      "maybe",
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { container } = render(
      <ReviewQueue
        initial={[makePost({ hls: "https://cdn.test/hls/master.m3u8" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Смотреть видео"));

    expect(container.querySelector("video")?.src).toBe(
      "https://cdn.test/hls/master.m3u8",
    );
  });

  it("необработанное видео играет из оригинала", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { container } = render(<ReviewQueue initial={[makePost()]} />);

    fireEvent.click(screen.getByLabelText("Смотреть видео"));

    expect(container.querySelector("video")?.src).toBe(
      "https://cdn.test/original.mov",
    );
  });
});
