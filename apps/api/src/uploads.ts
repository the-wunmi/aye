/**
 * A video arriving in pieces. Proxies often limit the size of any one request, and a phone on a
 * poor connection shouldn't have to start a long upload again from the beginning, so the page
 * sends short pieces in order, and the finished video is taken as a whole at the end.
 *
 * Each upload belongs to whoever started it: the file's name comes from their user id and an id
 * checked to be plain letters and digits, so neither can point anywhere else. A second try of the
 * last piece is forgiven, because that's what a dropped connection looks like. Anything abandoned
 * is cleared away.
 */
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Sent by the page: well under common request limits, and short enough to resend on a bad line. */
export const UPLOAD_PIECE_BYTES = 16 * 1024 * 1024;
/** How long an upload may sit unfinished. */
const ABANDONED_MS = 60 * 60_000;
/** Started and not finished, per person: a page reloaded a few times, not a disk filled. */
const MAX_OPEN_PER_USER = 3;

export const UPLOAD_ID = /^[0-9a-z]{12,40}$/;
const USER_ID = /^[0-9a-z_]{1,64}$/;

interface Open {
  userId: string;
  next: number;
  bytes: number;
  lastPieceBytes: number;
  mediaType: string;
  touched: number;
}

export type PieceResult = "ok" | "out_of_order" | "too_large" | "too_many";

export class VideoUploads {
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #open = new Map<string, Open>();

  constructor(dir: string, maxBytes: number, now: () => number = Date.now) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  /** Names a file, so it takes nothing but plain ids, whatever the route already checked. */
  #key(userId: string, id: string): string {
    if (!USER_ID.test(userId) || !UPLOAD_ID.test(id)) throw new Error("bad upload id");
    return `${userId}-${id}`;
  }

  #file(key: string): string {
    return join(this.#dir, `${key}.part`);
  }

  async #sweep(): Promise<void> {
    const cutoff = this.#now() - ABANDONED_MS;
    for (const [key, u] of this.#open) {
      if (u.touched < cutoff) await this.#forget(key);
    }
  }

  async #forget(key: string): Promise<void> {
    this.#open.delete(key);
    await rm(this.#file(key), { force: true });
  }

  /** Add the next piece. A resend of the last one is taken as already done. */
  async piece(
    userId: string,
    id: string,
    index: number,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<PieceResult> {
    await this.#sweep();
    const key = this.#key(userId, id);
    let u = this.#open.get(key);
    if (!u) {
      if (index !== 0) return "out_of_order";
      const open = [...this.#open.values()].filter((x) => x.userId === userId).length;
      if (open >= MAX_OPEN_PER_USER) return "too_many";
      await mkdir(this.#dir, { recursive: true });
      await rm(this.#file(key), { force: true });
      u = { userId, next: 0, bytes: 0, lastPieceBytes: 0, mediaType, touched: this.#now() };
      this.#open.set(key, u);
    }
    if (index === u.next - 1 && bytes.byteLength === u.lastPieceBytes) return "ok";
    if (index !== u.next || mediaType !== u.mediaType) return "out_of_order";
    if (u.bytes + bytes.byteLength > this.#maxBytes) {
      await this.#forget(key);
      return "too_large";
    }
    await appendFile(this.#file(key), bytes);
    u.next++;
    u.bytes += bytes.byteLength;
    u.lastPieceBytes = bytes.byteLength;
    u.touched = this.#now();
    return "ok";
  }

  /** The whole video, once; null if this person has no such upload. */
  async take(userId: string, id: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
    const key = this.#key(userId, id);
    const u = this.#open.get(key);
    if (!u || u.next === 0) return null;
    const bytes = new Uint8Array(await readFile(this.#file(key)));
    await this.#forget(key);
    return { bytes, mediaType: u.mediaType };
  }
}
