/**
 * Links into the game: /city/<id> is a city, /city/<id>/<place> somewhere in it. A link only says
 * where someone wants to be. What they may see is still the server's call, and walking in still
 * means going there by the city's own rules, so a link never moves anyone by itself.
 */

export interface Route {
  world: string;
  place: string | null;
}

const WORLD_ID = /^wld_[0-9a-z]{3,40}$/;
const PLACE_KEY = /^[a-z0-9_]{1,80}$/;

/** Whatever's in the address bar is anyone's to write, so only plain ids get through. */
export function parseRoute(path: string): Route | null {
  const [, root, world, place, ...rest] = path.split("/");
  if (root !== "city" || !world || !WORLD_ID.test(world) || rest.length > 0) return null;
  if (place === undefined || place === "") return { world, place: null };
  return PLACE_KEY.test(place) ? { world, place } : null;
}

export const pathOf = (world: string, place?: string | null) =>
  place ? `/city/${world}/${place}` : `/city/${world}`;
