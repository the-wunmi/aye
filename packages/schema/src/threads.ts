/**
 * Threads: what a player is in the middle of. The city's director writes each player their
 * own (rent due Friday, a cousin to help, a job going at the market), as steps from a small
 * vocabulary code can check as they play: be somewhere, do something there, have the money,
 * meet someone. Code checks every step against what really happened, in the realm, and pays
 * the reward; nothing a client says can advance one.
 *
 * A thread's words are the director's: display text only, rendered as text.
 */
import { z } from "zod";
import { Label } from "./primitives.ts";
import { SpecKey } from "./world-spec.ts";

/** When a life goal is due: never. It's there until it's done. */
export const AIM_NEVER_DUE = 2_000_000_000;

export const THREAD_BOUNDS = {
  steps: 5,
  /** Open threads a player carries at once. */
  open: 3,
  /** Longest a thread may run: three city days. */
  maxMinutes: 3 * 1440,
  /** Shortest a thread may run: time to get somewhere across town and do something there. */
  minMinutes: 180,
  /**
   * Finishing a little after the deadline still counts (a meal that ran over, a trip that
   * arrived late): only past this many city minutes more is it missed.
   */
  graceMinutes: 60,
  text: 160,
} as const;

const Text = z.string().max(THREAD_BOUNDS.text);

/** One thing to do, checked by code. */
export const ThreadStep = z.discriminatedUnion("check", [
  /** Be in this place. */
  z.object({ check: z.literal("be_at"), place: SpecKey, text: Text }),
  /** Finish this action on a thing of this kind, in this place. */
  z.object({
    check: z.literal("do"),
    place: SpecKey,
    kind: SpecKey,
    action: SpecKey,
    text: Text,
  }),
  /** Have at least this much money (minor units). */
  z.object({ check: z.literal("have_money"), atLeast: z.int().min(0), text: Text }),
  /** Have this much of one of the things that stay with you. */
  z.object({ check: z.literal("mark"), mark: SpecKey, atLeast: z.int().min(1), text: Text }),
  /** Be in this place while this person (one of its people) is there. */
  z.object({ check: z.literal("meet"), place: SpecKey, person: SpecKey, text: Text }),
]);
export type ThreadStep = z.infer<typeof ThreadStep>;

export const ThreadState = z.enum(["open", "done", "missed"]);
export type ThreadState = z.infer<typeof ThreadState>;

export const Thread = z.object({
  id: z.string().regex(/^thr_[a-z0-9]{8,40}$/),
  title: Label.min(1),
  about: Text,
  icon: z.string().min(1).max(32),
  steps: z.array(ThreadStep).min(1).max(THREAD_BOUNDS.steps),
  /** Steps done so far (in order). */
  progress: z.int().min(0).max(THREAD_BOUNDS.steps),
  /** Paid when the last step is done, minor units. */
  reward: z.int().min(0),
  /** City minutes since the world began: when it was given, and when it's too late. */
  from: z.int().min(0),
  due: z.int().min(0),
  state: ThreadState,
  /** What finishing it does to what stays with them, and what letting it slip does. */
  onDone: z
    .array(z.object({ mark: SpecKey, by: z.int().min(-3).max(3) }))
    .max(3)
    .optional(),
  onMissed: z
    .array(z.object({ mark: SpecKey, by: z.int().min(-3).max(3) }))
    .max(3)
    .optional(),
  /** What they're working towards, not something to do today: it never runs out of time. */
  aim: z.boolean().optional(),
});
export type Thread = z.infer<typeof Thread>;

/**
 * What a thread ending moves on what stays with someone. Letting something slip only costs them
 * once they'd taken it on: the director hands these out unasked.
 */
export function threadStakes(thread: Thread): NonNullable<Thread["onDone"]> {
  if (thread.state === "done") return thread.onDone ?? [];
  if (thread.state === "missed" && thread.progress > 0) return thread.onMissed ?? [];
  return [];
}

/** What a player has done, as the realm sees it, for checking the step they're on. */
export interface ThreadFacts {
  place: string | null;
  wallet: number;
  /** Actions they just finished here: kind and action keys. */
  finished: readonly { kind: string; action: string }[];
  /** What stays with them, by mark key. */
  marks?: ReadonlyMap<string, number>;
  /** People of the place they're in, by key. */
  present: ReadonlySet<string>;
}

/** Does the step hold, given what just happened? */
export function stepDone(step: ThreadStep, facts: ThreadFacts): boolean {
  switch (step.check) {
    case "be_at":
      return facts.place === step.place;
    case "do":
      return (
        facts.place === step.place &&
        facts.finished.some((f) => f.kind === step.kind && f.action === step.action)
      );
    case "have_money":
      return facts.wallet >= step.atLeast;
    case "mark":
      return (facts.marks?.get(step.mark) ?? 0) >= step.atLeast;
    case "meet":
      return facts.place === step.place && facts.present.has(step.person);
  }
}

/**
 * A thread moved on by what just happened at `minute` (absolute city minutes): every step
 * that now holds, in order, is done; the last pays its reward. Too late, it's missed. Returns
 * null if nothing changed; otherwise also the finished actions it didn't use up.
 */
export function advance(
  thread: Thread,
  facts: ThreadFacts,
  minute: number,
): { thread: Thread; reward: number; finished: ThreadFacts["finished"] } | null {
  if (thread.state !== "open") return null;
  if (minute >= thread.due + THREAD_BOUNDS.graceMinutes) {
    return { thread: { ...thread, state: "missed" }, reward: 0, finished: facts.finished };
  }
  let progress = thread.progress;
  let left = facts.finished;
  while (progress < thread.steps.length) {
    const step = thread.steps[progress] as ThreadStep;
    if (!stepDone(step, { ...facts, finished: left })) break;
    // One piece of work is one piece of work: it can't also count for the next step or job.
    if (step.check === "do") {
      const used = left.findIndex((f) => f.kind === step.kind && f.action === step.action);
      left = left.filter((_, i) => i !== used);
    }
    progress++;
  }
  if (progress === thread.progress) return null;
  const done = progress >= thread.steps.length;
  return {
    thread: { ...thread, progress, state: done ? "done" : "open" },
    reward: done ? thread.reward : 0,
    finished: left,
  };
}
