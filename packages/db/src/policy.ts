/**
 * Authorisation policy, as pure functions over already-loaded facts.
 *
 * The repositories (repo.ts) encode the same rules as SQL predicates so unauthorised rows
 * are never loaded; these functions are the readable statement of the rules, used for
 * checks on loaded data, and unit-tested exhaustively.
 *
 * Rules of thumb:
 * - Deny by default. Every rule names who is allowed.
 * - Not-found and not-allowed look identical to callers (no existence oracle).
 * - Raw captures are owner-only, always. Only derived, redacted data is ever shared.
 */
import type { GeoAnchor, GeoPrecision, UserId, Visibility } from "@aye/schema";

export type Actor = { kind: "user"; userId: UserId } | { kind: "anonymous" };

export type WorldRole = "owner" | "editor" | "player" | "viewer";

export interface PlaceFacts {
  ownerId: string;
  visibility: Visibility;
}

export const isUser = (actor: Actor): actor is Extract<Actor, { kind: "user" }> =>
  actor.kind === "user";
const owns = (actor: Actor, ownerId: string) => isUser(actor) && actor.userId === ownerId;

/** `inWorldWithRole`: the actor's role in some world that includes this place, if any. */
export function canReadPlace(
  actor: Actor,
  place: PlaceFacts,
  inWorldWithRole: WorldRole | null = null,
): boolean {
  return owns(actor, place.ownerId) || place.visibility !== "private" || inWorldWithRole !== null;
}

/** Listing/search shows your own places and public ones (unlisted is link-only). */
export function canListPlace(actor: Actor, place: PlaceFacts): boolean {
  return owns(actor, place.ownerId) || place.visibility === "public";
}

export function canEditPlace(actor: Actor, place: PlaceFacts): boolean {
  return owns(actor, place.ownerId);
}

export function canReadCapture(actor: Actor, capture: { ownerId: string }): boolean {
  return owns(actor, capture.ownerId);
}

export function canReadWorld(role: WorldRole | null): boolean {
  return role !== null;
}

export function canPlayWorld(role: WorldRole | null): boolean {
  return role === "owner" || role === "editor" || role === "player";
}

export function canEditWorld(role: WorldRole | null): boolean {
  return role === "owner" || role === "editor";
}

export function canManageWorldMembers(role: WorldRole | null): boolean {
  return role === "owner";
}

const DECIMALS: Record<Exclude<GeoPrecision, "exact" | "none">, number> = {
  street: 3, // ≈ 110 m
  area: 2, // ≈ 1.1 km
  city: 1, // ≈ 11 km
};

/**
 * Location as a given viewer may see it. Owners see what they stored; everyone else gets at
 * most street-level precision, even if the owner stored `exact`.
 */
export function geoForViewer(geo: GeoAnchor | null, viewerIsOwner: boolean): GeoAnchor | null {
  if (geo === null || geo.precision === "none") return null;
  if (viewerIsOwner) return geo;
  const precision = geo.precision === "exact" ? "street" : geo.precision;
  const d = DECIMALS[precision];
  const round = (v: number) => Math.round(v * 10 ** d) / 10 ** d;
  return { lat: round(geo.lat), lng: round(geo.lng), bearingDeg: geo.bearingDeg, precision };
}
