/**
 * Node-only providers: video handling with ffmpeg on an ordinary CPU.
 *
 * ffmpeg runs as a child process with an argument array (never a shell string), a timeout and
 * a bounded output buffer, in a private temporary directory that is always removed. Input
 * videos are untrusted files, so frames come out as plain 8-bit RGBA PNGs that our hardened
 * decoder then checks again.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactRef } from "@aye/schema";
import type { FrameSet } from "./contracts.ts";
import type { FrameSampler, ProviderContext } from "./providers.ts";

const run = promisify(execFile);
const LIMITS = { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 };

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aye-ffmpeg-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function probeSeconds(path: string): Promise<number> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    LIMITS,
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("video has no duration");
  return seconds;
}

/** Cut `seconds` from `start`, drop audio, scale to `width`, as H.264 MP4. */
export async function cutClip(
  input: string,
  opts: { start: number; seconds: number; width: number },
): Promise<Uint8Array> {
  return withTemp(async (dir) => {
    const out = join(dir, "clip.mp4");
    await run(
      "ffmpeg",
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-ss",
        String(opts.start),
        "-t",
        String(opts.seconds),
        "-an",
        "-vf",
        `scale=${opts.width}:-2`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        out,
      ],
      LIMITS,
    );
    return new Uint8Array(await readFile(out));
  });
}

/** Evenly spaced keyframes from a video, as RGBA PNG artifacts. */
export function ffmpegSampler(opts: { frames?: number; width?: number } = {}): FrameSampler {
  const count = opts.frames ?? 10;
  const width = opts.width ?? 768;
  return {
    model: { provider: "aye", model: "ffmpeg-keyframes", version: `1/${count}x${width}` },
    async sample(video: ArtifactRef, ctx: ProviderContext): Promise<FrameSet> {
      const bytes = await ctx.store.get(video.hash);
      if (!bytes) throw new Error(`missing video ${video.hash}`);
      return withTemp(async (dir) => {
        const input = join(dir, "in");
        await writeFile(input, bytes);
        const seconds = await probeSeconds(input);
        const frames: FrameSet["frames"] = [];
        let size = { w: 0, h: 0 };
        for (let i = 0; i < count; i++) {
          const t = ((i + 0.5) * seconds) / count;
          const out = join(dir, `f${i}.png`);
          await run(
            "ffmpeg",
            [
              "-nostdin",
              "-loglevel",
              "error",
              "-y",
              "-ss",
              t.toFixed(3),
              "-i",
              input,
              "-frames:v",
              "1",
              "-vf",
              `scale=${width}:-2`,
              "-pix_fmt",
              "rgba",
              out,
            ],
            LIMITS,
          );
          const png = new Uint8Array(await readFile(out));
          // IHDR width and height sit at fixed offsets in every PNG.
          const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
          size = { w: view.getUint32(16), h: view.getUint32(20) };
          frames.push({
            index: i,
            timeMs: Math.round(t * 1000),
            image: await ctx.store.put(png, "image/png"),
          });
        }
        return { frames, widthPx: size.w, heightPx: size.h };
      });
    },
  };
}
