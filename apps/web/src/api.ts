/**
 * Calls to the Ayé API (proxied under /api, same origin as the game, so the HttpOnly session
 * cookie rides along and nothing about it is visible to scripts). Errors carry the API's error
 * code only.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) {
    throw new ApiError(res.status, typeof data.error === "string" ? data.error : "request_failed");
  }
  return data as T;
}

/** The realm socket for a world, on this origin. */
export const realmUrl = (worldId: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/worlds/${encodeURIComponent(worldId)}/play`;
