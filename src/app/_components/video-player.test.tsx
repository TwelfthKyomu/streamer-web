import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const FakeHls = vi.hoisted(() => {
  type Handler = (event: string, data: { fatal: boolean }) => void;

  return class FakeHls {
    static Events: Record<"ERROR" | "MANIFEST_PARSED", string> = {
      ERROR: "hlsError",
      MANIFEST_PARSED: "hlsManifestParsed",
    };
    static supported = true;
    static instances: FakeHls[] = [];
    static isSupported: Mock<() => boolean> = vi.fn(() => FakeHls.supported);

    handlers = new Map<string, Handler>();
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();

    constructor() {
      FakeHls.instances.push(this);
    }

    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }

    once(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }

    emit(event: string, data = { fatal: false }) {
      this.handlers.get(event)?.(event, data);
    }
  };
});

vi.mock("hls.js", () => ({ default: FakeHls }));

const { VideoPlayer } = await import("./video-player");

const HLS = "https://cdn.test/media/u1/m1/hls/master.m3u8";
const MP4 = "https://cdn.test/media/u1/m1/720.mp4";
const POSTER = "https://cdn.test/media/u1/m1/poster.jpg";

let nativeHls: CanPlayTypeResult = "";
const play = vi.fn(() => Promise.resolve());

function renderPlayer(hls: string | null = HLS) {
  const view = render(<VideoPlayer hls={hls} src={MP4} poster={POSTER} />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("нет <video>");
  return { ...view, video };
}

async function startWithHlsJs() {
  const view = renderPlayer();
  fireEvent.click(screen.getByLabelText("Смотреть видео"));
  await waitFor(() => expect(FakeHls.instances).toHaveLength(1));
  const player = FakeHls.instances[0];
  if (!player) throw new Error("hls.js не создан");
  return { ...view, player };
}

beforeEach(() => {
  nativeHls = "";
  FakeHls.supported = true;
  FakeHls.instances = [];
  FakeHls.isSupported.mockClear();
  play.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation(
    () => nativeHls,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VideoPlayer", () => {
  it("до клика показывает только постер и ничего не грузит", () => {
    const { video } = renderPlayer();

    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("poster", POSTER);
    expect(video).not.toHaveAttribute("src");
    expect(video).not.toHaveAttribute("controls");
    expect(play).not.toHaveBeenCalled();
    expect(FakeHls.isSupported).not.toHaveBeenCalled();
    expect(FakeHls.instances).toHaveLength(0);
  });

  it("в Safari играет HLS нативно, без hls.js", () => {
    nativeHls = "maybe";
    const { video } = renderPlayer();

    fireEvent.click(screen.getByLabelText("Смотреть видео"));

    expect(video.src).toBe(HLS);
    expect(video).toHaveAttribute("controls");
    expect(play).toHaveBeenCalledOnce();
    expect(FakeHls.instances).toHaveLength(0);
    expect(screen.queryByLabelText("Смотреть видео")).not.toBeInTheDocument();
  });

  it("в остальных браузерах подключает hls.js и стартует после манифеста", async () => {
    const { video, player } = await startWithHlsJs();

    expect(player.loadSource).toHaveBeenCalledWith(HLS);
    expect(player.attachMedia).toHaveBeenCalledWith(video);
    expect(play).not.toHaveBeenCalled();

    act(() => player.emit(FakeHls.Events.MANIFEST_PARSED));

    expect(play).toHaveBeenCalledOnce();
  });

  it("без HLS играет mp4", () => {
    const { video } = renderPlayer(null);

    fireEvent.click(screen.getByLabelText("Смотреть видео"));

    expect(video.src).toBe(MP4);
    expect(play).toHaveBeenCalledOnce();
    expect(FakeHls.instances).toHaveLength(0);
  });

  it("при фатальной ошибке hls.js переключается на mp4", async () => {
    const { video, player } = await startWithHlsJs();

    act(() => player.emit(FakeHls.Events.ERROR, { fatal: true }));

    expect(player.destroy).toHaveBeenCalled();
    expect(video.src).toBe(MP4);
    expect(play).toHaveBeenCalledOnce();
  });

  it("нефатальную ошибку hls.js переживает сам", async () => {
    const { video, player } = await startWithHlsJs();

    act(() => player.emit(FakeHls.Events.ERROR, { fatal: false }));

    expect(player.destroy).not.toHaveBeenCalled();
    expect(video.src).not.toBe(MP4);
  });

  it("если нативный HLS не играет, переключается на mp4", () => {
    nativeHls = "maybe";
    const { video } = renderPlayer();

    fireEvent.click(screen.getByLabelText("Смотреть видео"));
    fireEvent.error(video);

    expect(video.src).toBe(MP4);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("ошибка самого mp4 не зацикливает переключение", () => {
    const { video } = renderPlayer(null);

    fireEvent.click(screen.getByLabelText("Смотреть видео"));
    fireEvent.error(video);

    expect(video.src).toBe(MP4);
    expect(play).toHaveBeenCalledOnce();
  });

  it("без MSE и нативного HLS играет mp4", async () => {
    FakeHls.supported = false;
    const { video } = renderPlayer();

    fireEvent.click(screen.getByLabelText("Смотреть видео"));

    await waitFor(() => expect(video.src).toBe(MP4));
    expect(FakeHls.instances).toHaveLength(0);
  });

  it("освобождает hls.js при размонтировании", async () => {
    const { player, unmount } = await startWithHlsJs();

    unmount();

    expect(player.destroy).toHaveBeenCalled();
  });
});
