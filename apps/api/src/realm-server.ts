/**
 * The realm's WebSocket door: `GET /worlds/:id/play` upgraded to a WebSocket.
 *
 * Every check happens before the upgrade, so a refused connection never becomes a socket: the
 * path must name a world; the Origin must be ours (no cross-site WebSocket hijacking, since
 * browsers send cookies with cross-origin upgrades); the session cookie must be valid; the
 * player must be able to play that world and have a character in it. Frames are capped at the
 * protocol's message size by the server itself.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { canPlayWorld, type Db, getMyCharacter, getWorld, resolveSession } from "@aye/db";
import { MAX_CLIENT_MESSAGE_BYTES } from "@aye/schema";
import { WebSocketServer } from "ws";
import { SESSION_COOKIE } from "./app.ts";
import type { Content } from "./content.ts";
import type { Realm } from "./realm.ts";

const PLAY_PATH = /^\/worlds\/(wld_[0-9a-z]{3,40})\/play$/;

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachRealm(
  server: Server,
  deps: { db: Db; content: Content; realm: Realm; origins: readonly string[] },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });

  // The order connections arrived in: joining takes a while, and the newest must win.
  let arrivals = 0;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const seq = ++arrivals;
    void (async () => {
      const match = PLAY_PATH.exec(new URL(req.url ?? "/", "http://realm").pathname);
      if (!match) return refuse(socket, 404, "Not Found");
      const origin = req.headers.origin;
      if (!origin || !deps.origins.includes(origin)) return refuse(socket, 403, "Forbidden");
      const { actor, handle } = await resolveSession(
        deps.db,
        cookieValue(req.headers.cookie, SESSION_COOKIE),
      );
      if (actor.kind !== "user" || !handle) return refuse(socket, 401, "Unauthorized");
      const world = await getWorld(deps.db, actor, match[1] as string);
      if (!world?.city || world.status !== "ready" || !canPlayWorld(world.role)) {
        return refuse(socket, 404, "Not Found");
      }
      const character = await getMyCharacter(deps.db, actor, world.id);
      if (!character) return refuse(socket, 409, "Conflict");
      const city = await deps.content.city(world.city);

      wss.handleUpgrade(req, socket, head, (ws) => {
        // Messages that arrive while joining wait their turn, in order.
        const early: (string | Buffer)[] = [];
        let session: { message(raw: string | Buffer): void; close(): void } | null = null;
        let closed = false;
        ws.on("message", (data: Buffer, isBinary: boolean) => {
          const raw = isBinary ? data : data.toString("utf8");
          if (session) session.message(raw);
          else if (early.length < 32) early.push(raw);
        });
        ws.on("close", () => {
          closed = true;
          session?.close();
        });
        ws.on("error", () => ws.terminate());
        void deps.realm
          .join(ws, { actor, handle, world, city, character, seq })
          .then((s) => {
            session = s;
            if (closed) return s.close();
            for (const raw of early.splice(0)) s.message(raw);
          })
          .catch(() => ws.close(1011, "could not join"));
      });
    })().catch(() => refuse(socket, 500, "Internal Server Error"));
  });
  return wss;
}
