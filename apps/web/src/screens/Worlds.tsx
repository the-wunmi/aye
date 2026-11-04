/**
 * The start screen: where do you want to live? Film somewhere real and it joins a city, or
 * describe a place or a whole city and a model builds it around those words. Below that, the
 * cities you can walk into now. Someone building a new one sees what it's doing and how long
 * these usually take, measured from real builds.
 */
import { placesOf } from "@aye/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { type BuildRange, usualWait, waitNote } from "../game/build-time.ts";
import { watchBuild } from "../game/build-watch.ts";
import { askToNotify } from "../game/notify.ts";
import type { CityBundle, WorldSummary } from "../game/types.ts";
import { Skyline } from "./Skyline.tsx";

const EXAMPLE = "A street, a shop, someone's home, or a whole city";

interface Progress {
  built: number;
  total: number | null;
  /** Made with an older version of the game: it can't be played, only deleted. */
  outdated: boolean;
}

export function Worlds({
  handle,
  notice,
  onPlay,
  onLogout,
}: {
  handle: string;
  /** Why they're here and not where a link was taking them. */
  notice?: string;
  /** Into a city; if they came to film something, that opens as they arrive. */
  onPlay(world: WorldSummary, film: boolean): void;
  onLogout(): void;
}) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [progressView, setProgress] = useState<Record<string, Progress>>({});
  const progress = useRef<Record<string, Progress>>({});
  const [description, setDescription] = useState("");
  const [publicCity, setPublicCity] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(notice ?? null);
  const [busy, setBusy] = useState(false);
  const [way, setWay] = useState<"film" | "describe" | null>(null);
  const [typical, setTypical] = useState<BuildRange | null>(null);

  /** What's known of each city, by world and city version: fetched once, not every tick. */
  const known = useRef(
    new Map<string, { city: string; total: number | null; outdated: boolean }>(),
  );
  const refresh = useCallback(async () => {
    const res = await api<{ worlds: WorldSummary[]; typicalBuild: BuildRange | null }>("/worlds");
    setWorlds(res.worlds);
    setTypical(res.typicalBuild);
    let building = false;
    for (const w of res.worlds.filter((x) => x.owner && x.status !== "failed")) {
      const seen = known.current.get(w.id);
      const prev = progress.current[w.id];
      // Done: its city is known, and every place is built (or it can't be played at all).
      if (
        seen &&
        seen.city === w.city &&
        w.status === "ready" &&
        (seen.outdated || (prev && seen.total !== null && prev.built >= seen.total))
      ) {
        continue;
      }
      building = true;
      const detail = await api<{ world: { places: unknown[] } }>(`/worlds/${w.id}`);
      let info = seen && seen.city === w.city ? seen : null;
      if (!info && w.city) {
        let outdated = false;
        const city = await api<CityBundle>(`/worlds/${w.id}/city`).catch((e: unknown) => {
          outdated = e instanceof ApiError && e.status === 410;
          return null;
        });
        info = { city: w.city, total: city ? placesOf(city.city).length : null, outdated };
        known.current.set(w.id, info);
      }
      const next = {
        built: detail.world.places.length,
        total: info?.total ?? null,
        outdated: info?.outdated ?? false,
      };
      progress.current = { ...progress.current, [w.id]: next };
      setProgress(progress.current);
    }
    return building || res.worlds.some((w) => w.status === "building");
  }, []);

  // Poll while anything is still being built; stop when everything is settled (a new city
  // starts it again).
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const again = await refresh().catch(() => true);
      if (live && again) timer = setTimeout(() => void tick(), 5_000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [refresh, polls]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      askToNotify();
      const { world } = await api<{ world: { id: string } }>("/worlds", {
        description: description.trim(),
        visibility: publicCity ? "public" : "private",
      });
      watchBuild(world.id);
      setDescription("");
      setWay(null);
      setPolls((n) => n + 1);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "rate_limited"
          ? "You've made a lot of cities this hour. Try again later."
          : "Describe it in a sentence or two (at least 10 characters).",
      );
    } finally {
      setBusy(false);
    }
  };

  const play = async (w: WorldSummary, film = false) => {
    setPlayError(null);
    if (!w.owner) await api(`/worlds/${w.id}/join`, {}).catch(() => null);
    // A city made by an older version of the game can't be played: say so, don't just sit there.
    const gone = await api(`/worlds/${w.id}/city`).then(
      () => false,
      (e: unknown) => e instanceof ApiError && e.status === 410,
    );
    if (gone) {
      setPlayError(`${w.name} was made with an older version of Ayé and can't be played any more.`);
      return;
    }
    onPlay(w, film);
  };

  const remove = async (w: WorldSummary) => {
    if (!window.confirm(`Delete ${w.name}? Everyone's characters and chat in it go too.`)) return;
    await api(`/worlds/${w.id}`, {}, "DELETE").catch(() => null);
    setWorlds((list) => list?.filter((x) => x.id !== w.id) ?? null);
  };
  const mine = worlds?.filter((w) => w.owner || w.joined) ?? [];
  const others = worlds?.filter((w) => !w.owner && !w.joined) ?? [];

  const ready = worlds?.filter((w) => w.status === "ready") ?? [];

  return (
    <div className="home">
      <Skyline />
      <div className="home-page">
        <header className="page-head">
          <span className="home-logo">Ayé</span>
          <span className="grow" />
          <span className="home-who">@{handle}</span>
          <button type="button" className="link" onClick={onLogout}>
            Log out
          </button>
        </header>

        <section className="home-hero">
          <h1>Where do you want to live?</h1>
          <p>Somewhere real or somewhere you've imagined. Everyone here lives in it with you.</p>
          <div className="home-ways">
            <button
              type="button"
              className="home-way"
              aria-expanded={way === "film"}
              onClick={() => setWay(way === "film" ? null : "film")}
            >
              <span aria-hidden="true">🎥</span>
              <strong>Film a place</strong>
              <small>Walk around with your phone. It joins a city.</small>
            </button>
            <button
              type="button"
              className="home-way"
              aria-expanded={way === "describe"}
              onClick={() => setWay(way === "describe" ? null : "describe")}
            >
              <span aria-hidden="true">✏️</span>
              <strong>Describe a place</strong>
              <small>One spot or a whole city, in your own words.</small>
            </button>
          </div>

          {way === "film" && (
            <div className="home-tray">
              {ready.length === 0 ? (
                <p>
                  There's no city to add it to yet. Describe one first, then film yours into it.
                </p>
              ) : (
                <>
                  <p>Which city should it join?</p>
                  <div className="home-picks">
                    {ready.map((w) => (
                      <button
                        type="button"
                        className="home-pick"
                        key={w.id}
                        onClick={() => void play(w, true)}
                      >
                        {w.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {way === "describe" && (
            <div className="home-tray">
              <textarea
                rows={3}
                value={description}
                maxLength={2000}
                placeholder={EXAMPLE}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Describe the place"
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={publicCity}
                  onChange={(e) => setPublicCity(e.target.checked)}
                />
                Open to everyone when it's ready
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy || description.trim().length < 10}
                onClick={create}
              >
                Build it
              </button>
              <p className="home-wait">
                Usually {usualWait(typical)}. Keep playing or switch tabs, and we'll tell you when
                it's ready.
              </p>
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
            </div>
          )}
        </section>

        {worlds === null && <p className="home-wait">Loading…</p>}
        {playError && (
          <div className="error" role="alert">
            {playError}
          </div>
        )}
        {mine.length > 0 && (
          <section>
            <h2>Your cities</h2>
            <div className="cards">
              {mine.map((w) => (
                <CityCard
                  key={w.id}
                  w={w}
                  typical={typical}
                  progress={progressView[w.id]}
                  onPlay={() => void play(w)}
                  {...(w.owner ? { onDelete: () => void remove(w) } : {})}
                />
              ))}
            </div>
          </section>
        )}
        {others.length > 0 && (
          <section>
            <h2>Open to walk into</h2>
            <div className="cards">
              {others.map((w) => (
                <CityCard
                  key={w.id}
                  w={w}
                  typical={typical}
                  progress={undefined}
                  onPlay={() => void play(w)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * What the model wrote for this city, counted from the city itself: the plainest proof that
 * none of it is in our code. Fetched only when someone opens it.
 */
function Making({ w }: { w: WorldSummary }) {
  const [counts, setCounts] = useState<{ label: string; n: number }[] | null>(null);
  const [failed, setFailed] = useState(false);
  if (w.status !== "ready") return null;
  const load = async () => {
    if (counts || failed) return;
    const made = await api<{
      places: number;
      actions: number;
      needs: number;
      marks: number;
      starts: number;
      apps: number;
    }>(`/worlds/${w.id}/making`).catch(() => null);
    if (!made) {
      setFailed(true);
      return;
    }
    setCounts([
      { label: "places designed", n: made.places },
      { label: "things you can do", n: made.actions },
      { label: "needs", n: made.needs },
      { label: "skills and standings", n: made.marks },
      { label: "ways to start a life", n: made.starts },
      { label: "apps", n: made.apps },
    ]);
  };
  return (
    <details className="making small" onToggle={(e) => e.currentTarget.open && void load()}>
      <summary className="muted">How this was made</summary>
      {failed && <p className="muted">Couldn't read this city.</p>}
      {counts && (
        <>
          <p>
            Nobody wrote this city by hand. Muse Spark designed it from the words above, down to its
            prices and this game's interface. Every place was then played by a simulator and sent
            back to be fixed before it opened.
          </p>
          <ul className="plain">
            {counts.map((c) => (
              <li key={c.label}>
                <strong>{c.n}</strong> {c.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

function BuildingNote({ w, typical }: { w: WorldSummary; typical: BuildRange | null }) {
  return (
    <div className="building" role="status">
      <span className="spinner" aria-hidden />
      <div>
        {w.buildNote && <div>{w.buildNote}</div>}
        <div className="small">{waitNote(Date.parse(w.madeAt), Date.now(), typical)}</div>
      </div>
    </div>
  );
}

function CityCard({
  w,
  typical,
  progress,
  onPlay,
  onDelete,
}: {
  w: WorldSummary;
  typical: BuildRange | null;
  progress: Progress | undefined;
  onPlay(): void;
  /** Yours only: delete it, after asking. */
  onDelete?: () => void;
}) {
  return (
    <div className="card">
      <h3>{w.name}</h3>
      {(w.online ?? 0) > 0 && <div className="home-live">{w.online} here now</div>}
      <p className="muted small clamp">{w.description}</p>
      {w.status === "building" ? (
        <BuildingNote w={w} typical={typical} />
      ) : w.status === "failed" ? (
        <div className="error">This city couldn't be built.</div>
      ) : progress?.outdated ? (
        <div className="muted small">
          Made with an older version of Ayé, so it can't be played. Make it again above.
        </div>
      ) : (
        <>
          <button type="button" className="primary" onClick={onPlay}>
            Play
          </button>
          {progress?.total && progress.built < progress.total ? (
            <div className="building small" role="status">
              <span className="spinner" aria-hidden />
              {progress.built} of {progress.total} places ready, the rest on the way
            </div>
          ) : null}
        </>
      )}
      <Making w={w} />
      <div className="card-foot muted small">
        <span>
          {w.visibility === "public" ? "Open to everyone" : "Private"} · made{" "}
          {new Date(w.madeAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
        </span>
        {onDelete && (
          <button type="button" className="link danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
