/**
 * Making your character from the choices the city offers: one of the looks its model designed,
 * recoloured from its palettes, and a way to start out. A turntable shows exactly how you'll
 * look in the city. The server builds the character from these picks; nothing else is sent.
 */
import { createFigurePreview, type FigurePreview } from "@aye/engine";
import { type Character, LIBRARY_CATALOG, placesOf } from "@aye/schema";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { money } from "../format.ts";
import type { CityBundle } from "../game/types.ts";

const BODY = {
  widthMm: 450,
  stepMm: 200,
  stairs: true,
  slopePermille: 150,
  speedMmPerS: 1300,
  seated: false,
};

export function CreateCharacter({
  worldId,
  bundle,
  onCreated,
  onBack,
}: {
  worldId: string;
  bundle: CityBundle;
  onCreated(character: Character): void;
  onBack(): void;
}) {
  const { city, catalog } = bundle;
  // A way of starting out whose home is still being built would leave you nowhere to wake up.
  const starts = city.starts.filter((s) => catalog[s.home]);
  const [name, setName] = useState("");
  const [start, setStart] = useState(starts[0]?.key ?? "");
  const [look, setLook] = useState(0);
  const [outfit, setOutfit] = useState(0);
  const outfits = city.outfits.flatMap((id) => {
    const o = LIBRARY_CATALOG.outfits.find((x) => x.id === id);
    return o ? [o] : [];
  });
  const [skin, setSkin] = useState(Math.min(2, city.looks.skin.length - 1));
  const [hair, setHair] = useState(0);
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(Math.min(1, city.looks.outfit.length - 1));
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<FigurePreview | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    void createFigurePreview(canvas.current as HTMLCanvasElement).then((p) => {
      if (disposed) return p.dispose();
      preview.current = p;
      setReady(true);
    });
    return () => {
      disposed = true;
      preview.current?.dispose();
      preview.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const chosen = city.characters[look];
    preview.current?.show({
      key: `preview_${look}`,
      colours: {
        skin: city.looks.skin[skin] ?? "#8d5524",
        top: city.looks.outfit[top] ?? "#1a7f4e",
        bottom: city.looks.outfit[bottom] ?? "#2c3e50",
        hair: city.looks.hair[hair] ?? "#1a1310",
        accent: city.looks.outfit[(top + 2) % city.looks.outfit.length] ?? "#f2e6c9",
      },
      ...(chosen ? { look: chosen } : {}),
      ...(city.outfits[outfit] ? { outfit: city.outfits[outfit] } : {}),
      body: BODY,
    });
  }, [ready, city, look, outfit, skin, hair, top, bottom]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ character: Character }>(`/worlds/${worldId}/character`, {
        name: name.trim(),
        start,
        look,
        outfit,
        skin,
        hair,
        top,
        bottom,
      });
      onCreated(res.character);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_request"
          ? "Use letters, spaces, . ' or - in your name."
          : "Couldn't create your character.",
      );
    }
  };

  const swatches = (
    colours: readonly string[],
    value: number,
    set: (i: number) => void,
    label: string,
  ) =>
    colours.length === 0 ? null : (
      <fieldset className="swatches">
        <legend>{label}</legend>
        {colours.map((c, i) => (
          <button
            key={c}
            type="button"
            className={`swatch big ${value === i ? "on" : ""}`}
            style={{ background: c }}
            onClick={() => set(i)}
            aria-label={`${label} ${i + 1}`}
            aria-pressed={value === i}
          />
        ))}
      </fieldset>
    );

  return (
    <div className="center-screen">
      <form className="panel create" onSubmit={submit}>
        <div className="row">
          <button type="button" className="link" onClick={onBack}>
            ‹ Cities
          </button>
        </div>
        <h1>
          <span aria-hidden>{city.icon}</span> {city.name}
        </h1>
        <p className="muted">{city.tagline}</p>
        <div className="create-body">
          <div className="turntable">
            <canvas ref={canvas} aria-label="How you'll look" />
            {outfits.length > 0 ? (
              <fieldset className="outfit-picker">
                <legend className="sr-only">Outfit</legend>
                {outfits.map((o, i) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`chip ${outfit === i ? "on" : ""}`}
                    aria-pressed={outfit === i}
                    onClick={() => setOutfit(i)}
                  >
                    {o.label}
                  </button>
                ))}
              </fieldset>
            ) : (
              city.characters.length > 1 && (
                <fieldset className="look-picker">
                  <legend className="sr-only">Look</legend>
                  {city.characters.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`chip ${look === i ? "on" : ""}`}
                      aria-pressed={look === i}
                      onClick={() => setLook(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                </fieldset>
              )
            )}
          </div>
          <div className="grow">
            <label>
              Your name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                required
              />
            </label>
            {swatches(city.looks.skin, skin, setSkin, "Skin")}
            {swatches(city.looks.hair, hair, setHair, "Hair")}
            {swatches(city.looks.outfit, top, setTop, "Top")}
            {swatches(city.looks.outfit, bottom, setBottom, "Bottom")}
          </div>
        </div>
        <fieldset className="starts">
          <legend>How you start</legend>
          {starts.map((s) => (
            <label key={s.key} className={`start ${start === s.key ? "on" : ""}`}>
              <input
                type="radio"
                name="start"
                checked={start === s.key}
                onChange={() => setStart(s.key)}
              />
              <strong>{s.label}</strong>
              <span className="muted small">{s.blurb}</span>
              <span className="small">
                {money(s.money, city.currency)} ·{" "}
                {placesOf(city).find((p) => p.key === s.home)?.name}
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="primary" disabled={!name.trim()}>
          Start living
        </button>
      </form>
    </div>
  );
}
