/**
 * Ask anything about the place you're in: an agent tests it in the simulation and answers.
 * Tapping something it found takes you to it. What it says is a model's words, shown as text,
 * and what it points at has been resolved by code to things really in the scene.
 *
 * It belongs to the player, not the screen: a question keeps going if they walk out to the map
 * or across town, and earlier answers stay so they can compare before and after a change. The
 * suggestions are the models': written for this place when it was filmed, and after each answer.
 */
import type { Scene } from "@aye/schema";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

export interface Mark {
  xMm: number;
  zMm: number;
  radiusMm: number;
  /** How far above the floor it is (a thing on a wall, the middle of a flight of stairs). */
  aboveFloorMm: number;
}

interface Finding {
  text: string;
  thing: string | null;
  crossing: string | null;
  opening: string | null;
}

interface Answer {
  verdict: string;
  answer: string;
  nextStep: string;
  followUps: string[];
  tested: boolean;
  tests: number;
  findings: Finding[];
  /** Absent on answers from before it was recorded. */
  trials?: Trial[];
}

interface Trial {
  kind: "body" | "day";
  widthMm: number;
  stepMm: number;
  stairs: boolean;
  changes: number;
  reached: number;
  outOf: number;
  ranOut: { need: string; hours: number }[];
}

/** One test as a line: the body it tried, and what happened, measured rather than told. */
export function trialLine(t: Trial): { body: string; result: string } {
  const parts = [`${Math.round(t.widthMm / 10)} cm wide`];
  parts.push(t.stairs ? "can use stairs" : "no stairs");
  if (!t.stairs && t.stepMm >= 10) parts.push(`steps up to ${Math.round(t.stepMm / 10)} cm`);
  if (t.changes > 0) parts.push(`with ${t.changes} change${t.changes === 1 ? "" : "s"} tried`);
  const result =
    t.kind === "body"
      ? `reached ${t.reached} of ${t.outOf} things`
      : t.ranOut.length === 0
        ? "lived a whole day, and nothing ran out"
        : `lived a day; ${t.ranOut.map((n) => `${n.need} ran out for ${n.hours} h`).join(", ")}`;
  return { body: parts.join(", "), result };
}

/** Where in the scene a finding is about; null if it's not about one spot. */
export function markOf(scene: Scene, f: Finding): Mark | null {
  const o = f.thing && scene.objects.find((x) => x.id === f.thing);
  if (o) {
    return {
      xMm: o.transform.position[0],
      zMm: o.transform.position[2],
      radiusMm: Math.hypot(o.size.w, o.size.d) * 0.55,
      aboveFloorMm: o.transform.position[1],
    };
  }
  const l = f.crossing && scene.levelChanges.find((x) => x.id === f.crossing);
  if (l) {
    return {
      xMm: (l.from[0] + l.to[0]) / 2,
      zMm: (l.from[1] + l.to[1]) / 2,
      radiusMm: l.widthMm * 0.7,
      aboveFloorMm: l.riseMm / 2,
    };
  }
  const p = f.opening && scene.openings.find((x) => x.id === f.opening);
  if (p) return { xMm: p.at[0], zMm: p.at[1], radiusMm: p.clearWidthMm * 0.7, aboveFloorMm: 0 };
  return null;
}

/** A question asked here, and how it went. */
interface Asked {
  placeKey: string;
  placeName: string;
  /** The place as it was asked about: what findings point at. */
  scene: Scene;
  question: string;
}

type State =
  | { at: "closed" }
  | { at: "asking" }
  | { at: "testing"; job: string; asked: Asked }
  | { at: "answered"; asked: Asked; answer: Answer }
  | { at: "failed" };

function marksOf(scene: Scene, answer: Answer): Mark[] {
  return answer.findings.flatMap((f) => {
    const m = markOf(scene, f);
    return m ? [m] : [];
  });
}

export function AskPlace({
  worldId,
  here,
  placeName,
  scene,
  suggestions,
  onMarks,
  onShow,
}: {
  worldId: string;
  /** The place they're in now, if any. */
  here: string | null;
  placeName: string;
  scene: Scene | null;
  /** Questions a model thought worth asking about this place, if any. */
  suggestions: readonly string[];
  onMarks(marks: readonly Mark[]): void;
  onShow(mark: Mark): void;
}) {
  const [state, setState] = useState<State>({ at: "closed" });
  const [text, setText] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [earlier, setEarlier] = useState<{ question: string; verdict: string }[]>([]);

  const job = state.at === "testing" ? state.job : null;
  const asked = state.at === "testing" ? state.asked : null;
  useEffect(() => {
    if (!job || !asked) return;
    let live = true;
    setSeconds(0);
    const started = Date.now();
    const check = async () => {
      setSeconds(Math.round((Date.now() - started) / 1000));
      const s = await api<
        | { status: "working" }
        | { status: "done"; result: { ok: true; answer: Answer } | { ok: false } }
      >(`/questions/${encodeURIComponent(job)}`).catch(() => null);
      if (!live || !s || s.status === "working") return;
      setState(s.result.ok ? { at: "answered", asked, answer: s.result.answer } : { at: "failed" });
    };
    const t = setInterval(() => void check(), 2_500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [job, asked]);

  // What an answer points at only means anything in the place it's about.
  const answered = state.at === "answered" ? state : null;
  const marksHere =
    answered && answered.asked.placeKey === here
      ? marksOf(answered.asked.scene, answered.answer)
      : null;
  const markKey = marksHere ? JSON.stringify(marksHere) : "";
  const lastKey = useRef("");
  useEffect(() => {
    if (lastKey.current === markKey) return;
    lastKey.current = markKey;
    onMarks(marksHere ?? []);
  }, [markKey, marksHere, onMarks]);

  const close = () => setState({ at: "closed" });

  const send = async (question: string) => {
    const q = question.trim();
    if (q.length < 3 || !here || !scene) return;
    if (answered) {
      setEarlier((list) =>
        [{ question: answered.asked.question, verdict: answered.answer.verdict }, ...list].slice(
          0,
          4,
        ),
      );
    }
    setText("");
    try {
      const { job: id } = await api<{ job: string }>(
        `/worlds/${encodeURIComponent(worldId)}/places/${encodeURIComponent(here)}/questions`,
        { question: q },
      );
      setState({
        at: "testing",
        job: id,
        asked: { placeKey: here, placeName, scene, question: q },
      });
    } catch {
      setState({ at: "failed" });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  if (state.at === "closed") {
    // Only somewhere you can ask about.
    return here && scene ? (
      <button type="button" className="sys-pill" onClick={() => setState({ at: "asking" })}>
        <span aria-hidden>{"\u{1F9EA}"}</span> Ask about this place
      </button>
    ) : null;
  }

  if (state.at === "asking") {
    return (
      <form className="w w-card ask-card" onSubmit={onSubmit}>
        <strong>Ask about this place</strong>
        <span className="muted small">The answer comes from what actually happens here.</span>
        <textarea
          value={text}
          rows={2}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask anything you'd want to know"
          aria-label="Your question"
        />
        {suggestions.map((q) => (
          <button
            key={q}
            type="button"
            className="link ask-suggestion"
            onClick={() => void send(q)}
          >
            {q}
          </button>
        ))}
        <div className="film-actions">
          <button type="submit" className="primary" disabled={text.trim().length < 3}>
            Ask
          </button>
          <button type="button" className="link" onClick={close}>
            Not now
          </button>
        </div>
      </form>
    );
  }

  if (state.at === "testing") {
    return (
      <div className="w w-card ask-card" role="status" aria-live="polite">
        <strong>{state.asked.question}</strong>
        <span className="muted small">
          <span className="spinner" aria-hidden /> Finding out… {seconds}s
        </span>
        <span className="muted small">
          Usually about a minute. Keep playing: the answer will come to you here.
        </span>
      </div>
    );
  }

  if (state.at === "failed") {
    return (
      <div className="w w-card ask-card" role="alert">
        <strong>That didn't work</strong>
        <span className="muted small">Something went wrong testing that. Try asking again?</span>
        <div className="film-actions">
          <button type="button" className="link" onClick={() => setState({ at: "asking" })}>
            Ask again
          </button>
          <button type="button" className="link" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const { answer, asked: was } = state;
  const inPlace = was.placeKey === here;
  return (
    <div className="w w-card ask-card" role="status">
      <span className="muted small">{was.question}</span>
      <strong className="ask-verdict">{answer.verdict}</strong>
      {!inPlace && <span className="muted small">About {was.placeName}.</span>}
      {answer.nextStep && (
        <p className="ask-next">
          <strong>What to do:</strong> {answer.nextStep}
        </p>
      )}
      <p className="ask-answer">{answer.answer}</p>
      {(answer.trials?.length ?? 0) > 0 && (
        <details className="ask-trials" open>
          <summary className="small">
            <strong>
              Tested {answer.trials?.length === 1 ? "once" : `${answer.trials?.length} times`}
            </strong>{" "}
            <span className="muted">in the simulation, not guessed</span>
          </summary>
          <ol>
            {answer.trials?.map((t, i) => {
              const line = trialLine(t);
              return (
                <li key={`${i}-${line.body}`} className="small">
                  <span className="muted">{line.body}:</span> {line.result}
                </li>
              );
            })}
          </ol>
        </details>
      )}
      <ul className="ask-findings">
        {answer.findings.map((f, i) => {
          const mark = markOf(was.scene, f);
          return (
            <li key={`${i}-${f.text.slice(0, 24)}`}>
              {mark && inPlace ? (
                <button
                  type="button"
                  className="link ask-finding"
                  onClick={() => {
                    onMarks([mark]);
                    onShow(mark);
                  }}
                  title="Show me"
                >
                  <span aria-hidden>{"\u{1F4CD}"}</span> {f.text}
                </button>
              ) : (
                f.text
              )}
            </li>
          );
        })}
      </ul>
      <span className="muted small">
        {answer.tested
          ? answer.findings.length > 0
            ? "A first look, not a survey."
            : ""
          : "This couldn't be tested here, so it's only an opinion."}
      </span>
      {inPlace &&
        answer.followUps.map((q) => (
          <button
            key={q}
            type="button"
            className="link ask-suggestion"
            onClick={() => void send(q)}
          >
            {q}
          </button>
        ))}
      {earlier.length > 0 && (
        <details className="ask-earlier">
          <summary className="muted small">Earlier answers</summary>
          <ul>
            {earlier.map((e) => (
              <li key={e.question}>
                <span className="muted small">{e.question}</span> {e.verdict}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="film-actions">
        {inPlace && (
          <button type="button" className="link" onClick={() => setState({ at: "asking" })}>
            Ask something else
          </button>
        )}
        <button type="button" className="link" onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}
