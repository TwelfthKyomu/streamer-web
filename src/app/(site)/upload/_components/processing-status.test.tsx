import { act, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Handler = (ctx: unknown) => void;

  class FakeSubscription {
    handlers = new Map<string, Handler>();
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    channel: string;
    options: unknown;

    constructor(channel: string, options: unknown) {
      this.channel = channel;
      this.options = options;
    }

    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string, ctx: unknown = {}) {
      this.handlers.get(event)?.(ctx);
    }
  }

  class FakeCentrifuge {
    static instances: FakeCentrifuge[] = [];
    subscriptions: FakeSubscription[] = [];
    connect = vi.fn();
    disconnect = vi.fn();
    url: string;
    options: unknown;

    constructor(url: string, options: unknown) {
      this.url = url;
      this.options = options;
      FakeCentrifuge.instances.push(this);
    }

    newSubscription(channel: string, options: unknown) {
      const subscription = new FakeSubscription(channel, options);
      this.subscriptions.push(subscription);
      return subscription;
    }
  }

  return { FakeCentrifuge, mediaStatusAction: vi.fn() };
});

vi.mock("centrifuge", () => ({ Centrifuge: fake.FakeCentrifuge }));

vi.mock("@/app/_actions/upload", () => ({
  mediaStatusAction: fake.mediaStatusAction,
}));

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

const { ProcessingStatus } = await import("./processing-status");

const MEDIA_ID = "0192f3a4-0000-7000-8000-000000000001";

const realtime = {
  wsUrl: "ws://centrifugo.test/connection/websocket",
  channel: "media:user-1",
  connectionToken: "connection-token",
  subscriptionToken: "subscription-token",
};

function renderStatus(onReset = vi.fn()) {
  const view = render(
    <ProcessingStatus
      mediaId={MEDIA_ID}
      realtime={realtime}
      onReset={onReset}
    />,
  );
  const centrifuge = fake.FakeCentrifuge.instances[0];
  const subscription = centrifuge?.subscriptions[0];
  if (!centrifuge || !subscription) throw new Error("подписки нет");
  return { ...view, centrifuge, subscription };
}

function processed(status: string, mediaId = MEDIA_ID) {
  return { data: { type: "media.processed", mediaId, status } };
}

beforeEach(() => {
  fake.FakeCentrifuge.instances = [];
  fake.mediaStatusAction.mockReset();
  fake.mediaStatusAction.mockResolvedValue("processing");
});

describe("ProcessingStatus", () => {
  it("пока ждёт воркер, показывает «обрабатывается…» и слушает личный канал", () => {
    const { centrifuge, subscription } = renderStatus();

    expect(screen.getByText("Видео: обрабатывается…")).toBeInTheDocument();
    expect(centrifuge.url).toBe(realtime.wsUrl);
    expect(centrifuge.options).toEqual({ token: realtime.connectionToken });
    expect(subscription.channel).toBe(realtime.channel);
    expect(subscription.options).toEqual({ token: realtime.subscriptionToken });
    expect(subscription.subscribe).toHaveBeenCalled();
    expect(centrifuge.connect).toHaveBeenCalled();
  });

  it("по событию ready показывает «готово» и закрывает сокет", () => {
    const { centrifuge, subscription } = renderStatus();

    act(() => subscription.emit("publication", processed("ready")));

    expect(screen.getByText("Видео: готово")).toBeInTheDocument();
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(centrifuge.disconnect).toHaveBeenCalled();
    expect(fake.FakeCentrifuge.instances).toHaveLength(1);
  });

  it("по событию failed показывает «не получилось»", () => {
    const { subscription } = renderStatus();

    act(() => subscription.emit("publication", processed("failed")));

    expect(screen.getByText("Видео: не получилось")).toBeInTheDocument();
  });

  it("не реагирует на чужие и непонятные события", () => {
    const { centrifuge, subscription } = renderStatus();

    act(() => {
      subscription.emit("publication", processed("ready", "other-media"));
      subscription.emit("publication", processed("unknown"));
      subscription.emit("publication", { data: { type: "stream.status" } });
      subscription.emit("publication", { data: null });
    });

    expect(screen.getByText("Видео: обрабатывается…")).toBeInTheDocument();
    expect(centrifuge.disconnect).not.toHaveBeenCalled();
  });

  it("после подписки сверяется с базой: событие могло пройти раньше", async () => {
    fake.mediaStatusAction.mockResolvedValue("ready");
    const { subscription } = renderStatus();

    act(() => subscription.emit("subscribed"));

    expect(await screen.findByText("Видео: готово")).toBeInTheDocument();
    expect(fake.mediaStatusAction).toHaveBeenCalledWith(MEDIA_ID);
  });

  it("если по базе видео ещё в работе, продолжает ждать", async () => {
    const { centrifuge, subscription } = renderStatus();

    await act(async () => subscription.emit("subscribed"));

    expect(fake.mediaStatusAction).toHaveBeenCalledWith(MEDIA_ID);
    expect(screen.getByText("Видео: обрабатывается…")).toBeInTheDocument();
    expect(centrifuge.disconnect).not.toHaveBeenCalled();
  });

  it("сбой сверки не ломает ожидание события", async () => {
    fake.mediaStatusAction.mockRejectedValue(new Error("network"));
    const { subscription } = renderStatus();

    await act(async () => subscription.emit("subscribed"));
    act(() => subscription.emit("publication", processed("ready")));

    expect(screen.getByText("Видео: готово")).toBeInTheDocument();
  });

  it("закрывает сокет при уходе со страницы", () => {
    const { centrifuge, subscription, unmount } = renderStatus();

    unmount();

    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(centrifuge.disconnect).toHaveBeenCalled();
  });

  it("«Загрузить ещё» возвращает к форме", () => {
    const onReset = vi.fn();
    renderStatus(onReset);

    fireEvent.click(screen.getByText("Загрузить ещё"));

    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByText("В ленту").closest("a")).toHaveAttribute(
      "href",
      "/",
    );
  });
});
