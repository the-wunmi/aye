/**
 * The planner's card: the road you clicked (its real name, lanes, speed), what to
 * change about it, and a day with the plan against a day without. Every string from the
 * network (street names) is rendered as a React text node only.
 */
import { LAST_ROAD_CLASS, ROAD_CLASSES, type RoadNetwork } from "@aye/schema";
import type { CityReport } from "@aye/sim";
import type { usePlan } from "./usePlan.ts";

const fmt = (n: number) => Math.round(n).toLocaleString();

function Row({
  label,
  base,
  plan,
  better,
  unit = "",
  plain = false,
}: {
  label: string;
  base: number;
  plan: number;
  /** Whether less is better for this measure. */
  better: "less" | "more";
  unit?: string;
  /** Don't call this better or worse (it only looks better because trips were lost). */
  plain?: boolean;
}) {
  const d = plan - base;
  const good = better === "less" ? d < 0 : d > 0;
  const share = base > 0 ? (Math.abs(d) / base) * 100 : 0;
  const sign = d > 0 ? "+" : "-";
  const change =
    share < 0.1
      ? "under 0.1%"
      : share < 10
        ? `${sign}${share.toFixed(1)}%`
        : `${sign}${Math.round(share)}%`;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {fmt(base)}
        {unit}
      </td>
      <td>
        {fmt(plan)}
        {unit}
      </td>
      <td className={d === 0 || plain ? "muted" : good ? "plan-good" : "plan-bad"}>
        {d === 0 ? "same" : base > 0 ? change : `${d > 0 ? "+" : ""}${fmt(d)}${unit}`}
      </td>
    </tr>
  );
}

const avg = (r: CityReport) => (r.trips > 0 ? r.tripMinutes / r.trips : 0);

export function PlanCard({
  plan,
  network,
  selected,
  onClose,
}: {
  plan: ReturnType<typeof usePlan>;
  network: RoadNetwork;
  selected: number | null;
  onClose(): void;
}) {
  const row = selected === null ? null : network.links.slice(selected * 7, selected * 7 + 7);
  const name = row ? (network.names[row[6] ?? -1] ?? "Unnamed road") : null;
  const closed = selected !== null && plan.edits.closed.includes(selected);
  const lanes = selected === null ? 0 : plan.lanesOf(selected);
  const r = plan.result;
  const lost = r ? r.plan.unreached > r.base.unreached : false;
  const isRoad = row !== null && (row[5] ?? 0) <= LAST_ROAD_CLASS;
  return (
    <div className="w w-card plan-card" aria-live="polite">
      <div className="plan-head">
        <div className="w-title">What if…</div>
        <button type="button" className="sys-pill" onClick={onClose}>
          Done
        </button>
      </div>
      {row && selected !== null ? (
        <div className="plan-road">
          <strong>{name}</strong>
          <div className="muted small">
            {ROAD_CLASSES[row[5] ?? 0]} · {row[3]} km/h · {row[4] ? "one-way" : "both ways"}
            {isRoad && ` · ${row[2]} lane${row[2] === 1 ? "" : "s"} each way`}
          </div>
          <div className="plan-actions">
            <button type="button" className="sys-pill" onClick={() => plan.toggleClosed(selected)}>
              {closed ? "Reopen it" : "Close it"}
            </button>
            {isRoad && (
              <>
                <button
                  type="button"
                  className="sys-pill"
                  disabled={closed || lanes <= 1}
                  onClick={() => plan.setLanes(selected, lanes - 1)}
                  aria-label="One lane fewer each way"
                >
                  −
                </button>
                <span>
                  {lanes} lane{lanes === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  className="sys-pill"
                  disabled={closed || lanes >= 8}
                  onClick={() => plan.setLanes(selected, lanes + 1)}
                  aria-label="One lane more each way"
                >
                  +
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="muted small">Tap a road on the map to close it or change its lanes.</div>
      )}
      <div className="plan-actions">
        <span className="small">
          {plan.count === 0
            ? "No changes yet"
            : `${plan.edits.closed.length} closed, ${plan.edits.lanes.length} with new lanes`}
        </span>
        {plan.count > 0 && (
          <button type="button" className="sys-pill" onClick={plan.clear}>
            Clear
          </button>
        )}
      </div>
      <button
        type="button"
        className="w-button"
        disabled={plan.count === 0 || plan.progress !== null}
        onClick={plan.compare}
      >
        {plan.progress !== null
          ? `Playing two days… ${Math.round(plan.progress * 100)}%`
          : "Compare a day"}
      </button>
      {r && (
        <>
          {lost && (
            <div className="small">
              Some trips can't happen with this plan, so anything left looks quicker than it is.
            </div>
          )}
          <table className="plan-table">
            <thead>
              <tr>
                <th />
                <th scope="col">Today</th>
                <th scope="col">Plan</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Trips made" base={r.base.trips} plan={r.plan.trips} better="more" />
              <Row
                label="Trips impossible"
                base={r.base.unreached}
                plan={r.plan.unreached}
                better="less"
              />
              <Row
                label="Average trip"
                base={avg(r.base)}
                plan={avg(r.plan)}
                better="less"
                unit=" min"
                plain={lost}
              />
              <Row
                label="Hours queued"
                base={r.base.queuedMinutes / 60}
                plan={r.plan.queuedMinutes / 60}
                better="less"
                plain={lost}
              />
            </tbody>
          </table>
          <div className="muted small">
            {plan.current ? "" : "For an earlier version of the plan. "}
            On the map: red roads are fuller with the plan, green emptier (06:00–21:00). The same
            people and the same day both times, so the difference is the roads'; the demand itself
            is a model's estimate.
          </div>
        </>
      )}
    </div>
  );
}
