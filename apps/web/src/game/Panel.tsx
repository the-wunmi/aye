/**
 * A panel: some of the apps the city's model wrote, grouped and named as it chose (a phone, a
 * laptop, a notice board), drawn in the form it picked. Each app is a column of blocks
 * (headings, text, live stats, lists over generic data sources, buttons). Tapping a listed
 * place shows it on the map. Every word comes from the spec and renders as text.
 */
import type { AppDef, Binding, Block, Intent, PanelDef } from "@aye/schema";
import { useState } from "react";
import { clockText, money } from "../format.ts";
import { type GoTarget, type Item, listItems, type SourceContext } from "./sources.ts";

export interface PanelContext extends SourceContext {
  wallet: number | null;
  clock: { day: number; minuteOfDay: number };
  name: string;
  placeName: string | null;
  doing: string;
  needLevel(need: string): number | null;
  intent(intent: Intent): void;
  /** Take the player there, and do it once there. */
  go(target: GoTarget): void;
}

export function Panel({
  panel,
  apps: all,
  ctx,
  onClose,
  initialApp,
}: {
  panel: PanelDef;
  apps: readonly AppDef[];
  ctx: PanelContext;
  onClose(): void;
  initialApp: string | null;
}) {
  const apps = panel.apps.flatMap((k) => all.filter((a) => a.key === k));
  const [open, setOpen] = useState<string | null>(
    initialApp ?? (apps.length === 1 ? (apps[0]?.key ?? null) : null),
  );
  const app = apps.find((a) => a.key === open);
  return (
    <div className={`apps-panel form-${panel.form}`} role="dialog" aria-label={panel.label}>
      <div className="apps-panel-bar">
        {app ? (
          <button type="button" className="link" onClick={() => setOpen(null)}>
            ‹ Apps
          </button>
        ) : (
          <span className="muted">
            <span aria-hidden>{panel.icon}</span> {panel.label} · {clockText(ctx.clock.minuteOfDay)}
          </span>
        )}
        <button
          type="button"
          className="link"
          onClick={onClose}
          aria-label={`Close ${panel.label}`}
        >
          ✕
        </button>
      </div>
      {app ? (
        <div className="app" style={{ "--app": app.colour } as React.CSSProperties}>
          <div className="app-head">
            <span aria-hidden>{app.icon}</span> {app.label}
          </div>
          {app.blocks.map((b, i) => (
            <BlockView
              key={`${app.key}-${i}`}
              b={b}
              ctx={{
                ...ctx,
                intent: (it) => (it.do === "open_app" ? setOpen(it.app) : ctx.intent(it)),
              }}
            />
          ))}
        </div>
      ) : (
        <div className="app-grid">
          {apps.map((a) => (
            <button key={a.key} type="button" className="app-icon" onClick={() => setOpen(a.key)}>
              <span className="app-tile" style={{ background: a.colour }} aria-hidden>
                {a.icon}
              </span>
              <span>{a.label}</span>
            </button>
          ))}
          {apps.length === 0 && <div className="muted">No apps in this city.</div>}
        </div>
      )}
    </div>
  );
}

function bound(value: Binding, ctx: PanelContext): string {
  switch (value.of) {
    case "wallet":
      return ctx.wallet === null ? "…" : money(ctx.wallet, ctx.bundle.city.currency);
    case "clock":
      return `Day ${ctx.clock.day}, ${clockText(ctx.clock.minuteOfDay)}`;
    case "place":
      return ctx.placeName ?? "On the move";
    case "players_online":
      return String(ctx.online);
    case "name":
      return ctx.name;
    case "doing":
      return ctx.doing || "Free";
    case "need": {
      const level = ctx.needLevel(value.need);
      return level === null ? "—" : `${Math.round(level / 10)}%`;
    }
  }
}

function BlockView({ b, ctx }: { b: Block; ctx: PanelContext }) {
  switch (b.type) {
    case "heading":
      return <h3 className="app-h">{b.text}</h3>;
    case "text":
      return <p className="app-p">{b.text}</p>;
    case "stat":
      return (
        <div className="app-stat">
          <span className="muted">{b.label}</span>
          <strong>{bound(b.value, ctx)}</strong>
        </div>
      );
    case "button":
      return (
        <button type="button" className="app-button" onClick={() => ctx.intent(b.intent)}>
          {b.label}
        </button>
      );
    case "list": {
      const items = listItems(b.source, ctx, b.limit);
      return (
        <ul className="app-list">
          {items.length === 0 && <li className="muted">{b.empty}</li>}
          {items.map((item) => (
            <ItemRow key={item.id} item={item} ctx={ctx} />
          ))}
        </ul>
      );
    }
  }
}

function ItemRow({ item, ctx }: { item: Item; ctx: PanelContext }) {
  const body = (
    <>
      <span className="item-icon" aria-hidden>
        {item.icon}
      </span>
      <span className="item-text">
        <span>{item.title}</span>
        {item.detail && <span className="muted small">{item.detail}</span>}
      </span>
      {item.lacking && <span className="muted small">{item.lacking}</span>}
      {item.badge && <span className={`badge t-${item.tone}`}>{item.badge}</span>}
    </>
  );
  return (
    <li>
      {item.place ? (
        <button
          type="button"
          className="item"
          disabled={item.lacking !== undefined}
          title={item.lacking}
          onClick={() =>
            item.act
              ? ctx.go({ place: item.place as string, ...item.act, label: item.title })
              : ctx.intent({ do: "show_place", place: item.place as string })
          }
        >
          {body}
        </button>
      ) : (
        <div className="item">{body}</div>
      )}
    </li>
  );
}
