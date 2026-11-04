/**
 * Turning a guest into an account: a name and password, and everything they've done stays theirs.
 * Asked for only when they want something that spends real money to make, and never before.
 */
import { type FormEvent, useState } from "react";
import { ApiError, api } from "../api.ts";

const MESSAGES: Record<string, string> = {
  handle_taken: "That name is taken.",
  rate_limited: "Too many tries. Wait a minute.",
  invalid_request: "Names are 3–20 letters, numbers or _; passwords at least 10 characters.",
};

export function SaveAccount({ why, onSaved }: { why: string; onSaved(handle: string): void }) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ handle: string }>("/auth/claim", { handle, password });
      onSaved(res.handle);
    } catch (err) {
      setError(err instanceof ApiError ? (MESSAGES[err.code] ?? "That didn't work.") : "Offline.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="save-account" onSubmit={submit}>
      <p>{why}</p>
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
          autoComplete="new-password"
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
        Save my account
      </button>
    </form>
  );
}
