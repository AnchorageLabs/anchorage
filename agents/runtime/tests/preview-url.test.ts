import { describe, expect, it } from "vitest";
import { publicPreviewUrl } from "../src/preview-url.js";

const LOCAL = "http://localhost:3100";

describe("publicPreviewUrl", () => {
  it("returns the localhost URL when ANCHORAGE_PREVIEW_PUBLIC_URL is unset", () => {
    expect(publicPreviewUrl(LOCAL, {})).toBe(LOCAL);
  });

  it("returns the public URL when ANCHORAGE_PREVIEW_PUBLIC_URL is set", () => {
    const env = { ANCHORAGE_PREVIEW_PUBLIC_URL: "https://preview.example.com" };
    expect(publicPreviewUrl(LOCAL, env)).toBe("https://preview.example.com");
  });

  it("trims surrounding whitespace from the public URL", () => {
    const env = { ANCHORAGE_PREVIEW_PUBLIC_URL: "  https://preview.example.com\n" };
    expect(publicPreviewUrl(LOCAL, env)).toBe("https://preview.example.com");
  });

  it("falls back to the localhost URL when the env var is empty", () => {
    expect(publicPreviewUrl(LOCAL, { ANCHORAGE_PREVIEW_PUBLIC_URL: "" })).toBe(LOCAL);
  });

  it("falls back to the localhost URL when the env var is only whitespace", () => {
    expect(publicPreviewUrl(LOCAL, { ANCHORAGE_PREVIEW_PUBLIC_URL: "   " })).toBe(LOCAL);
  });

  it("defaults to process.env", () => {
    const prev = process.env.ANCHORAGE_PREVIEW_PUBLIC_URL;
    try {
      process.env.ANCHORAGE_PREVIEW_PUBLIC_URL = "https://tunnel.example.dev";
      expect(publicPreviewUrl(LOCAL)).toBe("https://tunnel.example.dev");
      delete process.env.ANCHORAGE_PREVIEW_PUBLIC_URL;
      expect(publicPreviewUrl(LOCAL)).toBe(LOCAL);
    } finally {
      if (prev === undefined) delete process.env.ANCHORAGE_PREVIEW_PUBLIC_URL;
      else process.env.ANCHORAGE_PREVIEW_PUBLIC_URL = prev;
    }
  });
});
