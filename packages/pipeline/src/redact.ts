/**
 * Redaction by pixelation: every private box (faces, number plates) on every frame is replaced
 * with coarse blocks before the frame can reach an outside model or a player.
 *
 * Boxes are grown by a margin so a slightly short box still hides the whole face, and blocks
 * are sized relative to the box so nothing recognisable survives at any resolution. Pure and
 * deterministic: the same frames and tracks always give the same bytes. Runs anywhere, no
 * GPU; frames go through our hardened PNG codec.
 */
import type { FrameSet, TrackSet } from "./contracts.ts";
import { decodePng, encodePng, type RgbaImage } from "./png.ts";
import type { ProviderContext, Redactor } from "./providers.ts";

/** Fraction of the box size added on every side. */
const MARGIN = 0.2;
/** About this many blocks across the box's shorter side. */
const BLOCKS = 6;
const MAX_FRAME_SIDE = 4096;

export function pixelate(
  image: RgbaImage,
  box: readonly [x: number, y: number, w: number, h: number],
): void {
  const [bx, by, bw, bh] = box;
  const mx = Math.ceil(bw * MARGIN);
  const my = Math.ceil(bh * MARGIN);
  const x0 = Math.max(0, Math.floor(bx - mx));
  const y0 = Math.max(0, Math.floor(by - my));
  const x1 = Math.min(image.width, Math.ceil(bx + bw + mx));
  const y1 = Math.min(image.height, Math.ceil(by + bh + my));
  const block = Math.max(4, Math.ceil(Math.min(x1 - x0, y1 - y0) / BLOCKS));
  const d = image.data;
  for (let by0 = y0; by0 < y1; by0 += block) {
    for (let bx0 = x0; bx0 < x1; bx0 += block) {
      const bx1 = Math.min(x1, bx0 + block);
      const by1 = Math.min(y1, by0 + block);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const i = (y * image.width + x) * 4;
          r += d[i] as number;
          g += d[i + 1] as number;
          b += d[i + 2] as number;
          n++;
        }
      }
      if (n === 0) continue;
      const [cr, cg, cb] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const i = (y * image.width + x) * 4;
          d[i] = cr;
          d[i + 1] = cg;
          d[i + 2] = cb;
          d[i + 3] = 255;
        }
      }
    }
  }
}

export function pixelRedactor(): Redactor {
  return {
    model: { provider: "aye", model: "pixelate", version: "1" },
    async redact(frames: FrameSet, tracks: TrackSet, ctx: ProviderContext): Promise<FrameSet> {
      const out: FrameSet["frames"] = [];
      for (const f of frames.frames) {
        const hide = tracks.tracks.filter(
          (t) => t.private && t.frameStart <= f.index && f.index <= t.frameEnd,
        );
        const bytes = await ctx.store.get(f.image.hash);
        if (!bytes) throw new Error(`missing frame ${f.image.hash}`);
        if (hide.length === 0) {
          out.push(f);
          continue;
        }
        const image = await decodePng(bytes, MAX_FRAME_SIDE);
        for (const t of hide) pixelate(image, t.bbox);
        out.push({ ...f, image: await ctx.store.put(await encodePng(image), "image/png") });
      }
      return { ...frames, frames: out };
    },
  };
}
