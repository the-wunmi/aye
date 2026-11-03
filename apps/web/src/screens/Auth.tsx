/** Signing up or in. Credentials go to the API once; the session lives in an HttpOnly cookie. */
import { type FormEvent, useState } from "react";
import { ApiError, api } from "../api.ts";

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
    <div className="center-screen">
      <form className="panel auth" onSubmit={submit}>
        <h1 className="logo">Ayé</h1>
        <p className="muted">Any place, alive. Describe a city; live in it with everyone.</p>
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
    </div>
  );
}
