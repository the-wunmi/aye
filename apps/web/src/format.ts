/** Display formatting: money in a city's currency, clock times. Display only. */

const formatters = new Map<string, Intl.NumberFormat>();
const digits = new Map<string, number>();

/** Part-units are shown in full: £12.90, never £12.9. */
function withDigits(major: number, currency: string, digitCount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: digitCount,
    maximumFractionDigits: digitCount,
  }).format(major);
}

/** What's owed, to the next whole unit once it's more than small change: "₦67", not "₦66.76". */
export function moneyOwed(minor: number, currency: string): string {
  const d =
    new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const unit = 10 ** d;
  return money(minor < 10 * unit ? minor : Math.ceil(minor / unit) * unit, currency);
}

/**
 * Minor units of `currency` as a short price ("₦5,000", "€12.50"). Amounts of 100 or more are
 * shown whole: nobody reads kobo on a fare.
 */
export function money(minor: number, currency: string): string {
  let f = formatters.get(currency);
  let d = digits.get(currency);
  if (!f || d === undefined) {
    const probe = new Intl.NumberFormat(undefined, { style: "currency", currency });
    d = probe.resolvedOptions().maximumFractionDigits ?? 2;
    digits.set(currency, d);
    f = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: d,
    });
    formatters.set(currency, f);
  }
  const major = minor / 10 ** d;
  if (Math.abs(major) >= 100) return f.format(Math.round(major));
  if (Number.isInteger(major)) return f.format(major);
  return withDigits(major, currency, d);
}

export function clockText(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60) % 24;
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** A closed place, with when it opens if it has hours: "Lock · opens 08:00". */
export function closedText(closedNow: string, hours: { from: number } | null): string {
  return hours ? `${closedNow} · opens ${clockText(hours.from)}` : closedNow;
}

export function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The city's clock, the same way the realm server keeps it. */
export function cityClock(
  createdAt: string,
  settings: { startMinuteOfDay: number; ticksPerRealSecond: number },
  now = Date.now(),
): { day: number; minuteOfDay: number } {
  const elapsedS = (now - Date.parse(createdAt)) / 1000;
  const m = settings.startMinuteOfDay + Math.floor((elapsedS * settings.ticksPerRealSecond) / 60);
  return { day: Math.floor(m / 1440) + 1, minuteOfDay: m % 1440 };
}
