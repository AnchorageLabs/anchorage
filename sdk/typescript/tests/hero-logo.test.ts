import { describe, expect, it } from "vitest";
import {
  CAMERA_CONFIG,
  clampPixelRatio,
  EXTRUDE_CONFIG,
  getPreferredTheme,
  ROTATION_DELTA,
  SCENE_COLORS,
  shouldRotate,
} from "../../../examples/hero-logo/dist/scene-config.js";

describe("scene-config exports", () => {
  describe("SCENE_COLORS", () => {
    it("dark background is a non-empty string", () => {
      expect(typeof SCENE_COLORS.dark.background).toBe("string");
      expect(SCENE_COLORS.dark.background.length).toBeGreaterThan(0);
    });

    it("light background is a non-empty string", () => {
      expect(typeof SCENE_COLORS.light.background).toBe("string");
      expect(SCENE_COLORS.light.background.length).toBeGreaterThan(0);
    });
  });

  describe("CAMERA_CONFIG", () => {
    it("fov is 45", () => {
      expect(CAMERA_CONFIG.fov).toBe(45);
    });

    it("position z is 18", () => {
      expect(CAMERA_CONFIG.position[2]).toBe(18);
    });
  });

  describe("EXTRUDE_CONFIG", () => {
    it("depth is 20", () => {
      expect(EXTRUDE_CONFIG.depth).toBe(20);
    });

    it("bevelEnabled is true", () => {
      expect(EXTRUDE_CONFIG.bevelEnabled).toBe(true);
    });
  });

  describe("ROTATION_DELTA", () => {
    it("is 0.004", () => {
      expect(ROTATION_DELTA).toBe(0.004);
    });
  });

  describe("getPreferredTheme", () => {
    it("returns dark for 'dark'", () => {
      expect(getPreferredTheme("dark")).toBe("dark");
    });

    it("returns light for 'light'", () => {
      expect(getPreferredTheme("light")).toBe("light");
    });

    it("returns dark when undefined (default)", () => {
      expect(getPreferredTheme(undefined)).toBe("dark");
    });
  });

  describe("shouldRotate", () => {
    it("returns false when prefers-reduced-motion matches (rotation disabled)", () => {
      expect(shouldRotate(true)).toBe(false);
    });

    it("returns true when prefers-reduced-motion does not match", () => {
      expect(shouldRotate(false)).toBe(true);
    });
  });

  describe("clampPixelRatio", () => {
    it("passes through 1", () => {
      expect(clampPixelRatio(1)).toBe(1);
    });

    it("passes through 2", () => {
      expect(clampPixelRatio(2)).toBe(2);
    });

    it("clamps 3 to 2", () => {
      expect(clampPixelRatio(3)).toBe(2);
    });
  });
});
