/**
 * Film a real place into the city. Choose a video from the phone (or record one), say what it
 * is if you like, optionally tap where it stands on the map; then keep playing while it's
 * built. A small card says how far along it is, and takes you there when it's ready.
 *
 * The video goes to our own server only, and to nobody else in the city: faces and number
 * plates are blurred before anything is shown to a model that isn't finding them, and other
 * players only ever get the place made from it. The card says so, because people should know
 * before they film their home.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

const STORE_KEY = (worldId: string) => `aye.filming.${worldId}`;
const MAX_MINUTES = 3;
const MAX_BYTES = 300 * 1024 * 1024;

/** What each phase of building is, for the person waiting. */
const PHASES: Record<string, string> = {
  seeing: "Looking at your video. Faces and number plates get blurred first.",
  writing: "Working out what everything in it does.",
  furnishing: "Matching everything to something like it.",
  painting: "Painting your real floor, walls and things.",
  joining: "Finding its place in the city.",
};
const ORDER = ["seeing", "writing", "furnishing", "painting", "joining"];

type Progress =
  | { state: "uploading"; share: number }
  | { state: "building"; id: string; phase: string | null }
  | { state: "ready"; id: string; placeKey: string }
  | { state: "failed"; why: string };

function upload(
  worldId: string,
  file: File,
  query: URLSearchParams,
  onShare: (share: number) => void,
): Promise<string> {
  // Not fetch: a video takes a while on a phone connection, and people should see it going.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/worlds/${encodeURIComponent(worldId)}/captures?${query}`);
    xhr.setRequestHeader("content-type", file.type || "video/mp4");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onShare(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status !== 202) {
        reject(
          new Error(
            xhr.status === 413
              ? "too_large"
              : xhr.status === 429
                ? "too_many"
                : xhr.status === 400 || xhr.status === 415
                  ? "bad_file"
                  : "failed",
          ),
        );
        return;
      }
      try {
        resolve((JSON.parse(xhr.responseText) as { capture: { id: string } }).capture.id);
      } catch {
        reject(new Error("failed"));
      }
    };
    xhr.onerror = () => reject(new Error("failed"));
    xhr.send(file);
  });
}

const UPLOAD_ERRORS: Record<string, string> = {
  too_large: "That video is too big. Try a shorter one.",
  too_many: "You've filmed a lot just now. Try again in a while.",
  failed: "That didn't upload. Check your connection and try again.",
  bad_file: "That doesn't look like a video we can read. Try an MP4 or MOV.",
};

/** How long a video runs, in milliseconds; 0 if the browser can't tell. */
function durationOf(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    const done = (ms: number) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    v.onloadedmetadata = () =>
      done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0);
    v.onerror = () => done(0);
    // Some phones' formats never answer here; not knowing how long it is shouldn't stop anyone.
    setTimeout(() => done(0), 3_000);
    v.src = url;
  });
}

export function FilmPlace({
  worldId,
  cityName,
  spot,
  picking,
  onPick,
  onReady,
  onGo,
}: {
  worldId: string;
  cityName: string;
  /** The spot chosen on the map, metres; null: near where you are. */
  spot: [number, number] | null;
  picking: boolean;
  onPick(picking: boolean): void;
  /** It's in the city: fetch the city again so it's on the map. */
  onReady(): void;
  onGo(placeKey: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(() => {
    const id = localStorage.getItem(STORE_KEY(worldId));
    return id ? { state: "building", id, phase: null } : null;
  });
  const ready = useRef(onReady);
  ready.current = onReady;

  // While it's being built: ask how it's going, and carry on after a reload.
  const buildingId = progress?.state === "building" ? progress.id : null;
  useEffect(() => {
    if (!buildingId) return;
    let live = true;
    const check = async () => {
      const s = await api<{ status: string; phase: string | null; placeKey: string | null }>(
        `/worlds/${worldId}/captures/${buildingId}`,
      ).catch(() => null);
      if (!live) return;
      if (!s) {
        localStorage.removeItem(STORE_KEY(worldId));
        setProgress(null);
      } else if (s.status === "ready" && s.placeKey) {
        localStorage.removeItem(STORE_KEY(worldId));
        setProgress({ state: "ready", id: buildingId, placeKey: s.placeKey });
        ready.current();
      } else if (s.status === "failed") {
        localStorage.removeItem(STORE_KEY(worldId));
        setProgress({
          state: "failed",
          why: "We couldn't make a place from that video. Try one that walks slowly around the room.",
        });
      } else {
        setProgress({ state: "building", id: buildingId, phase: s.phase });
      }
    };
    void check();
    const t = setInterval(() => void check(), 3_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [buildingId, worldId]);

  const choose = async (f: File | null) => {
    setProblem(null);
    setFile(null);
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setProblem(UPLOAD_ERRORS["too_large"] as string);
      return;
    }
    const ms = await durationOf(f);
    if (ms > MAX_MINUTES * 60_000) {
      setProblem(`That's over ${MAX_MINUTES} minutes. Thirty seconds to a minute is plenty.`);
      return;
    }
    setFile(f);
  };

  const send = async () => {
    if (!file) return;
    const query = new URLSearchParams({ durationMs: String(await durationOf(file)) });
    if (note.trim()) query.set("note", note.trim());
    if (spot) {
      query.set("x", String(Math.round(spot[0])));
      query.set("z", String(Math.round(spot[1])));
    }
    setOpen(false);
    setProgress({ state: "uploading", share: 0 });
    try {
      const id = await upload(worldId, file, query, (share) =>
        setProgress({ state: "uploading", share }),
      );
      localStorage.setItem(STORE_KEY(worldId), id);
      setProgress({ state: "building", id, phase: null });
      setFile(null);
      setNote("");
    } catch (e) {
      if ((e as Error).message === "bad_file") setFile(null);
      setProgress({
        state: "failed",
        why: UPLOAD_ERRORS[(e as Error).message] ?? (UPLOAD_ERRORS["failed"] as string),
      });
    }
  };

  if (picking) {
    return (
      <div className="w w-card film-card film-picking" role="status">
        <strong>Tap where it is on the map</strong>
        <button type="button" className="link" onClick={() => onPick(false)}>
          Cancel
        </button>
      </div>
    );
  }

  if (progress) {
    return (
      <div className="w w-card film-card" role="status" aria-live="polite">
        {progress.state === "uploading" && (
          <>
            <strong>Sending your video</strong>
            <span className="working-bar" aria-hidden>
              <span style={{ width: `${Math.round(progress.share * 100)}%` }} />
            </span>
          </>
        )}
        {progress.state === "building" && (
          <>
            <strong>Building your place</strong>
            <span className="muted small">
              {PHASES[progress.phase ?? "seeing"] ?? PHASES["seeing"]}
            </span>
            <span className="working-bar" aria-hidden>
              <span
                style={{
                  width: `${Math.round(
                    ((Math.max(0, ORDER.indexOf(progress.phase ?? "seeing")) + 0.5) /
                      ORDER.length) *
                      100,
                  )}%`,
                }}
              />
            </span>
            <span className="muted small">Usually 5 to 10 minutes. Keep playing.</span>
          </>
        )}
        {progress.state === "ready" && (
          <>
            <strong>Your place is in {cityName}</strong>
            <div className="film-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setProgress(null);
                  onGo(progress.placeKey);
                }}
              >
                Go there
              </button>
              <button type="button" className="link" onClick={() => setProgress(null)}>
                Later
              </button>
            </div>
          </>
        )}
        {progress.state === "failed" && (
          <>
            <strong>That didn't work</strong>
            <span className="muted small">{progress.why}</span>
            <button type="button" className="link" onClick={() => setProgress(null)}>
              OK
            </button>
          </>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="sys-pill film-open" onClick={() => setOpen(true)}>
        <span aria-hidden>{"\u{1F3A5}"}</span> Film a real place
      </button>
    );
  }

  return (
    <div className="w w-card film-card" role="dialog" aria-label="Film a real place">
      <strong>Film a real place into {cityName}</strong>
      <span className="muted small">
        Walk slowly around your room, shop or street for 30 seconds to a minute. Everything you film
        becomes something people can really use here.
      </span>
      <label className="film-file">
        <span>{file ? file.name : "Choose or record a video"}</span>
        <input
          className="film-file-input"
          type="file"
          accept="video/*"
          onChange={(e) => void choose(e.target.files?.[0] ?? null)}
        />
      </label>
      <input
        className="film-note"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What is it? (my kitchen, the shop on the corner…)"
        aria-label="What is it?"
      />
      <button type="button" className="link film-spot" onClick={() => onPick(true)}>
        {spot
          ? "\u{1F4CD} Spot chosen. Change it"
          : "\u{1F4CD} Choose where on the map (or near you)"}
      </button>
      <span className="muted small">
        Faces and number plates are blurred. Other players only see the place made from your video,
        never the video itself, and anyone in this city can visit it.
      </span>
      {problem && (
        <span className="t-bad small" role="alert">
          {problem}
        </span>
      )}
      <div className="film-actions">
        <button type="button" className="primary" disabled={!file} onClick={() => void send()}>
          Build it
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Not now
        </button>
      </div>
    </div>
  );
}
