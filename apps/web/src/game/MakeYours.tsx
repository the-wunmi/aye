/**
 * Making your home yours: say what you want, see what it would take, and buy it or don't. The
 * model proposes in the background while you keep playing; the price and what changes come
 * from the server, and only the server can carry it out.
 */
import { useState } from "react";
import { ApiError, api } from "../api.ts";
import { money } from "../format.ts";

/** How many times to look for an answer, 3 s apart. */
const POLLS = 200;

type Proposal = {
  job: string;
  say: string;
  price: number;
  added: string[];
  moved: string[];
  removed: string[];
};

type HomeStatus =
  | { status: "working" }
  | {
      status: "done";
      result: (Omit<Proposal, "job"> & { ok: true }) | { ok: false; reason: string };
    };

export function MakeYours({
  worldId,
  place,
  currency,
  wallet,
  buy,
}: {
  worldId: string;
  place: string;
  currency: string;
  wallet: number;
  buy(job: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const ask = async () => {
    const request = text.trim();
    if (request.length < 2) return;
    setBusy(true);
    setProblem(null);
    setProposal(null);
    try {
      const { job } = await api<{ job: string }>(`/worlds/${worldId}/home`, { place, request });
      for (let i = 0; i < POLLS; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await api<HomeStatus>(`/homes/${job}`);
        if (s.status !== "done") continue;
        if (s.result.ok) setProposal({ ...s.result, job });
        else setProblem(s.result.reason);
        return;
      }
      setProblem("Couldn't work that out in the end.");
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.code === "rate_limited"
          ? "You've asked for a lot this hour."
          : "Couldn't ask that.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="sys-pill" onClick={() => setOpen(true)}>
        <span aria-hidden>{"\u{1F6CB}\u{FE0F}"}</span> Make it yours
      </button>
    );
  }
  const changes = proposal
    ? [
        ...proposal.added.map((x) => `+ ${x}`),
        ...proposal.moved.map((x) => `Move ${x}`),
        ...proposal.removed.map((x) => `- ${x}`),
      ]
    : [];
  return (
    <form
      className="w w-card make-yours"
      onSubmit={(e) => {
        e.preventDefault();
        void ask();
      }}
    >
      <strong>Make it yours</strong>
      <input
        aria-label="What do you want here?"
        placeholder="A green sofa by the window"
        value={text}
        maxLength={300}
        onChange={(e) => setText(e.target.value)}
      />
      {busy && (
        <div className="small" role="status">
          <span className="spinner" aria-hidden /> Seeing what can be done…
        </div>
      )}
      {problem && <div className="small t-bad">{problem}</div>}
      {proposal && (
        <div className="small" role="status">
          <div>{proposal.say}</div>
          <ul className="plain">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            className="primary"
            disabled={wallet < proposal.price}
            onClick={() => {
              buy(proposal.job);
              setProposal(null);
              setText("");
              setOpen(false);
            }}
          >
            {proposal.price > 0 ? `Buy · ${money(proposal.price, currency)}` : "Do it"}
          </button>
          {wallet < proposal.price && <div className="t-bad">You can't afford that yet.</div>}
        </div>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || text.trim().length < 2}>
          Ask
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Not now
        </button>
      </div>
      {proposal && <div ref={(el) => el?.scrollIntoView({ block: "end" })} aria-hidden />}
    </form>
  );
}
