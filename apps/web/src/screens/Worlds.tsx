import { placesOf } from "@aye/schema";
/**
 * Cities: the ones you made or joined, open ones anyone can join, and a box to describe a new
 * one in your own words. A new city is written and built by models in the background; this
 * shows its progress (the city first, then each place) until it opens.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import type { CityBundle, WorldSummary } from "../game/types.ts";

const EXAMPLE =
  "Lagos: the mainland and the island across the lagoon, buka food, danfo buses and okadas, Yaba tech hubs, markets and beaches, hustling to make rent.";

interface Progress {
  built: number;
  total: number | null;
  /** Made with an older version of the game: it can't be played, only deleted. */
  outdated: boolean;
}

export function Worlds({
  handle,
  onPlay,
  onLogout,
}: {
  handle: string;
  onPlay(world: WorldSummary): void;
  onLogout(): void;
}) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [progressView, setProgress] = useState<Record<string, Progress>>({});
  const progress = useRef<Record<string, Progress>>({});
  const [description, setDescription] = useState("");
  const [publicCity, setPublicCity] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** What's known of each city, by world and city version: fetched once, not every tick. */
  const known = useRef(
    new Map<string, { city: string; total: number | null; outdated: boolean }>(),
  );
  const refresh = useCallback(async () => {
    const res = await api<{ worlds: WorldSummary[] }>("/worlds");
    setWorlds(res.worlds);
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
      await api("/worlds", {
        description: description.trim(),
        visibility: publicCity ? "public" : "private",
      });
      setDescription("");
      setPolls((n) => n + 1);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "rate_limited"
          ? "You've made a lot of cities this hour. Try again later."
          : "Describe your city in a sentence or two (at least 10 characters).",
      );
    } finally {
      setBusy(false);
    }
  };

  const play = async (w: WorldSummary) => {
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
    onPlay(w);
  };

  const remove = async (w: WorldSummary) => {
    if (!window.confirm(`Delete ${w.name}? Everyone's characters and chat in it go too.`)) return;
    await api(`/worlds/${w.id}`, {}, "DELETE").catch(() => null);
    setWorlds((list) => list?.filter((x) => x.id !== w.id) ?? null);
  };
  const mine = worlds?.filter((w) => w.owner || w.joined) ?? [];
  const others = worlds?.filter((w) => !w.owner && !w.joined) ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="logo">Ayé</h1>
        <span className="grow" />
        <span className="muted">@{handle}</span>
        <button type="button" className="link" onClick={onLogout}>
          Log out
        </button>
      </header>

      <section className="panel">
        <h2>Make a city</h2>
        <p className="muted">
          Describe any city or neighbourhood. A model designs it (its map, places, people, prices,
          transport, even this game's interface), then builds every place in it. You can start
          playing in about 15 minutes; the rest of its places follow.
        </p>
        <textarea
          rows={3}
          value={description}
          maxLength={2000}
          placeholder={EXAMPLE}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Describe your city"
        />
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={publicCity}
              onChange={(e) => setPublicCity(e.target.checked)}
            />
            Open to everyone when it's ready
          </label>
          <span className="grow" />
          <button
            type="button"
            className="primary"
            disabled={busy || description.trim().length < 10}
            onClick={create}
          >
            Build it
          </button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </section>

      {worlds === null && <p className="muted">Loading…</p>}
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
          <h2>Open cities</h2>
          <div className="cards">
            {others.map((w) => (
              <CityCard key={w.id} w={w} progress={undefined} onPlay={() => void play(w)} />
            ))}
          </div>
        </section>
      )}
      {worlds !== null && worlds.length === 0 && (
        <p className="muted">No cities yet. Describe one above to start.</p>
      )}
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

function CityCard({
  w,
  progress,
  onPlay,
  onDelete,
}: {
  w: WorldSummary;
  progress: Progress | undefined;
  onPlay(): void;
  /** Yours only: delete it, after asking. */
  onDelete?: () => void;
}) {
  return (
    <div className="card">
      <h3>{w.name}</h3>
      <p className="muted small clamp">{w.description}</p>
      {w.status === "building" ? (
        <div className="building" role="status">
          <span className="spinner" aria-hidden />
          {!w.city
            ? "Designing the city…"
            : `Building places: ${progress?.built ?? 0}${progress?.total ? ` of ${progress.total}` : ""}`}
        </div>
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
