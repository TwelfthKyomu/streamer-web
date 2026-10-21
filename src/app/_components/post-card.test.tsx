import { fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedPost } from "@/modules/feed";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/app/_actions/feed", () => ({ likeAction: vi.fn() }));

const { PostCard } = await import("./post-card");

function makePost(media: Partial<FeedPost["media"]> = {}): FeedPost {
  return {
    id: "post-1",
    caption: "Подпись",
    likeCount: 3,
    commentCount: 1,
    publishedAt: new Date(),
    likedByMe: false,
    author: { id: "user-1", displayName: "Стример", avatarUrl: null },
    media: {
      kind: "video",
      url: "https://cdn.test/720.mp4",
      hls: "https://cdn.test/hls/master.m3u8",
      poster: "https://cdn.test/poster.jpg",
      width: null,
      height: null,
      ...media,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostCard", () => {
  it("видео не грузит до клика, а по клику играет HLS", () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
      "maybe",
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { container } = render(<PostCard post={makePost()} canInteract />);
    const video = container.querySelector("video");

    expect(video).toHaveAttribute("preload", "none");
    expect(video).not.toHaveAttribute("src");

    fireEvent.click(screen.getByLabelText("Смотреть видео"));

    expect(video?.src).toBe("https://cdn.test/hls/master.m3u8");
  });

  it("картинку показывает как картинку", () => {
    const { container } = render(
      <PostCard
        post={makePost({
          kind: "image",
          url: "https://cdn.test/pic.webp",
          hls: null,
          poster: null,
        })}
        canInteract
      />,
    );

    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByAltText("Подпись")).toHaveAttribute(
      "src",
      "https://cdn.test/pic.webp",
    );
  });
});
