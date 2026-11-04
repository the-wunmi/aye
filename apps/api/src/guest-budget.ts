/**
 * What guests may spend on model replies. A guest takes no signing up, so anyone can make many,
 * and what each one says gets a model call: there's a limit per guest, and one over all guests
 * together that no number of new guests gets around. Past it, the people in a place just don't
 * answer guests for a while; accounts aren't affected. Kept per process, like the realm itself.
 */

const WINDOW_MS = 3_600_000;
export const REPLIES_PER_GUEST_PER_HOUR = 30;
export const REPLIES_ALL_GUESTS_PER_HOUR = 300;
/** People talking among themselves with only guests listening. Nobody's waiting on this. */
export const OVERHEARD_ALL_GUESTS_PER_HOUR = 120;
/** Past this many guests in a window, the oldest window's records are simply cleared. */
const MAX_TRACKED = 10_000;

export class GuestBudget {
  readonly #now: () => number;
  readonly #perGuest: number;
  readonly #allGuests: number;
  readonly #overheardLimit: number;
  #windowStart = 0;
  #spent = 0;
  #overheard = 0;
  readonly #byGuest = new Map<string, number>();

  constructor(
    now: () => number,
    perGuest = REPLIES_PER_GUEST_PER_HOUR,
    allGuests = REPLIES_ALL_GUESTS_PER_HOUR,
    overheard = OVERHEARD_ALL_GUESTS_PER_HOUR,
  ) {
    this.#now = now;
    this.#perGuest = perGuest;
    this.#allGuests = allGuests;
    this.#overheardLimit = overheard;
  }

  #roll(): void {
    const now = this.#now();
    if (now - this.#windowStart >= WINDOW_MS || this.#byGuest.size >= MAX_TRACKED) {
      this.#windowStart = now;
      this.#spent = 0;
      this.#overheard = 0;
      this.#byGuest.clear();
    }
  }

  /** May people talk among themselves for guests now? Counts it if so. */
  takeOverheard(): boolean {
    this.#roll();
    if (this.#overheard >= this.#overheardLimit) return false;
    this.#overheard++;
    return true;
  }

  /** May this guest have a model reply now? Counts it if so. */
  take(guest: string): boolean {
    this.#roll();
    const theirs = this.#byGuest.get(guest) ?? 0;
    if (theirs >= this.#perGuest || this.#spent >= this.#allGuests) return false;
    this.#byGuest.set(guest, theirs + 1);
    this.#spent++;
    return true;
  }
}
