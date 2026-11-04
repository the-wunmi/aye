/**
 * Keeping someone waiting ahead of polish. A city's finishing pass makes hundreds of model calls
 * over an hour, and nobody is watching it; someone building their first city or filming a place
 * is. So background calls go through here: a few at a time, and only one while anyone's waiting.
 * It holds calls back and never drops them, so polish only ever arrives later.
 *
 * It's per worker process, which is what shares the model's capacity today.
 */
import { patientFetch } from "@aye/pipeline";

const BACKGROUND_CALLS = 3;
const BACKGROUND_CALLS_WHILE_WAITING = 1;

export class ModelTraffic {
  #waiting = 0;
  #running = 0;
  readonly #queue: (() => void)[] = [];

  get #room(): number {
    return this.#waiting > 0 ? BACKGROUND_CALLS_WHILE_WAITING : BACKGROUND_CALLS;
  }

  #next(): void {
    while (this.#running < this.#room) {
      const go = this.#queue.shift();
      if (!go) return;
      this.#running++;
      go();
    }
  }

  /** Work someone is waiting on. Background calls ease off until it's done. */
  async foreground<T>(work: () => Promise<T>): Promise<T> {
    this.#waiting++;
    try {
      return await work();
    } finally {
      this.#waiting--;
      this.#next();
    }
  }

  /** Run a background call when there's room for it. */
  async background<T>(call: () => Promise<T>): Promise<T> {
    await new Promise<void>((go) => {
      this.#queue.push(go);
      this.#next();
    });
    try {
      return await call();
    } finally {
      this.#running--;
      this.#next();
    }
  }

  /** `fetch` for a model provider whose calls nobody is waiting on. */
  readonly fetch: typeof fetch = (input, init) =>
    this.background(() => patientFetch(input as string, init));
}
