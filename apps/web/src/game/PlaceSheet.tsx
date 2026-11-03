/**
 * A place's sheet: what it is, when it's open, and every way to get there from where you are
 * (time and fare by the city's own travel modes). Going is an intent; the server charges the
 * fare and decides if you can.
 */
import {
  type CitySpec,
  districtsOf,
  moverNow,
  moverServes,
  moversOf,
  placeOpen,
  placesOf,
  trip,
} from "@aye/schema";
import { clockText, closedText, durationText, money } from "../format.ts";

export function PlaceSheet({
  city,
  pacePermille,
  placeKey,
  here,
  built,
  wallet,
  minute,
  catalogCount,
  travelling,
  ride,
  then,
  onGo,
  marks,
  have,
  earnedBy,
  onDrive,
  onEnter,
  onClose,
}: {
  city: CitySpec;
  /** How fast trips go compared with life, permille (`tripPacePermille`). */
  pacePermille: number;
  placeKey: string;
  here: string | null;
  built: boolean;
  wallet: number | null;
  /** City minutes since the world began: hours and the city's events both apply. */
  minute: number;
  catalogCount: number;
  travelling: boolean;
  /** Your own vehicle you could go in (the world's words for it), if any. */
  ride: { label: string; speedKmh: number } | null;
  /** What happens once there (a job the player chose), shown so the trip has a point. */
  then?: string | null;
  /** The city's marks, to say in its own words what a door asks for. */
  marks: readonly { key: string; label: string }[];
  /** What you have of each, once known: a door you can't get through says so before you set off. */
  have?: Readonly<Record<string, number>>;
  /** Something that builds this mark, in words, if anything does. */
  earnedBy?(mark: string): string | null;
  onGo(mode: string): void;
  onDrive(): void;
  onEnter(): void;
  onClose(): void;
}) {
  const place = placesOf(city).find((p) => p.key === placeKey);
  if (!place) return null;
  const from = placesOf(city).find((p) => p.key === here) ?? place;
  const open = placeOpen(place, city.events, minute);
  const w = city.words;
  const district = districtsOf(city).find((d) => d.key === place.district)?.name;
  const isHere = here === placeKey;
  const short = have && (place.asks ?? []).find((x) => (have[x.mark] ?? 0) < x.atLeast);
  const barred = short
    ? `Needs ${marks.find((m) => m.key === short.mark)?.label ?? short.mark} ${short.atLeast}`
    : null;
  return (
    <div className="sheet" role="dialog" aria-label={place.name}>
      <div className="sheet-head">
        <span className="sheet-icon" aria-hidden>
          {place.icon}
        </span>
        <div className="grow">
          <h2>{place.name}</h2>
          <div className="muted small">
            {district}
            {" · "}
            {place.hours
              ? `${clockText(place.hours.from)}–${clockText(place.hours.to)}`
              : w.alwaysOpen}
            {" · "}
            <span className={open ? "t-good" : "t-bad"}>
              {open ? w.openNow : closedText(w.closedNow, place.hours)}
            </span>
            {(place.asks ?? [])
              .filter((x) => !have || (have[x.mark] ?? 0) < x.atLeast)
              .map((x) => (
                <span key={x.mark} className="t-bad">
                  {" · "}Needs {marks.find((m) => m.key === x.mark)?.label ?? x.mark} {x.atLeast}
                </span>
              ))}
          </div>
        </div>
        <button type="button" className="link" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <p>{place.blurb}</p>
      {then && (
        <p className="sheet-then">
          <span aria-hidden>{"\u{27A1}\u{FE0F}"}</span> Pick how to get there, then:{" "}
          <strong>{then}</strong>
        </p>
      )}
      {place.tags.length > 0 && (
        <div className="w-chips">
          {place.tags.map((t) => (
            <span key={t} className="chip">
              {t.replace(/_/g, " ")}
            </span>
          ))}
          {catalogCount > 0 && <span className="chip">{catalogCount} things to do</span>}
        </div>
      )}
      {!built ? (
        <p className="muted">{w.notBuilt}</p>
      ) : isHere ? (
        <button type="button" className="primary" onClick={onEnter}>
          You're here · Go inside
        </button>
      ) : (
        <>
          {short && earnedBy?.(short.mark) && (
            <p className="muted small">How to earn it: {earnedBy(short.mark)}</p>
          )}
          <ul className="modes">
            {ride && (
              <li>
                <button
                  type="button"
                  className="mode"
                  disabled={!open || travelling || barred !== null}
                  onClick={onDrive}
                  title={`Go in your ${ride.label}`}
                >
                  <span className="mode-icon" aria-hidden>
                    🔑
                  </span>
                  <span className="grow">
                    Your {ride.label}
                    <span className="muted small">
                      {" · "}
                      {durationText(
                        trip(
                          { speedKmh: ride.speedKmh, fare: { base: 0, perKm: 0 } },
                          from,
                          place,
                          pacePermille,
                        ).minutes,
                      )}
                    </span>
                  </span>
                  <strong>Free</strong>
                  {!open ? <span className="muted small"> {w.closedNow}</span> : null}
                </button>
              </li>
            )}
            {moversOf(city)
              .filter((m) => moverServes(m, from.key, place.key))
              .map((m) => {
                const now = moverNow(m, city.events, minute);
                const leg = trip(now, from, place, pacePermille);
                const runs = now.running;
                const afford = wallet === null || wallet >= leg.fare;
                const why = barred
                  ? barred
                  : !open
                    ? closedText(w.closedNow, place.hours)
                    : !runs
                      ? w.notRunning
                      : !afford
                        ? w.cantAfford
                        : travelling
                          ? w.onTheWay
                          : null;
                return (
                  <li key={m.key}>
                    <button
                      type="button"
                      className="mode"
                      disabled={why !== null}
                      onClick={() => onGo(m.key)}
                      title={why ?? `Go by ${m.label}`}
                    >
                      <span className="mode-icon" aria-hidden>
                        {m.icon}
                      </span>
                      <span className="grow">
                        {m.label}
                        <span className="muted small"> · {durationText(leg.minutes)}</span>
                        {m.tires.map((t) => (
                          <span key={t.need} className="muted small">
                            {" · "}
                            {city.needs.find((n) => n.key === t.need)?.label ?? t.need} -
                            {Math.ceil((t.perHour * leg.minutes) / 600)}%
                          </span>
                        ))}
                      </span>
                      <strong>{leg.fare === 0 ? w.free : money(leg.fare, city.currency)}</strong>
                      {why && <span className="muted small"> {why}</span>}
                    </button>
                  </li>
                );
              })}
          </ul>
        </>
      )}
    </div>
  );
}
