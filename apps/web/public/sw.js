// Only here so notifications can be shown on browsers that insist on a service worker for them,
// and so tapping one brings the game back. It doesn't touch requests and caches nothing.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      const tab = open[0];
      return tab ? tab.focus() : self.clients.openWindow("/");
    }),
  );
});
