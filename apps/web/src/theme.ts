/**
 * The city's look, applied as CSS custom properties. Every value comes from a validated city
 * spec (`#rrggbb` colours, a font style from a fixed set, a bounded radius), and is set with
 * `style.setProperty` on known names only, so a model can restyle the game but never inject.
 */
import type { Theme } from "@aye/schema";

const FONTS: Record<Theme["font"], string> = {
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif',
  grotesk: '"Inter", "Helvetica Neue", Arial, system-ui, sans-serif',
  serif: 'ui-serif, "Iowan Old Style", "Palatino", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
  condensed: '"Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif',
};

const DEFAULT: Theme = {
  font: "rounded",
  radiusPx: 18,
  colours: {
    bg: "#f4efe6",
    surface: "#ffffff",
    ink: "#1d1b16",
    muted: "#6b665b",
    accent: "#1a7f4e",
    onAccent: "#ffffff",
    good: "#1a7f4e",
    warn: "#b07800",
    bad: "#c0392b",
    land: "#d8e6cf",
    water: "#5aa9d6",
    road: "#9a9a96",
    built: "#b9ad97",
    industrial: "#9c8f86",
    green: "#8fc27a",
  },
};

export function applyTheme(theme: Theme | null): void {
  const t = theme ?? DEFAULT;
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(t.colours)) root.setProperty(`--${name}`, value);
  root.setProperty("--font", FONTS[t.font]);
  root.setProperty("--radius", `${t.radiusPx}px`);
}
