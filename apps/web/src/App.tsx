/**
 * The game shell: who you are, which city, your character, then the city itself. Each city
 * themes the whole app with the look its model chose; outside a city, Ayé's own look applies.
 */
import type { Character } from "@aye/schema";
import { useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import type { CityBundle, WorldSummary } from "./game/types.ts";
import { Auth } from "./screens/Auth.tsx";
import { Crashed } from "./screens/Crashed.tsx";
import { CreateCharacter } from "./screens/CreateCharacter.tsx";
import { Game } from "./screens/Game.tsx";
import { Worlds } from "./screens/Worlds.tsx";
import { applyTheme } from "./theme.ts";

type Screen =
  | { at: "loading" }
  | { at: "auth" }
  | { at: "worlds"; handle: string }
  | { at: "entering"; handle: string; world: WorldSummary }
  | { at: "create"; handle: string; world: WorldSummary; bundle: CityBundle }
  | { at: "play"; handle: string; world: WorldSummary; bundle: CityBundle; character: Character };

/** The city this tab is playing, so a reload comes back to it. */
const LAST_CITY = "aye:last-city";

export function App() {
  const [screen, setScreen] = useState<Screen>({ at: "loading" });

  // Signed out only when the server says so; if it can't be reached yet, keep trying.
  useEffect(() => {
    let stop = false;
    const check = (wait: number) => {
      api<{ handle: string }>("/me")
        .then(async (me) => {
          // A reload puts you back where you were, not on the list of cities.
          const last = sessionStorage.getItem(LAST_CITY);
          const world = last
            ? await api<{ worlds: WorldSummary[] }>("/worlds")
                .then((r) => r.worlds.find((w) => w.id === last))
                .catch(() => undefined)
            : undefined;
          if (stop) return;
          setScreen(
            world
              ? { at: "entering", handle: me.handle, world }
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

  useEffect(() => {
    if (screen.at === "play") sessionStorage.setItem(LAST_CITY, screen.world.id);
    else if (screen.at === "worlds" || screen.at === "auth") sessionStorage.removeItem(LAST_CITY);
  }, [screen]);

  useEffect(() => {
    const inCity = screen.at === "create" || screen.at === "play";
    applyTheme(inCity ? screen.bundle.city.theme : null);
    document.title = inCity ? `${screen.bundle.city.name} · Ayé` : "Ayé";
  }, [screen]);

  useEffect(() => {
    if (screen.at !== "entering") return;
    const { handle, world } = screen;
    void (async () => {
      const bundle = await api<CityBundle>(`/worlds/${world.id}/city`);
      const { character } = await api<{ character: Character | null }>(
        `/worlds/${world.id}/character`,
      );
      setScreen(
        character
          ? { at: "play", handle, world, bundle, character }
          : { at: "create", handle, world, bundle },
      );
    })().catch(() => setScreen({ at: "worlds", handle }));
  }, [screen]);

  switch (screen.at) {
    case "loading":
    case "entering":
      return (
        <div className="center-screen">
          <span className="spinner" role="status" aria-label="Loading" />
        </div>
      );
    case "auth":
      return <Auth onIn={(handle) => setScreen({ at: "worlds", handle })} />;
    case "worlds":
      return (
        <Worlds
          handle={screen.handle}
          onPlay={(world) => setScreen({ at: "entering", handle: screen.handle, world })}
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
            onLeave={leave}
            onSignedOut={signedOut}
          />
        </Crashed>
      );
    }
  }
}
