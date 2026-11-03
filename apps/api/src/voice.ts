/**
 * Speech to text for talking to people in the game, through Muse Voice Transcribe. A transcript
 * is the player's own words, exactly as if typed: it goes back to them, and they say it through
 * the realm like any chat line, with all the same checks.
 *
 * Voices are nobody's to keep: the audio is held only for this one request and never stored, so
 * this isn't a recipe-cached stage and doesn't go through the queue (both would save it). That
 * is also why it's here rather than in the worker. The key stays on the server, is never in a
 * response, and errors carry a status only.
 */

const MODEL = "muse-voice-transcribe-1.0";
const ENDPOINT = "https://api.meta.ai/v1/asr/transcribe";

export type Transcribe = (
  wav: Uint8Array,
  keywords: readonly string[],
  sessionId: string,
) => Promise<string>;

export const MAX_VOICE_BYTES = 3 * 1024 * 1024;
/** Words to listen out for (places and things here): more than this doesn't help. */
export const MAX_KEYWORDS = 40;
const MAX_KEYWORD_CHARS = 30;

/** What the model takes: mono 16-bit PCM WAV at 16 or 24 kHz. Anything else isn't sent. */
export function isSpeechWav(b: Uint8Array): boolean {
  if (b.byteLength < 44) return false;
  const text = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (text(0, 4) !== "RIFF" || text(8, 12) !== "WAVE") return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // Files may carry other chunks before the format: walk to it (chunks are padded to even).
  for (let at = 12; at + 24 <= b.byteLength; ) {
    const size = v.getUint32(at + 4, true);
    if (text(at, at + 4) === "fmt ") {
      const format = v.getUint16(at + 8, true);
      const channels = v.getUint16(at + 10, true);
      const rate = v.getUint32(at + 12, true);
      const bits = v.getUint16(at + 22, true);
      return format === 1 && channels === 1 && bits === 16 && (rate === 16_000 || rate === 24_000);
    }
    at += 8 + size + (size % 2);
  }
  return false;
}

/**
 * The words worth listening out for, as the model takes them: each one fits its limit, once
 * each, shortest first (names and short words are what it most often mishears).
 */
export function speechKeywords(words: readonly string[]): string[] {
  return [...new Set(words.map((w) => w.trim()))]
    .filter((w) => w.length > 0 && w.length <= MAX_KEYWORD_CHARS)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_KEYWORDS);
}

export function museTranscribe(apiKey: string, doFetch: typeof fetch = fetch): Transcribe {
  return async (wav, keywords, sessionId) => {
    const form = new FormData();
    form.set(
      "request",
      new Blob(
        [
          JSON.stringify({
            mode: "PUSH_TO_TALK",
            model: MODEL,
            audioEncoding: "WAV",
            keywords: speechKeywords(keywords),
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.set("audio", new Blob([wav.slice()], { type: "audio/wav" }), "speech.wav");
    const res = await doFetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`transcribe: HTTP ${res.status}`);
    const data = (await res.json()) as { transcript?: unknown };
    return typeof data.transcript === "string" ? data.transcript : "";
  };
}
