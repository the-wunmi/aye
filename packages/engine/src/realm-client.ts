/**
 * The game's connection to the realm server (apps/api/src/realm.ts): one WebSocket per world,
 * reconnecting with backoff if it drops. Sends intents only; everything it receives is the
 * server's word. Other players' text arrives here as data and must be rendered as text.
 */
import type { ClientMessage, ServerMessage } from "@aye/schema";

type Listener<T extends ServerMessage["t"]> = (message: Extract<ServerMessage, { t: T }>) => void;

export type RealmStatus = "connecting" | "open" | "closed";

export interface RealmClient {
  readonly status: RealmStatus;
  send(message: ClientMessage): void;
  on<T extends ServerMessage["t"]>(type: T, listener: Listener<T>): () => void;
  onStatus(listener: (status: RealmStatus, code?: number) => void): () => void;
  close(): void;
}

/** Close codes after which reconnecting would only fail again. */
const FINAL = new Set([4000, 4001, 4008, 1008]);

export function connectRealm(url: string): RealmClient {
  const listeners = new Map<string, Set<(m: ServerMessage) => void>>();
  const statusListeners = new Set<(s: RealmStatus, code?: number) => void>();
  let ws: WebSocket | null = null;
  let status: RealmStatus = "connecting";
  let closedByUs = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: RealmStatus, code?: number) => {
    status = s;
    for (const l of statusListeners) l(s, code);
  };

  function open(): void {
    setStatus("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      for (const l of listeners.get(message.t) ?? []) l(message);
    };
    ws.onclose = (event) => {
      ws = null;
      if (closedByUs || FINAL.has(event.code)) {
        setStatus("closed", event.code);
        return;
      }
      setStatus("connecting", event.code);
      const delay = Math.min(15_000, 500 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  }
  open();

  return {
    get status() {
      return status;
    },
    send(message) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const l = listener as (m: ServerMessage) => void;
      set.add(l);
      return () => set.delete(l);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    close() {
      closedByUs = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
