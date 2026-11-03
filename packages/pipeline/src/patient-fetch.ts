/**
 * Plain `fetch` gives up after five minutes without response headers, whatever signal it was
 * given, and a model writing a whole world sends none until it has finished. So every model call
 * goes through this: how long to wait is decided in one place, by the caller's abort signal.
 */
import { Agent, fetch as undiciFetch } from "undici";

const WAITS_FOR_THE_SIGNAL = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export const patientFetch = ((url: string, init?: RequestInit) =>
  undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: WAITS_FOR_THE_SIGNAL,
  })) as unknown as typeof fetch;
