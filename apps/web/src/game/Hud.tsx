/**
 * The HUD as the city's model laid it out: eight regions around the screen, each with the
 * widgets it chose, in its order. Widgets are a closed set of components; the model only
 * picks which, where, and their words. All text renders as React text.
 *
 * Code owns the ergonomics (the model owns the content): regions sit in a grid so they can
 * never overlap, the middle of the screen stays clear for the world, big cards asked for in
 * the top or bottom centre move to the nearest side, and needs there become compact chips.
 * Controls the game itself needs (back to cities, the camera) get slots of their own.
 *
 * On a phone the world is the game, so the same widgets fold up instead (`compactHud`): what you
 * read goes in a strip that opens on tap, what you're doing in a bar that opens to a sheet, what
 * you press along the bottom under your thumb. That goes by what each widget is, never by what a
 * city called it, so any city's layout folds the same way.
 */
import {
  type CitySpec,
  dayPhase,
  type HudRegion,
  type Intent,
  type Layout,
  type RosterEntry,
  THREAD_BOUNDS,
  type Thread,
  type Widget,
} from "@aye/schema";
import {
  type FormEvent,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { clockText, money } from "../format.ts";
import type { GoTarget } from "./sources.ts";
import { speak, speechWav, startRecording } from "./voice.ts";

export interface NeedView {
  key: string;
  label: string;
  /** Out of 1000. */
  level: number;
}

export interface HudContext {
  /** What a step costs to do, if anything: a quest shouldn't spring a price on anyone. */
  priceOf?(place: string, kind: string, action: string): number;
  /** Go to, and do, the best thing about this need. */
  seeTo?(need: string): void;
  city: CitySpec;
  screen: "map" | "place";
  wallet: number | null;
  clock: { day: number; minuteOfDay: number };
  /** Whose needs and doing are shown: you, or the person you're playing. */
  actingName: string;
  needs: NeedView[];
  doing: string;
  /** What stays with the person shown, worth showing, and how much of each. */
  marks: readonly { label: string; value: number }[];
  /** How close someone is to you, by their key. */
  closenessOf(person: string): number;
  /** How much you have of a mark, by key. */
  markOf(mark: string): number;
  /** Whether what you do now reaches the city. */
  connected: boolean;
  resources: { label: string; on: boolean }[];
  online: number;
  roster: readonly RosterEntry[];
  myHandle: string;
  feed: readonly { id: number; text: string }[];
  chat: readonly {
    id: string;
    from: string;
    text: string;
    /** When it appeared here (0: said before you came in). */
    shownAt?: number;
    offer?: { kind: string; action: string; label: string; cost: number; income: number };
  }[];
  inPlace: boolean;
  placeName: string | null;
  /** The place you're in, by key. */
  here: string | null;
  say(text: string): void;
  /** Turns recorded speech into text; absent: no microphone here. */
  hearSpeech?(wav: Uint8Array): Promise<string>;
  /** Someone here is (probably) answering what you said. */
  replying?: boolean;
  hold(agent: string): void;
  release(): void;
  intent(intent: Intent): void;
  /** Take the player somewhere, and do something once there. */
  go(target: GoTarget): void;
  /**
   * What the game puts where the city's layout places the life, plan and trip widgets
   * (built by the screen, since they hold live state); null: nothing to show now.
   */
  slots: { life: ReactNode; plan: ReactNode; trip: ReactNode };
  /** Your threads (open first), and the city minute (since the world began) to judge them by. */
  threads: readonly Thread[];
  minute: number;
}

const REGIONS: readonly HudRegion[] = [
  "top_left",
  "top",
  "top_right",
  "left",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
];

/** Widgets that are cards: never in the centre column, where they'd cover the world. */
const isCard = (w: Widget) =>
  w.type === "threads" ||
  w.type === "life" ||
  w.type === "plan" ||
  w.type === "chat" ||
  w.type === "people" ||
  w.type === "feed" ||
  (w.type === "needs" && w.style !== "chips");

/** Where a card asked for in the centre goes instead. */
const SIDE: Partial<Record<HudRegion, Record<string, HudRegion>>> = {
  top: { needs: "top_left", people: "top_right", feed: "top_left", chat: "bottom_left" },
  bottom: {
    needs: "bottom_left",
    people: "bottom_right",
    feed: "bottom_left",
    chat: "bottom_left",
  },
};

/** The model's layout with code's ergonomics applied: same widgets, nothing overlapping. */
export function arrange(layout: Layout): Map<HudRegion, Widget[]> {
  const out = new Map<HudRegion, Widget[]>(REGIONS.map((r) => [r, []]));
  for (const slot of layout) {
    for (const w of slot.widgets) {
      let region = slot.region;
      let widget = w;
      // What you're in the middle of goes up the side, never stacked over chat and the controls.
      if (w.type === "threads" && region !== "right") region = "left";
      else if (isCard(w) && SIDE[region]) {
        if (w.type === "needs") widget = { ...w, style: "chips" };
        else region = SIDE[region]?.[w.type] ?? "bottom_left";
      }
      out.get(region)?.push(widget);
    }
  }
  // What you're in the middle of is never hidden: a layout that leaves it out (an older city)
  // still shows it, on the left where cards go.
  if (![...out.values()].some((ws) => ws.some((w) => w.type === "threads"))) {
    out.get("left")?.push({ type: "threads" });
  }
  // Nor is the time: places open and close by it, and tasks are due by it.
  if (![...out.values()].some((ws) => ws.some((w) => w.type === "clock"))) {
    out.get("top")?.push({ type: "clock", style: "digital" });
  }
  return out;
}

export function Hud({
  layout,
  ctx,
  extras = {},
}: {
  layout: Layout;
  ctx: HudContext;
  /** The game's own controls, placed after the model's widgets in a region. */
  extras?: Partial<Record<HudRegion, ReactNode>>;
}) {
  const regions = arrange(layout);
  const compact = useCompact();
  if (compact) return <PhoneHud regions={regions} ctx={ctx} extras={extras} />;
  return (
    <section className="hud" aria-label="Game interface">
      {REGIONS.map((region) => {
        const widgets = regions.get(region) ?? [];
        if (widgets.length === 0 && !extras[region]) return null;
        return (
          <div key={region} className={`hud-region r-${region}`}>
            {widgets.map((w, i) => (
              <WidgetView key={`${region}-${i}-${w.type}`} w={w} ctx={ctx} />
            ))}
            {extras[region]}
          </div>
        );
      })}
    </section>
  );
}

/** A phone, either way up. The stylesheet's compact rules use the same query. */
export const COMPACT_QUERY = "(max-width: 720px), (max-height: 500px)";

function useCompact(): boolean {
  const [compact, setCompact] = useState(() => globalThis.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const query = globalThis.matchMedia(COMPACT_QUERY);
    const changed = () => setCompact(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return compact;
}

/** The layout folded for a phone: every widget kept, sorted by what it is for. */
export interface CompactHud {
  /** Always in sight, in the strip: money, the time. */
  strip: Widget[];
  /** The needs the strip sums up. */
  needs: Widget | null;
  /** Read when you open the strip. */
  status: Widget[];
  /** Pressed: along the bottom. */
  dock: Widget[];
  /** Used now and then: in the sheet behind "More". */
  tools: Widget[];
  /** Comes and goes on its own: floats under the bars. */
  float: Widget[];
  threads: boolean;
}

export function compactHud(regions: ReadonlyMap<HudRegion, readonly Widget[]>): CompactHud {
  const out: CompactHud = {
    strip: [],
    needs: null,
    status: [],
    dock: [],
    tools: [],
    float: [],
    threads: false,
  };
  for (const w of REGIONS.flatMap((r) => regions.get(r) ?? [])) {
    switch (w.type) {
      case "wallet":
      case "clock":
        out.strip.push(w);
        break;
      case "needs":
        out.needs ??= w;
        out.status.unshift(w);
        break;
      case "threads":
        out.threads = true;
        break;
      case "chat":
      case "people":
      case "panel":
      case "button":
        out.dock.push(w);
        break;
      case "life":
      case "plan":
        out.tools.push(w);
        break;
      case "trip":
      case "feed":
        out.float.push(w);
        break;
      default:
        out.status.push(w);
    }
  }
  return out;
}

/** The one thing to do next, for the bar: a job's current step, else what you're working towards. */
export function currentStep(
  threads: readonly Thread[],
  minute: number,
): { icon: string; title: string; step: string; target: GoTarget | null; more: number } | null {
  const live = threads.filter(
    (t) => t.state === "open" && t.due + THREAD_BOUNDS.graceMinutes > minute,
  );
  const jobs = live.filter((t) => !t.aim);
  const first = jobs[0] ?? live[0];
  if (!first) return null;
  const step = first.steps[first.progress];
  return {
    icon: first.icon,
    title: first.title,
    step: step?.text ?? first.about,
    target: step ? stepTarget(step) : null,
    more: live.length - 1,
  };
}

type PhoneSheetKey = "status" | "threads" | "chat" | "people" | "tools";

/** A sheet stays mounted while shut: what you typed, and anything still going on in it, lives. */
function PhoneSheet({
  sheet,
  open,
  title,
  onClose,
  onClickCapture,
  children,
}: {
  sheet: PhoneSheetKey;
  open: boolean;
  title: string;
  onClose(): void;
  onClickCapture?: (e: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const grabbed = useRef<number | null>(null);
  return (
    <section
      className={`ph-sheet ph-${sheet} ${open ? "on" : ""}`}
      role="dialog"
      aria-label={title}
      {...(onClickCapture ? { onClickCapture } : {})}
    >
      <div
        className="ph-sheet-head"
        onPointerDown={(e) => {
          grabbed.current = e.clientY;
        }}
        onPointerUp={(e) => {
          // Pulled down by its head: shut, as sheets do.
          if (grabbed.current !== null && e.clientY - grabbed.current > 40) onClose();
          grabbed.current = null;
        }}
      >
        <strong className="grow">{title}</strong>
        <button type="button" className="link" onClick={onClose} aria-label={`Close ${title}`}>
          {"\u{2715}"}
        </button>
      </div>
      <div className="ph-sheet-body">{children}</div>
    </section>
  );
}

/** A phone's keyboard covers the page rather than shrinking it: sheets sit on top of it. */
function useKeyboardInset(): void {
  useEffect(() => {
    const view = globalThis.visualViewport;
    if (!view) return;
    const root = document.documentElement;
    const fit = () => {
      const covered = Math.max(0, globalThis.innerHeight - view.height - view.offsetTop);
      root.style.setProperty("--kb", `${Math.round(covered)}px`);
    };
    view.addEventListener("resize", fit);
    view.addEventListener("scroll", fit);
    fit();
    return () => {
      view.removeEventListener("resize", fit);
      view.removeEventListener("scroll", fit);
      root.style.removeProperty("--kb");
    };
  }, []);
}

/** The strip's picture of the needs: one small bar each, and the worst by name when it matters. */
function NeedSummary({ needs }: { needs: readonly NeedView[] }) {
  if (needs.length === 0) return null;
  const worst = needs.reduce((a, b) => (b.level < a.level ? b : a));
  return (
    <span className="ph-needs">
      <span className="ph-need-bars" aria-hidden>
        {needs.map((n) => (
          <span key={n.key} className={`ph-need t-${tone(n.level)}`}>
            <span style={{ height: `${Math.max(8, n.level / 10)}%` }} />
          </span>
        ))}
      </span>
      {tone(worst.level) !== "good" && (
        <span className={`ph-need-worst t-${tone(worst.level)}`}>
          {worst.label} {Math.round(worst.level / 10)}%
        </span>
      )}
    </span>
  );
}

function PhoneHud({
  regions,
  ctx,
  extras,
}: {
  regions: ReadonlyMap<HudRegion, readonly Widget[]>;
  ctx: HudContext;
  extras: Partial<Record<HudRegion, ReactNode>>;
}) {
  const [sheet, setSheet] = useState<PhoneSheetKey | null>(null);
  const fold = compactHud(regions);
  useKeyboardInset();

  // A different screen: what was open was about the last one. "More" can be what sent you there.
  const { screen } = ctx;
  useEffect(() => {
    if (screen) setSheet((s) => (s === "tools" ? s : null));
  }, [screen]);

  const latest = ctx.chat.at(-1);
  const read = useRef(latest?.id);
  if (sheet === "chat") read.current = latest?.id;
  const unread =
    sheet !== "chat" &&
    latest !== undefined &&
    latest.id !== read.current &&
    latest.shownAt !== 0 &&
    latest.from !== ctx.actingName;

  const toggle = (key: PhoneSheetKey) => setSheet((s) => (s === key ? null : key));
  const close = () => setSheet(null);
  // Whatever takes you somewhere shuts the sheet you pressed it in, so you see it happen.
  const closing: HudContext = {
    ...ctx,
    go: (target) => {
      close();
      ctx.go(target);
    },
    ...(ctx.seeTo
      ? {
          seeTo: (need: string) => {
            close();
            ctx.seeTo?.(need);
          },
        }
      : {}),
    intent: (intent) => {
      close();
      ctx.intent(intent);
    },
  };
  const step = fold.threads ? currentStep(ctx.threads, ctx.minute) : null;
  const toolExtras = (["top", "top_right", "left", "right", "bottom"] as const).map((r) => (
    <Fragment key={r}>{extras[r]}</Fragment>
  ));
  return (
    <section className="ph-hud" aria-label="Game interface">
      <div className="ph-top">
        <div className="ph-strip">
          {extras.top_left}
          <button
            type="button"
            className="ph-summary"
            aria-expanded={sheet === "status"}
            onClick={() => toggle("status")}
          >
            {fold.strip.map((w, i) => (
              <WidgetView key={`strip-${i}-${w.type}`} w={w} ctx={ctx} />
            ))}
            <span className="grow" />
            {fold.needs && <NeedSummary needs={ctx.needs} />}
            <span className="ph-chevron" aria-hidden>
              {"\u{25BE}"}
            </span>
          </button>
        </div>
        {(step || (fold.threads && ctx.marks.length > 0)) && (
          <div className="ph-quest">
            <button
              type="button"
              className="ph-quest-open"
              aria-expanded={sheet === "threads"}
              onClick={() => toggle("threads")}
            >
              {step ? (
                <>
                  <span className="ph-quest-icon" aria-hidden>
                    {step.icon}
                  </span>
                  <span className="ph-quest-text">
                    <span className="ph-quest-step">{step.step}</span>
                    <span className="muted small">
                      {step.title}
                      {step.more > 0 && ` \u{00B7} +${step.more}`}
                    </span>
                  </span>
                </>
              ) : (
                <span className="ph-quest-text">
                  <span className="ph-quest-step">
                    {ctx.marks.map((m) => `${m.label} ${m.value}`).join(" \u{00B7} ")}
                  </span>
                </span>
              )}
            </button>
            {step?.target && (
              <button
                type="button"
                className="ph-quest-go"
                aria-label={`Go: ${step.step}`}
                onClick={() => closing.go(step.target as GoTarget)}
              >
                <span aria-hidden>{"\u{27A1}\u{FE0F}"}</span>
              </button>
            )}
          </div>
        )}
        <div className="ph-float">
          {fold.float.map((w, i) => (
            <WidgetView key={`float-${i}-${w.type}`} w={w} ctx={ctx} />
          ))}
        </div>
      </div>

      {sheet !== null && (
        <button
          type="button"
          className={`ph-back ph-back-${sheet}`}
          aria-label="Close"
          onClick={close}
        />
      )}

      {/* Open or shut, this is mounted: it can be on the map's business, or waiting on an answer. */}
      <PhoneSheet
        sheet="tools"
        open={sheet === "tools"}
        title="More"
        onClose={close}
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest(".ask-finding")) close();
        }}
      >
        {fold.tools.map((w, i) => (
          <WidgetView key={`tools-${i}-${w.type}`} w={w} ctx={closing} />
        ))}
        {toolExtras}
      </PhoneSheet>
      <PhoneSheet sheet="status" open={sheet === "status"} title={ctx.actingName} onClose={close}>
        {fold.status.map((w, i) => (
          <WidgetView key={`status-${i}-${w.type}`} w={w} ctx={closing} />
        ))}
      </PhoneSheet>
      {fold.threads && (
        <PhoneSheet
          sheet="threads"
          open={sheet === "threads"}
          title="What you're doing"
          onClose={close}
        >
          <WidgetView w={{ type: "threads" }} ctx={closing} />
        </PhoneSheet>
      )}
      {fold.dock.some((w) => w.type === "chat") && ctx.inPlace && (
        <PhoneSheet sheet="chat" open={sheet === "chat"} title="Chat" onClose={close}>
          <Chat ctx={closing} full />
        </PhoneSheet>
      )}
      {fold.dock.some((w) => w.type === "people") && ctx.inPlace && (
        <PhoneSheet sheet="people" open={sheet === "people"} title="Here now" onClose={close}>
          <People ctx={closing} full />
        </PhoneSheet>
      )}

      <div className="ph-corner ph-bl">{extras.bottom_left}</div>
      <div className="ph-corner ph-br">{extras.bottom_right}</div>

      <nav className="ph-dock" aria-label="Actions">
        {fold.dock.map((w, i) => (
          <DockButton
            key={`dock-${i}-${w.type}`}
            w={w}
            ctx={ctx}
            active={sheet === w.type}
            unread={w.type === "chat" && unread}
            onSheet={toggle}
          />
        ))}
        <button
          type="button"
          className={`ph-tab ph-more ${sheet === "tools" ? "on" : ""}`}
          aria-expanded={sheet === "tools"}
          onClick={() => toggle("tools")}
        >
          <span className="ph-tab-icon" aria-hidden>
            {"\u{22EF}"}
          </span>
          <span className="ph-tab-label">More</span>
        </button>
      </nav>
    </section>
  );
}

/** One thing along the bottom, in the words and icon its widget has. */
function DockButton({
  w,
  ctx,
  active,
  unread,
  onSheet,
}: {
  w: Widget;
  ctx: HudContext;
  active: boolean;
  unread: boolean;
  onSheet(key: PhoneSheetKey): void;
}) {
  const tab = (icon: string, label: string, onClick: () => void, sheet = false) => (
    <button
      type="button"
      className={`ph-tab ${active ? "on" : ""}`}
      {...(sheet ? { "aria-expanded": active } : {})}
      onClick={onClick}
    >
      <span className="ph-tab-icon" aria-hidden>
        {icon}
      </span>
      <span className="ph-tab-label">{label}</span>
      {unread && <span className="ph-dot" role="img" aria-label="New" />}
    </button>
  );
  if (w.type === "chat") {
    return ctx.inPlace ? tab("\u{1F4AC}", "Chat", () => onSheet("chat"), true) : null;
  }
  if (w.type === "people") {
    return ctx.inPlace
      ? tab("\u{1F465}", `${ctx.roster.length} here`, () => onSheet("people"), true)
      : null;
  }
  if (w.type === "panel") {
    const panel = ctx.city.ui.panels.find((p) => p.key === w.panel);
    return panel
      ? tab(panel.icon, panel.label, () => ctx.intent({ do: "panel", panel: panel.key }))
      : null;
  }
  if (w.type === "button") return tab(w.icon, w.label, () => ctx.intent(w.intent));
  return null;
}

/** Your money, and what just changed it (+60 in, -500 out) for a moment: you see it move. */
function Wallet({ wallet, currency }: { wallet: number | null; currency: string }) {
  const seen = useRef<number | null>(null);
  const [change, setChange] = useState<{ id: number; by: number } | null>(null);
  useEffect(() => {
    if (wallet === null) return;
    const before = seen.current;
    seen.current = wallet;
    if (before === null || before === wallet) return;
    setChange({ id: Date.now(), by: wallet - before });
    const t = setTimeout(() => setChange(null), 3_000);
    return () => clearTimeout(t);
  }, [wallet]);
  return (
    <div className="w w-pill w-wallet" title="Your money">
      <span aria-hidden>{"\u{1F4B0}"}</span>
      {wallet === null ? "…" : money(wallet, currency)}
      {change && (
        <span key={change.id} className={`wallet-change ${change.by > 0 ? "t-good" : "t-bad"}`}>
          {change.by > 0 ? "+" : "\u{2212}"}
          {money(Math.abs(change.by), currency)}
        </span>
      )}
    </div>
  );
}

const tone = (level: number) => (level >= 600 ? "good" : level >= 300 ? "warn" : "bad");

function WidgetView({ w, ctx }: { w: Widget; ctx: HudContext }) {
  switch (w.type) {
    case "brand":
      return (
        <div className="w w-brand">
          <span className="w-brand-icon" aria-hidden>
            {ctx.city.icon}
          </span>
          <span>{ctx.city.name}</span>
        </div>
      );
    case "wallet":
      return <Wallet wallet={ctx.wallet} currency={ctx.city.currency} />;
    case "clock": {
      const phase = dayPhase(ctx.city.sun, ctx.clock.minuteOfDay);
      const night = phase < 0 || phase > 1;
      return (
        <div className="w w-pill" title="City time">
          {w.style === "sun" && <span aria-hidden>{night ? "\u{1F319}" : "\u{2600}\u{FE0F}"}</span>}
          <span className="muted">
            {ctx.city.words.day} {ctx.clock.day}
          </span>
          <strong>{clockText(ctx.clock.minuteOfDay)}</strong>
        </div>
      );
    }
    case "needs": {
      // The three lowest, kept in the city's own order so the rows don't jump about.
      const lowest = new Set(
        [...ctx.needs]
          .sort((a, b) => a.level - b.level)
          .slice(0, 3)
          .map((n) => n.key),
      );
      const needs = w.show === "lowest3" ? ctx.needs.filter((n) => lowest.has(n.key)) : ctx.needs;
      if (needs.length === 0) return null;
      if (w.style === "rings") {
        return (
          <section className="w w-card w-rings" aria-label={`${ctx.actingName}'s needs`}>
            {needs.map((n) => (
              <button
                type="button"
                key={n.key}
                className={`ring t-${tone(n.level)}`}
                title={`${n.label}: ${Math.round(n.level / 10)}%. Tap to see to it.`}
                onClick={() => ctx.seeTo?.(n.key)}
              >
                <div
                  className="ring-dial"
                  style={{ "--p": `${n.level / 10}%` } as React.CSSProperties}
                />
                <span>{n.label}</span>
              </button>
            ))}
          </section>
        );
      }
      if (w.style === "chips") {
        return (
          <section className="w w-chips" aria-label={`${ctx.actingName}'s needs`}>
            {needs.map((n) => (
              <button
                type="button"
                key={n.key}
                className={`chip t-${tone(n.level)}`}
                title="Tap to see to it."
                onClick={() => ctx.seeTo?.(n.key)}
              >
                {n.label} {Math.round(n.level / 10)}%
              </button>
            ))}
          </section>
        );
      }
      return (
        <section className="w w-card w-bars" aria-label={`${ctx.actingName}'s needs`}>
          <div className="w-title">{ctx.actingName}</div>
          {needs.map((n) => (
            <button
              type="button"
              key={n.key}
              className="bar-row"
              title="Tap to see to it."
              onClick={() => ctx.seeTo?.(n.key)}
            >
              <span>{n.label}</span>
              <meter className="sr-only" min={0} max={1000} value={n.level} aria-label={n.label} />
              <div className="bar" aria-hidden>
                <div
                  className={`bar-fill t-${tone(n.level)}`}
                  style={{ width: `${n.level / 10}%` }}
                />
              </div>
            </button>
          ))}
        </section>
      );
    }
    case "doing":
      return ctx.inPlace ? (
        <div className="w w-pill">
          <span className="muted">{ctx.actingName}:</span> {ctx.doing || ctx.city.words.idle}
        </div>
      ) : ctx.placeName ? (
        <div className="w w-pill">
          <span className="muted">At</span> {ctx.placeName}
        </div>
      ) : null;
    case "resources":
      return ctx.resources.length === 0 ? null : (
        <div className="w w-chips">
          {ctx.resources.map((r) => (
            <span key={r.label} className={`chip ${r.on ? "t-good" : "t-bad off"}`}>
              {r.label}
            </span>
          ))}
        </div>
      );
    case "ticker":
      return ctx.city.headlines.length === 0 ? null : (
        <div className="w w-ticker" role="marquee" aria-label="News">
          <div className="ticker-track">
            {[...ctx.city.headlines, ...ctx.city.headlines].map((h, i) => (
              <span key={`${i}-${h.text}`} aria-hidden={i >= ctx.city.headlines.length}>
                {h.icon} {h.text}
              </span>
            ))}
          </div>
        </div>
      );
    case "presence":
      return (
        <div className="w w-pill">
          <span className="dot t-good" aria-hidden /> {ctx.online} online
        </div>
      );
    case "chat":
      return <Chat ctx={ctx} />;
    case "people":
      return ctx.inPlace ? <People ctx={ctx} /> : null;
    case "feed":
      return ctx.feed.length === 0 ? null : (
        <div className="w-feed" aria-live="polite">
          {ctx.feed.slice(0, 4).map((f, i) => (
            <div key={f.id} className="feed-line" style={{ opacity: 1 - i * 0.22 }}>
              {f.text}
            </div>
          ))}
        </div>
      );
    case "life":
      return ctx.screen === "map" ? ctx.slots.life : null;
    case "plan":
      return ctx.screen === "map" ? ctx.slots.plan : null;
    case "trip":
      return ctx.slots.trip;
    case "threads":
      return (
        <Threads
          {...(ctx.priceOf ? { priceOf: ctx.priceOf } : {})}
          threads={ctx.threads}
          minute={ctx.minute}
          currency={ctx.city.currency}
          go={ctx.go}
          marks={ctx.marks}
          markOf={ctx.markOf}
          markLabel={(key) => ctx.city.marks.find((m) => m.key === key)?.label ?? key}
          wallet={ctx.wallet}
        />
      );
    case "panel": {
      // The panel's own name and icon, as the city's model wrote them.
      const panel = ctx.city.ui.panels.find((p) => p.key === w.panel);
      return panel ? (
        <button
          type="button"
          className="w w-button"
          onClick={() => ctx.intent({ do: "panel", panel: panel.key })}
        >
          <span aria-hidden>{panel.icon}</span> {panel.label}
        </button>
      ) : null;
    }
    case "text":
      return <div className={`w w-text tone-${w.tone}`}>{w.text}</div>;
    case "button":
      return (
        <button type="button" className="w w-button" onClick={() => ctx.intent(w.intent)}>
          <span aria-hidden>{w.icon}</span> {w.label}
        </button>
      );
  }
}

/** Chat stays small: the last few lines over a single input, opened up on demand. */
/** Hold to talk: what you said goes in the chat, and the answer you get is read out. */
function Mic({ ctx, onHeard }: { ctx: HudContext; onHeard(): void }) {
  const [state, setState] = useState<"idle" | "listening" | "hearing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const stop = useRef<(() => Promise<Blob>) | null>(null);
  // Still holding the button? Letting go before the microphone is ready must stop it, or it
  // would start listening to someone who has already let go.
  const holding = useRef(false);
  const hear = ctx.hearSpeech;
  if (!hear) return null;
  const start = async () => {
    if (state !== "idle" || holding.current) return;
    holding.current = true;
    setProblem(null);
    try {
      // Only once the browser has said yes: until then nothing is listening.
      const end = await startRecording();
      if (holding.current) {
        stop.current = end;
        setState("listening");
      } else {
        void end();
        setState("idle");
      }
    } catch {
      holding.current = false;
      setState("idle");
      setProblem("Your browser didn't let us use the microphone.");
    }
  };
  const finish = async () => {
    if (!holding.current) return;
    holding.current = false;
    const end = stop.current;
    stop.current = null;
    // Not recording yet: `start` stops it as soon as it is.
    if (!end) return;
    setState("hearing");
    try {
      const said = await hear(await speechWav(await end()));
      if (said.trim()) {
        onHeard();
        ctx.say(said);
      } else {
        setProblem("Didn't catch that. Try again?");
      }
    } catch {
      setProblem("Didn't catch that. Try again?");
    }
    setState("idle");
  };
  return (
    <>
      <button
        type="button"
        className={`mic mic-${state}`}
        aria-label={state === "listening" ? "Listening: let go when you're done" : "Hold to talk"}
        title="Hold to talk"
        disabled={state === "hearing"}
        onPointerDown={() => void start()}
        onPointerUp={() => void finish()}
        onPointerLeave={() => void finish()}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) void start();
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") void finish();
        }}
      >
        <span aria-hidden>{state === "hearing" ? "\u{2026}" : "\u{1F3A4}"}</span>
      </button>
      {problem && (
        <span className="t-bad small mic-problem" role="alert">
          {problem}
        </span>
      )}
    </>
  );
}

function Chat({ ctx, full = false }: { ctx: HudContext; full?: boolean }) {
  const [text, setText] = useState("");
  const [folded, setOpen] = useState(false);
  const open = full || folded;
  const shown = useRef<HTMLButtonElement>(null);
  // You spoke out loud: whoever answers is read out too.
  const readOut = useRef(false);
  const latest = ctx.chat.at(-1);
  const latestId = latest?.id;
  useEffect(() => {
    if (!latestId || !readOut.current) return;
    const line = ctx.chat.at(-1);
    if (!line || line.from === ctx.actingName) return;
    readOut.current = false;
    speak(line.text);
  }, [latestId, ctx.chat, ctx.actingName]);
  // In a sheet, the newest line is the one in view.
  useEffect(() => {
    if (full && latestId && shown.current) shown.current.scrollTop = shown.current.scrollHeight;
  }, [full, latestId]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Not connected: what they wrote stays in the box rather than vanishing.
    if (!text.trim() || !ctx.connected) return;
    ctx.say(text);
    setText("");
  };
  if (!ctx.inPlace) return null;
  const lines = ctx.chat.slice(open ? -10 : -2);
  // The latest offer made to you, while it's still among the last few lines.
  const offer = ctx.chat.slice(-4).findLast((c) => c.offer)?.offer;
  return (
    <div className={`w w-chat ${open ? "open" : ""}`}>
      {lines.length > 0 && (
        <button
          type="button"
          ref={shown}
          className="chat-lines"
          aria-live="polite"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={open ? "Show less" : "Show more"}
        >
          {lines.map((c) => (
            <span key={c.id} className={`chat-line ${c.shownAt === 0 ? "earlier" : ""}`}>
              <strong>{c.from}</strong> {c.text}
            </span>
          ))}
          {ctx.replying && (
            <span className="chat-line typing">
              <span aria-hidden>{"\u{2026}"}</span>
              <span className="sr-only">Someone is answering</span>
            </span>
          )}
        </button>
      )}
      {offer && ctx.here && (
        <button
          type="button"
          className="primary chat-offer"
          onClick={() =>
            ctx.go({
              place: ctx.here as string,
              kind: offer.kind,
              action: offer.action,
              label: offer.label,
            })
          }
        >
          {offer.label}
          {offer.cost > 0 && ` \u{00B7} ${money(offer.cost, ctx.city.currency)}`}
          {offer.income > 0 && ` \u{00B7} +${money(offer.income, ctx.city.currency)}`}
        </button>
      )}
      <form onSubmit={submit} className="chat-form">
        <span aria-hidden>{"\u{1F4AC}"}</span>
        <input
          value={text}
          maxLength={280}
          onChange={(e) => setText(e.target.value)}
          placeholder={ctx.connected ? "Say something…" : "Waiting to reconnect…"}
          aria-label="Message"
        />
        <Mic
          ctx={ctx}
          onHeard={() => {
            readOut.current = true;
          }}
        />
      </form>
    </div>
  );
}

/** Who's here, folded to a count until opened: the world matters more than the list. */
function People({ ctx, full = false }: { ctx: HudContext; full?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open && !full) {
    return (
      <button type="button" className="w w-pill" onClick={() => setOpen(true)}>
        <span aria-hidden>{"\u{1F465}"}</span> {ctx.roster.length} here
      </button>
    );
  }
  return (
    <div className="w w-card w-people">
      {!full && (
        <div className="w-title row">
          <span className="grow">Here now</span>
          <button type="button" className="link small" onClick={() => setOpen(false)}>
            Hide
          </button>
        </div>
      )}
      {ctx.roster.map((r) => {
        const mine = r.heldBy === ctx.myHandle;
        return (
          <div key={r.key} className="person-row">
            <span className="swatch" style={{ background: r.person.colours.top }} aria-hidden />
            <span className="grow">
              {r.person.name}
              {r.player && <span className="muted"> @{r.player}</span>}
              {ctx.closenessOf(r.key) > 0 && (
                <span className="muted small">
                  {" "}
                  {"\u{1F91D}"} {ctx.closenessOf(r.key)}
                </span>
              )}
            </span>
            {!r.player &&
              (mine ? (
                <button type="button" className="mini" onClick={ctx.release}>
                  Let go
                </button>
              ) : r.heldBy ? (
                <span className="muted small">@{r.heldBy}</span>
              ) : (
                <button type="button" className="mini" onClick={() => ctx.hold(r.key)}>
                  Play as
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What you're in the middle of: each open thread, its steps (done, now, to come), when it's
 * due and what it pays. Every word is the director's, rendered as text.
 */
/** Where a step sends you, and what to do there: tapping the step takes you. */
function stepTarget(s: Thread["steps"][number]): GoTarget | null {
  if (s.check === "have_money" || s.check === "mark") return null;
  if (s.check === "do") return { place: s.place, kind: s.kind, action: s.action, label: s.text };
  return { place: s.place, label: s.text };
}

/** City minutes before a job's deadline when its time goes red. */
const THREAD_SOON_MIN = 60;

/** What rides on a job, in the words of the marks it moves. */
function stakesText(stakes: Thread["onDone"], markLabel: (mark: string) => string): string {
  return (stakes ?? [])
    .map((s) => ` \u{00B7} ${markLabel(s.mark)} ${s.by > 0 ? "+" : ""}${s.by}`)
    .join("");
}

function Threads({
  priceOf,
  threads,
  minute,
  currency,
  go,
  marks,
  markOf,
  markLabel,
  wallet,
}: {
  priceOf?(place: string, kind: string, action: string): number;
  marks: readonly { label: string; value: number }[];
  markOf(mark: string): number;
  markLabel(mark: string): string;
  wallet: number | null;
  threads: readonly Thread[];
  minute: number;
  currency: string;
  go(target: GoTarget): void;
}) {
  const live = threads.filter(
    (t) => t.state === "open" && t.due + THREAD_BOUNDS.graceMinutes > minute,
  );
  const open = live.filter((t) => !t.aim);
  const aim = live.find((t) => t.aim);
  const aimStep = aim?.steps[aim.progress];
  if (open.length === 0 && !aim && marks.length === 0) return null;
  return (
    <div className="w w-card w-threads" aria-live="polite">
      {aim && (
        <div className="thread aim">
          <div className="thread-head">
            <span aria-hidden>{aim.icon}</span> <strong>{aim.title}</strong>
          </div>
          <div className="muted small">{aim.steps[aim.progress]?.text ?? aim.about}</div>
          {aimStep?.check === "mark" && (
            <div className="muted small">
              {markLabel(aimStep.mark)}: {markOf(aimStep.mark)} of {aimStep.atLeast}
            </div>
          )}
          {aimStep?.check === "have_money" && (
            <div className="muted small">
              {money(wallet ?? 0, currency)} of {money(aimStep.atLeast, currency)}
            </div>
          )}
        </div>
      )}
      {marks.length > 0 && (
        <div className="marks">
          {marks.map((m) => (
            <span key={m.label} className="mark-chip">
              {m.label} {m.value}
            </span>
          ))}
        </div>
      )}
      {open.slice(0, 2).map((t, order) => (
        <div key={t.id} className="thread">
          <div className="thread-head">
            <span aria-hidden>{t.icon}</span> <strong>{t.title}</strong>
          </div>
          <div className={`small ${minute >= t.due - THREAD_SOON_MIN ? "t-bad" : "muted"}`}>
            {"\u{23F3}"} {minute >= t.due ? "Late \u{00B7} " : ""}
            {clockText(t.due % 1440)}
            {Math.floor(t.due / 1440) > Math.floor(minute / 1440) ? " +1d" : ""}
            {t.reward > 0 ? ` \u{00B7} \u{1F4B0} ${money(t.reward, currency)}` : ""}
            {stakesText(t.onDone, markLabel)}
          </div>
          {t.progress > 0 && (t.onMissed?.length ?? 0) > 0 && (
            <div className="small t-bad">
              If it slips:{stakesText(t.onMissed, markLabel).replace(/^ \u{00B7}/u, "")}
            </div>
          )}
          {order === 0 && <div className="muted small">{t.about}</div>}
          <ol className="thread-steps">
            {t.steps.map((s, i) => {
              // The first job in full; the rest only what's next, so all of them stay in sight.
              if (order > 0 && i !== t.progress) return null;
              const target = i === t.progress ? stepTarget(s) : null;
              const price = s.check === "do" ? (priceOf?.(s.place, s.kind, s.action) ?? 0) : 0;
              const priced = price > 0 ? ` \u{00B7} ${money(price, currency)}` : "";
              return (
                <li
                  key={`${t.id}-${i}`}
                  className={i < t.progress ? "done" : i === t.progress ? "now" : "later"}
                >
                  {target ? (
                    <button type="button" className="step-go" onClick={() => go(target)}>
                      {s.text}
                      {priced} <span aria-hidden>{"\u{27A1}\u{FE0F}"}</span>
                    </button>
                  ) : (
                    `${s.text}${priced}`
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}
