import { describe, expect, it } from "vitest";
import { extensionFor, kindOf, type Limits, validateUpload } from "./limits";

const limits: Limits = {
  maxSizeBytes: 100 * 1024 * 1024,
  maxDurationMs: 60_000,
};

describe("kindOf", () => {
  it("узнаёт картинки и видео", () => {
    expect(kindOf("image/png")).toBe("image");
    expect(kindOf("video/mp4")).toBe("video");
  });

  it("не узнаёт всё остальное", () => {
    expect(kindOf("application/pdf")).toBeNull();
    expect(kindOf("text/html")).toBeNull();
    expect(kindOf("")).toBeNull();
  });
});

describe("extensionFor", () => {
  it("подбирает расширение по типу", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("video/quicktime")).toBe("mov");
  });

  it("для неизвестного типа отдаёт bin", () => {
    expect(extensionFor("application/x-msdownload")).toBe("bin");
  });
});

describe("validateUpload", () => {
  it("пропускает нормальную картинку", () => {
    expect(
      validateUpload({ mime: "image/png", sizeBytes: 2048, limits }),
    ).toEqual({ ok: true, kind: "image" });
  });

  it("пропускает видео в пределах лимита", () => {
    expect(
      validateUpload({
        mime: "video/mp4",
        sizeBytes: 5_000_000,
        durationMs: 59_000,
        limits,
      }),
    ).toEqual({ ok: true, kind: "video" });
  });

  it("отклоняет пустой файл", () => {
    expect(validateUpload({ mime: "image/png", sizeBytes: 0, limits })).toEqual(
      { ok: false, reason: "empty" },
    );
  });

  it("отклоняет посторонний формат", () => {
    expect(
      validateUpload({ mime: "application/zip", sizeBytes: 100, limits }),
    ).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("отклоняет файл больше лимита", () => {
    expect(
      validateUpload({
        mime: "video/mp4",
        sizeBytes: limits.maxSizeBytes + 1,
        limits,
      }),
    ).toEqual({ ok: false, reason: "too_large" });
  });

  it("отклоняет слишком длинное видео", () => {
    expect(
      validateUpload({
        mime: "video/mp4",
        sizeBytes: 1000,
        durationMs: limits.maxDurationMs + 1,
        limits,
      }),
    ).toEqual({ ok: false, reason: "too_long" });
  });

  it("не применяет лимит длительности к картинкам", () => {
    expect(
      validateUpload({
        mime: "image/gif",
        sizeBytes: 1000,
        durationMs: 999_999,
        limits,
      }),
    ).toEqual({ ok: true, kind: "image" });
  });

  it("пропускает видео с неизвестной длительностью", () => {
    expect(
      validateUpload({ mime: "video/webm", sizeBytes: 1000, limits }),
    ).toEqual({ ok: true, kind: "video" });
  });

  it("проверяет размер раньше длительности", () => {
    expect(
      validateUpload({
        mime: "video/mp4",
        sizeBytes: limits.maxSizeBytes + 1,
        durationMs: limits.maxDurationMs + 1,
        limits,
      }),
    ).toEqual({ ok: false, reason: "too_large" });
  });
});
