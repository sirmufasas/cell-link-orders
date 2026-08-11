// Service worker for "orders closing soon" push reminders.
//
// Browsers only let page code (AudioContext / SpeechSynthesis) run inside
// an actual open tab — a service worker has no audio APIs of its own. So:
//   - If a tab for this app is open (visible or just backgrounded), we
//     postMessage it and let the page play the real siren + shouted voice
//     via src/lib/alertSound.ts — the exact same sound as the admin alert.
//   - If no tab is open at all, we fall back to a normal system
//     notification (OS default sound/vibration) since there's no page
//     around to run Web Audio/Speech Synthesis.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Orders closing soon", body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      if (allClients.length > 0) {
        // Wake every open tab — whichever one is focused will actually
        // play sound (see the message listener added in order.$slug.tsx).
        for (const client of allClients) {
          client.postMessage({ type: "ORDERS_CLOSING_ALERT", payload: data });
        }
      }

      // Always also show a system notification as a fallback/backup, unless
      // a tab is currently focused and visible (then the in-page siren is
      // enough and a redundant OS notification would just be noise).
      const hasFocusedVisibleClient = allClients.some(
        (c) => c.focused && c.visibilityState === "visible",
      );
      if (!hasFocusedVisibleClient) {
        await self.registration.showNotification(data.title || "Orders closing soon", {
          body: data.body || "Get your order in before the cutoff.",
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          tag: "orders-closing",
          renotify: true,
          requireInteraction: false,
          vibrate: [300, 150, 300, 150, 300],
          data,
        });
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = allClients[0];
      if (existing) {
        existing.focus();
        existing.postMessage({ type: "ORDERS_CLOSING_ALERT", payload: data });
      } else if (data.url) {
        await self.clients.openWindow(data.url);
      }
    })(),
  );
});
