import { describe, expect, it } from "vitest";
import {
  maxMessageAgeMs,
  signEventSubMessage,
  verifyEventSubSignature,
} from "./verify";

const secret = "секрет-для-вебхуков-твича";
const messageId = "b1e2c3d4-0000-4a5b-8c9d-000000000001";
const now = new Date("2026-08-15T05:00:00.000Z");
const timestamp = now.toISOString();
const body = JSON.stringify({
  subscription: { type: "stream.online" },
  event: { broadcaster_user_login: "streamer", started_at: timestamp },
});

function sign(
  overrides: Partial<Parameters<typeof signEventSubMessage>[0]> = {},
) {
  return signEventSubMessage({
    messageId,
    timestamp,
    body,
    secret,
    ...overrides,
  });
}

describe("verifyEventSubSignature", () => {
  it("принимает корректно подписанное сообщение", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: sign(),
      body,
      secret,
      now,
    });

    expect(result).toEqual({ ok: true });
  });

  it("отбраковывает подменённое тело", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: sign(),
      body: body.replace("streamer", "злоумышленник"),
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отбраковывает подпись, сделанную чужим секретом", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: sign({ secret: "совсем-другой-секрет" }),
      body,
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отбраковывает подпись с чужим messageId", () => {
    const result = verifyEventSubSignature({
      messageId: "00000000-0000-4000-8000-000000000999",
      timestamp,
      signature: sign(),
      body,
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отбраковывает просроченное сообщение", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: sign(),
      body,
      secret,
      now: new Date(now.getTime() + maxMessageAgeMs + 1000),
    });

    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("принимает сообщение на границе допустимого возраста", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: sign(),
      body,
      secret,
      now: new Date(now.getTime() + maxMessageAgeMs - 1000),
    });

    expect(result).toEqual({ ok: true });
  });

  it("отбраковывает сообщение из будущего", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: sign(),
      body,
      secret,
      now: new Date(now.getTime() - maxMessageAgeMs - 1000),
    });

    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("требует все три заголовка", () => {
    const base = { body, secret, now };

    expect(
      verifyEventSubSignature({
        ...base,
        messageId: null,
        timestamp,
        signature: sign(),
      }),
    ).toEqual({ ok: false, reason: "missing_headers" });

    expect(
      verifyEventSubSignature({
        ...base,
        messageId,
        timestamp: null,
        signature: sign(),
      }),
    ).toEqual({ ok: false, reason: "missing_headers" });

    expect(
      verifyEventSubSignature({
        ...base,
        messageId,
        timestamp,
        signature: null,
      }),
    ).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("отбраковывает нечитаемую метку времени", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp: "вчера",
      signature: sign(),
      body,
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("не падает на подписи неверной длины", () => {
    const result = verifyEventSubSignature({
      messageId,
      timestamp,
      signature: "sha256=коротко",
      body,
      secret,
      now,
    });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});
