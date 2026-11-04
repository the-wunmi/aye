/**
 * The way in: what this is, what's open to walk into right now, and signing up or in.
 * Credentials go to the API once; the session lives in an HttpOnly cookie.
 */
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api } from "../api.ts";
import { pathOf } from "../route.ts";
import { Skyline } from "./Skyline.tsx";

interface OpenCity {
  id: string;
  name: string;
  description: string;
  online: number;
}

const MESSAGES: Record<string, string> = {
  handle_taken: "That name is taken.",
  wrong_handle_or_password: "Wrong name or password.",
  rate_limited: "Too many tries. Wait a minute.",
  invalid_request: "Names are 3–20 letters, numbers or _; passwords at least 10 characters.",
};

export function Auth({ onIn }: { onIn(handle: string): void }) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<OpenCity[]>([]);

  useEffect(() => {
    api<{ cities: OpenCity[] }>("/open-cities")
      .then((r) => setOpen(r.cities))
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ handle: string }>(`/auth/${mode}`, { handle, password });
      onIn(res.handle);
    } catch (err) {
      setError(
        err instanceof ApiError ? (MESSAGES[err.code] ?? "Something went wrong.") : "Offline?",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <Skyline />
      <div className="home-page">
        <span className="home-logo">Ayé</span>
        <section className="home-hero">
          <h1>Where do you want to live?</h1>
          <p>Film a real place or describe one, then live in it with everyone else.</p>
        </section>
        <form className="panel auth" onSubmit={submit}>
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              onClick={() => setMode("register")}
            >
              Sign up
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              onClick={() => setMode("login")}
            >
              Log in
            </button>
          </div>
          <label>
            Name
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              autoComplete="username"
              minLength={3}
              maxLength={20}
              pattern="[A-Za-z0-9_]+"
              title="Letters, numbers or _, with no spaces"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              minLength={10}
              maxLength={200}
              required
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {mode === "register" ? "Create account" : "Log in"}
          </button>
        </form>
        {open.length > 0 && (
          <section>
            <h2>Open to walk into</h2>
            <div className="cards">
              {open.map((c) => (
                <div className="card" key={c.id}>
                  <h3>
                    <a href={pathOf(c.id)}>{c.name}</a>
                  </h3>
                  {c.online > 0 && <div className="home-live">{c.online} here now</div>}
                  <p className="muted small clamp">{c.description}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
