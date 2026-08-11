// Client-side Web Push helpers for the "orders closing soon" reminders.
//
// This is intentionally separate from alertSound.ts: alertSound.ts is the
// sound itself, this file is the plumbing that gets a push message to the
// device in the first place (works even when the tab isn't open — with the
// caveat that a *closed* tab can only play the OS's default notification
// sound, since browsers don't let background pushes run custom audio; the
// real siren+voice only plays if the page is open, via the service worker
// message bridge in public/sw.js).

// Set in your deploy environment (Netlify env vars / .env). This is the
// PUBLIC VAPID key — safe to ship to the browser.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return navigator.serviceWorker.register("/sw.js");
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Requests notification permission (must be called from a click handler)
 * and subscribes this browser to push. Returns null if permission was
 * denied or push isn't supported.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  if (!VAPID_PUBLIC_KEY) {
    console.error("[push] Missing VITE_VAPID_PUBLIC_KEY — cannot subscribe.");
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const reg = await registerServiceWorker();
  if (!reg) return null;

  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;

  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
  });
}

export async function unsubscribeFromPush(): Promise<void> {
  const sub = await getExistingSubscription();
  if (sub) await sub.unsubscribe();
}

/** Shape sent to the server to store the subscription. */
export function subscriptionToKeys(sub: PushSubscription) {
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint as string,
    p256dh: json.keys?.p256dh as string,
    auth: json.keys?.auth as string,
  };
}
