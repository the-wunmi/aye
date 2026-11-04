/**
 * The game shell: who you are, which city, your character, then the city itself. Each city
 * themes the whole app with the look its model chose; outside a city, Ayé's own look applies.
 */
import type { Character } from "@aye/schema";
import { useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import { doneLine, useBuildWatch } from "./game/build-watch.ts";
import type { CityBundle, WorldSummary } from "./game/types.ts";
import { parseRoute, pathOf, type Route } from "./route.ts";
import { Auth } from "./screens/Auth.tsx";
import { Crashed } from "./screens/Crashed.tsx";
import { CreateCharacter } from "./screens/CreateCharacter.tsx";
import { Game } from "./screens/Game.tsx";
import { rememberCity, Worlds } from "./screens/Worlds.tsx";
import { applyTheme } from "./theme.ts";

type Screen =
  | { at: "loading" }
  | { at: "auth" }
  | { at: "worlds"; handle: string; notice?: string }
  | { at: "opening"; handle: string; route: Route }
  | { at: "entering"; handle: string; world: WorldSummary; film?: boolean; place?: string | null }
  | {
      at: "create";
      handle: string;
      world: WorldSummary;
      bundle: CityBundle;
      film?: boolean;
      place?: string | null;
    }
  | {
      at: "play";
      handle: string;
      world: WorldSummary;
      bundle: CityBundle;
      character: Character;
      film?: boolean;
      place?: string | null;
    };

const LINK_TROUBLE = "That link isn't open to you, or the city isn't ready yet.";

export function App() {
  const [screen, setScreen] = useState<Screen>({ at: "loading" });
  const [guest, setGuest] = useState(false);

  // Signed out only when the server says so; if it can't be reached yet, keep trying.
  useEffect(() => {
    let stop = false;
    const check = (wait: number) => {
      api<{ handle: string; guest?: boolean }>("/me")
        .then((me) => {
          if (stop) return;
          setGuest(me.guest === true);
          // Wherever the address says: a link, or the same spot again after a reload.
          const route = parseRoute(location.pathname);
          setScreen(
            route
              ? { at: "opening", handle: me.handle, route }
              : { at: "worlds", handle: me.handle },
          );
        })
        .catch((err) => {
          if (stop) return;
          if (err instanceof ApiError && err.status === 401) setScreen({ at: "auth" });
          else setTimeout(() => check(Math.min(10_000, wait * 2)), wait);
        });
    };
    check(500);
    return () => {
      stop = true;
    };
  }, []);

  // The address follows where you are, and the back button follows the address. Signed out, it
  // stays as it is, so a link still goes where it said once they're in.
  const worldShown = screen.at === "play" ? screen.world.id : null;
  useEffect(() => {
    if (worldShown) rememberCity(worldShown);
  }, [worldShown]);

  const atList = screen.at === "worlds";
  useEffect(() => {
    if (worldShown && parseRoute(location.pathname)?.world !== worldShown) {
      history.pushState(null, "", pathOf(worldShown));
    } else if (atList && location.pathname !== "/") {
      history.pushState(null, "", "/");
    }
  }, [worldShown, atList]);
  useEffect(() => {
    const moved = () => location.reload();
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  }, []);

  useEffect(() => {
    const inCity = screen.at === "create" || screen.at === "play";
    applyTheme(inCity ? screen.bundle.city.theme : null);
    document.title = inCity ? `${screen.bundle.city.name} · Ayé` : "Ayé";
  }, [screen]);

  useEffect(() => {
    if (screen.at !== "opening") return;
    const { handle, route } = screen;
    void (async () => {
      const { world } = await api<{ world: WorldSummary & { role: string | null } }>(
        `/worlds/${route.world}`,
      );
      // The same as pressing Play on an open city; a private one refuses, and says nothing more.
      if (!world.role) await api(`/worlds/${route.world}/join`, {});
      setScreen({ at: "entering", handle, world, place: route.place });
    })().catch(() => setScreen({ at: "worlds", handle, notice: LINK_TROUBLE }));
  }, [screen]);

  useEffect(() => {
    if (screen.at !== "entering") return;
    const { handle, world } = screen;
    const film = screen.film === true;
    const place = screen.place ?? null;
    void (async () => {
      const bundle = await api<CityBundle>(`/worlds/${world.id}/city`);
      const { character } = await api<{ character: Character | null }>(
        `/worlds/${world.id}/character`,
      );
      setScreen(
        character
          ? { at: "play", handle, world, bundle, character, film, place }
          : { at: "create", handle, world, bundle, film, place },
      );
    })().catch(() => setScreen({ at: "worlds", handle, notice: LINK_TROUBLE }));
  }, [screen]);

  const signedIn = screen.at !== "loading" && screen.at !== "auth";
  const { finished, dismiss } = useBuildWatch(signedIn);
  const inGame = screen.at === "play" || screen.at === "create";
  const banner = finished.length > 0 && (
    <div className="build-done" role="status">
      <div>
        {finished.map((w) => (
          <div key={w.id}>{doneLine(w)}</div>
        ))}
      </div>
      {!inGame && finished.at(-1)?.status === "ready" && "handle" in screen && (
        <button
          type="button"
          className="primary"
          onClick={() => {
            const world = finished.at(-1) as WorldSummary;
            dismiss();
            setScreen({ at: "entering", handle: screen.handle, world });
          }}
        >
          Play
        </button>
      )}
      <button type="button" className="link" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );

  const view = (() => {
    switch (screen.at) {
      case "loading":
      case "entering":
        return (
          <div className="center-screen">
            <span className="spinner" role="status" aria-label="Loading" />
          </div>
        );
      case "auth":
        return (
          <Auth
            onIn={(handle, isGuest) => {
              setGuest(isGuest);
              const route = parseRoute(location.pathname);
              setScreen(route ? { at: "opening", handle, route } : { at: "worlds", handle });
            }}
          />
        );
      case "worlds":
        return (
          <Worlds
            handle={screen.handle}
            guest={guest}
            onSaved={(handle) => {
              setGuest(false);
              setScreen({ at: "worlds", handle });
            }}
            onPlay={(world, film) =>
              setScreen({ at: "entering", handle: screen.handle, world, film })
            }
            onLogout={() => {
              void api("/auth/logout", {}).finally(() => setScreen({ at: "auth" }));
            }}
          />
        );
      case "create":
        return (
          <CreateCharacter
            worldId={screen.world.id}
            bundle={screen.bundle}
            onCreated={(character) => setScreen({ ...screen, at: "play", character })}
            onBack={() => setScreen({ at: "worlds", handle: screen.handle })}
          />
        );
      case "play": {
        const { handle } = screen;
        const leave = () => setScreen({ at: "worlds", handle });
        const signedOut = () => setScreen({ at: "auth" });
        return (
          <Crashed key={screen.world.id} onBack={leave}>
            <Game
              worldId={screen.world.id}
              bundle={screen.bundle}
              character={screen.character}
              handle={screen.handle}
              guest={guest}
              onSaved={(saved) => {
                setGuest(false);
                setScreen((now) => ("handle" in now ? { ...now, handle: saved } : now));
              }}
              startFilming={screen.film === true}
              openPlace={screen.place ?? null}
              onLeave={leave}
              onSignedOut={signedOut}
            />
          </Crashed>
        );
      }
    }
  })();

  return (
    <>
      {view}
      {banner}
    </>
  );
}
