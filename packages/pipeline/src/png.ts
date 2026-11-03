/**
 * Minimal PNG codec for 8-bit RGBA, using the platform's CompressionStream /
 * DecompressionStream (zlib), so it runs unchanged in Node and browsers.
 *
 * Decoding treats input as hostile (it comes from image models): dimensions are checked
 * against limits before anything is inflated, inflation stops at the exact expected size
 * (no decompression bombs), CRCs are verified, and anything outside the one format we accept
 * (RGBA, 8-bit, non-interlaced) is rejected rather than half-supported.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes, row-major, non-premultiplied. */
  data: Uint8Array;
}

export class PngError extends Error {
  constructor(message: string) {
    super(`png: ${message}`);
    this.name = "PngError";
  }
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pump(
  stream: TransformStream<Uint8Array, Uint8Array>,
  input: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer
    .write(input)
    .then(() => writer.close())
    .catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PngError("decompressed data exceeds the declared image size");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const { width, height, data } = image;
  if (data.byteLength !== width * height * 4)
    throw new PngError("data size does not match dimensions");
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const idat = await pump(
    new CompressionStream("deflate") as TransformStream<Uint8Array, Uint8Array>,
    raw,
    Number.MAX_SAFE_INTEGER,
  );

  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.byteLength);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.byteLength, crc32(out, 4, 8 + body.byteLength));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, adaptive filtering, no interlace
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function decodePng(bytes: Uint8Array, maxSide: number): Promise<RgbaImage> {
  if (bytes.byteLength < 8 || SIGNATURE.some((b, i) => bytes[i] !== b))
    throw new PngError("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let at = 8;
  let sawEnd = false;
  while (at + 12 <= bytes.byteLength) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 8 + length;
    if (end + 4 > bytes.byteLength) throw new PngError(`truncated ${type} chunk`);
    if (crc32(bytes, at + 4, end) !== view.getUint32(end)) throw new PngError(`bad CRC in ${type}`);
    const body = bytes.subarray(at + 8, end);
    if (type === "IHDR") {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || colour !== 6 || interlace !== 0)
        throw new PngError("only 8-bit RGBA, non-interlaced PNGs are accepted");
      if (width < 1 || height < 1 || width > maxSide || height > maxSide)
        throw new PngError(`dimensions ${width}×${height} out of range`);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    at = end + 4;
  }
  if (!sawEnd || width === 0 || idat.length === 0) throw new PngError("missing IHDR, IDAT or IEND");

  const stride = width * 4;
  const expected = height * (stride + 1);
  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of idat) {
    compressed.set(c, o);
    o += c.byteLength;
  }
  const raw = await pump(
    new DecompressionStream("deflate") as TransformStream<Uint8Array, Uint8Array>,
    compressed,
    expected,
  );
  if (raw.byteLength !== expected) throw new PngError("image data has the wrong size");

  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? (row[x - 4] as number) : 0;
      const b = prev ? (prev[x] as number) : 0;
      const c = prev && x >= 4 ? (prev[x - 4] as number) : 0;
      const s = src[x] as number;
      let value: number;
      switch (filter) {
        case 0:
          value = s;
          break;
        case 1:
          value = s + a;
          break;
        case 2:
          value = s + b;
          break;
        case 3:
          value = s + Math.floor((a + b) / 2);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = s + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new PngError(`unknown filter ${filter}`);
      }
      row[x] = value & 0xff;
    }
  }
  return { width, height, data };
}
