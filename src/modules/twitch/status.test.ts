import { describe, expect, it } from "vitest";
import { toStatusChange } from "./status";

describe("toStatusChange", () => {
  it("включает эфир и берёт время начала из события", () => {
    const change = toStatusChange("stream.online", {
      broadcaster_user_login: "streamer",
      started_at: "2026-08-15T05:00:00Z",
    });

    expect(change).toEqual({
      kind: "online",
      startedAt: new Date("2026-08-15T05:00:00Z"),
    });
  });

  it("подставляет текущее время, если started_at не пришёл", () => {
    const before = Date.now();
    const change = toStatusChange("stream.online", {});
    const after = Date.now();

    expect(change.kind).toBe("online");
    if (change.kind !== "online") return;

    expect(change.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(change.startedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("подставляет текущее время при мусоре в started_at", () => {
    const change = toStatusChange("stream.online", { started_at: "позавчера" });

    expect(change.kind).toBe("online");
    if (change.kind !== "online") return;
    expect(Number.isNaN(change.startedAt.getTime())).toBe(false);
  });

  it("выключает эфир", () => {
    expect(toStatusChange("stream.offline", {})).toEqual({ kind: "offline" });
  });

  it("обновляет название и категорию", () => {
    const change = toStatusChange("channel.update", {
      title: "Катаем ранкед",
      category_name: "Dota 2",
    });

    expect(change).toEqual({
      kind: "meta",
      title: "Катаем ранкед",
      game: "Dota 2",
    });
  });

  it("считает пустые строки отсутствующими значениями", () => {
    const change = toStatusChange("channel.update", {
      title: "",
      category_name: "",
    });

    expect(change).toEqual({ kind: "meta", title: null, game: null });
  });

  it("игнорирует типы, на которые сайт не подписан", () => {
    expect(toStatusChange("channel.follow", { user_id: "1" })).toEqual({
      kind: "ignored",
    });
  });

  it("не падает на пустом событии", () => {
    expect(toStatusChange("channel.update", null)).toEqual({
      kind: "meta",
      title: null,
      game: null,
    });
  });
});
