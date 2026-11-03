/**
 * Turning a model's values into bounded ones: numbers clamped, colours and icons
 * checked, shapes bounded, and every change said in words the model can act on. Shared by
 * every compiler that reads a draft (cities, their kinds, worlds' looks).
 */
import { Icon, type Solid } from "@aye/schema";
import { cleanText } from "./assemble.ts";
import type { DraftSolid } from "./contracts.ts";

export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(v)));
export const HEX = /^#[0-9a-f]{6}$/;

export function colour(c: string, fallback: string, issues: string[], where: string): string {
  const v = c.trim().toLowerCase();
  if (HEX.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((x) => x + x).join("")}`;
  issues.push(`${where}: "${cleanText(c, 16)}" isn't a #rrggbb colour; used ${fallback}.`);
  return fallback;
}

export function icon(c: string, fallback: string, issues: string[], where: string): string {
  const v = c.trim();
  if (Icon.safeParse(v).success) return v;
  issues.push(`${where}: "${cleanText(c, 16)}" isn't a single emoji; used ${fallback}.`);
  return fallback;
}

export const PIN = "\u{1F4CD}";

/** Draft primitives → bounded solids (relative to their owner's size). */
export function solidsOf(
  list: readonly DraftSolid[],
  max: number,
  issues: string[],
  where: string,
): Solid[] {
  if (list.length > max) issues.push(`${where} has ${list.length} shapes; only ${max} fit.`);
  return list.slice(0, max).map((d, i) => ({
    shape: d.shape,
    centre: [clamp(d.x, -1000, 1000), clamp(d.y, 0, 2000), clamp(d.z, -1000, 1000)],
    size: [clamp(d.w, 1, 2000), clamp(d.h, 1, 2000), clamp(d.d, 1, 2000)],
    rotateDeg: [clamp(d.rx, -180, 180), clamp(d.ry, -180, 180), clamp(d.rz, -180, 180)],
    colour: colour(d.colour, "#b0a898", issues, `${where} shape ${i}`),
    glow: d.glow,
  }));
}

export const draftSolid = (s: Solid): DraftSolid => ({
  shape: s.shape,
  x: s.centre[0],
  y: s.centre[1],
  z: s.centre[2],
  w: s.size[0],
  h: s.size[1],
  d: s.size[2],
  rx: s.rotateDeg[0],
  ry: s.rotateDeg[1],
  rz: s.rotateDeg[2],
  colour: s.colour,
  glow: s.glow,
});
