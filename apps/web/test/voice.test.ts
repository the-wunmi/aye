import { describe, expect, it } from "vitest";
import { wavFromSamples } from "../src/game/voice.ts";

describe("speech as a WAV file", () => {
  it("is what the transcriber takes: mono 16-bit PCM at 16 kHz", () => {
    const wav = wavFromSamples(new Float32Array([0, 1, -1, 2, -2]));
    const v = new DataView(wav.buffer);
    const text = (a: number, b: number) => String.fromCharCode(...wav.subarray(a, b));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 16)).toBe("WAVEfmt ");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(wav.byteLength).toBe(44 + 10);
    // Loud sound is clipped, not wrapped round.
    expect(v.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(v.getInt16(44 + 4 * 2, true)).toBe(-0x8000);
  });
});
