export const SCENE_COLORS: {
  light: { background: string; material: string; ambient: string };
  dark: { background: string; material: string; ambient: string };
} = {
  light: {
    background: "#f0f4ff",
    material: "#4f8ef7",
    ambient: "#c8d8ff",
  },
  dark: {
    background: "#0a0a1a",
    material: "#4f8ef7",
    ambient: "#1a1a2e",
  },
};

export const CAMERA_CONFIG: {
  fov: number;
  position: [number, number, number];
  lookAt: [number, number, number];
} = {
  fov: 45,
  position: [0, -6, 18],
  lookAt: [0, 1, 0],
};

export const EXTRUDE_CONFIG: {
  depth: number;
  bevelEnabled: boolean;
  bevelSize: number;
} = {
  depth: 20,
  bevelEnabled: true,
  bevelSize: 2,
};

export const ROTATION_DELTA = 0.004;

export function getPreferredTheme(dataTheme?: string): "light" | "dark" {
  if (dataTheme === "light") return "light";
  if (dataTheme === "dark") return "dark";
  return "dark";
}

export function shouldRotate(mediaMatches: boolean): boolean {
  return !mediaMatches;
}

export function clampPixelRatio(dpr: number): number {
  return Math.min(dpr, 2);
}
