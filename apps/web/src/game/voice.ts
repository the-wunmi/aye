/**
 * Talking to people with your voice: recording from the microphone and turning it into what the
 * transcriber takes (mono 16-bit PCM WAV at 16 kHz). Recording only runs while the button is
 * held, and the sound goes to our server for this one request and is never kept.
 */

export const SPEECH_RATE = 16_000;
/** Nobody's holding the button longer than this to say one thing. */
export const MAX_SPEECH_MS = 30_000;

/** Samples (-1..1) as a WAV file. */
export function wavFromSamples(samples: Float32Array, rate = SPEECH_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => out.set(new TextEncoder().encode(s), at);
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const c = Math.max(-1, Math.min(1, s));
    v.setInt16(44 + i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  });
  return out;
}

/** Whatever the browser recorded, as speech the transcriber can read. */
export async function speechWav(recorded: Blob): Promise<Uint8Array> {
  const decoder = new AudioContext();
  const audio = await decoder.decodeAudioData(await recorded.arrayBuffer());
  void decoder.close();
  const length = Math.max(1, Math.ceil(audio.duration * SPEECH_RATE));
  const offline = new OfflineAudioContext(1, length, SPEECH_RATE);
  const source = offline.createBufferSource();
  source.buffer = audio;
  source.connect(offline.destination);
  source.start();
  const mono = await offline.startRendering();
  return wavFromSamples(mono.getChannelData(0));
}

/** Start recording; the returned function stops it and gives what was said. */
export async function startRecording(): Promise<() => Promise<Blob>> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => parts.push(e.data);
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      for (const t of stream.getTracks()) t.stop();
      resolve(new Blob(parts, { type: recorder.mimeType }));
    };
  });
  recorder.start();
  const limit = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, MAX_SPEECH_MS);
  return () => {
    clearTimeout(limit);
    if (recorder.state === "recording") recorder.stop();
    return finished;
  };
}

/** Say a line out loud, in whatever voice the player's browser has. */
export function speak(text: string): void {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
