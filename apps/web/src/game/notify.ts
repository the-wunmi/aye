/**
 * Telling someone a long build has finished, with a browser notification if they've allowed one.
 * It takes the tab being open: this asks the browser, and nothing is sent from our server. Asked
 * for only when someone starts a build, because that's when the reason is obvious. Where a
 * browser can't or won't, the game's own banner still says so.
 */

/** Ask, from something they just tapped: browsers refuse otherwise. */
export function askToNotify(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/** Only when they're looking elsewhere; `key` keeps two open tabs from saying it twice. */
export async function notifyAway(key: string, title: string, body: string): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try {
    const worker = await navigator.serviceWorker?.register("/sw.js");
    if (worker) await worker.showNotification(title, { body, tag: key });
    else new Notification(title, { body, tag: key });
  } catch {
    // The banner still says it.
  }
}
