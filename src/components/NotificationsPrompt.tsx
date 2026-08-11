import { useEffect, useRef, useState } from "react";

// Same nag-and-snooze pattern as InstallPrompt.tsx: shows automatically on
// load instead of waiting for someone to spot the small "🔔 Get
// closing-time reminders" button, re-prompts a few times if dismissed, then
// stops. This still can't literally force the click on the browser's own
// "Allow" dialog — no website can, on any browser — but showing it
// unprompted, with context, gets meaningfully more people to actually
// enable it than a button they have to notice themselves.
const SNOOZE_UNTIL_KEY = "pb-notif-snooze-until";
const REMIND_COUNT_KEY = "pb-notif-remind-count";
const DISMISSED_KEY = "pb-notif-dismissed-forever";

const REMIND_AFTER_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REMINDS = 3;

type Props = {
  /** Already granted+subscribed — parent decides this, so it never shows redundantly. */
  alreadyEnabled: boolean;
  /** Attempts the actual subscribe flow (native "Allow" prompt included). Returns success. */
  onEnable: () => Promise<boolean>;
};

export function NotificationsPrompt({ alreadyEnabled, onEnable }: Props) {
  const [show, setShow] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function scheduleReminder() {
    clearTimer();
    const remindCount = Number(localStorage.getItem(REMIND_COUNT_KEY) ?? "0");
    if (remindCount >= MAX_REMINDS) return;
    const snoozeUntil = Date.now() + REMIND_AFTER_MS;
    try {
      localStorage.setItem(SNOOZE_UNTIL_KEY, String(snoozeUntil));
    } catch {}
    timerRef.current = setTimeout(() => setShow(true), REMIND_AFTER_MS);
  }

  useEffect(() => {
    if (typeof window === "undefined" || alreadyEnabled) return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);

    if (Notification.permission === "granted") return; // already allowed, just not subscribed yet — button covers this
    try {
      if (localStorage.getItem(DISMISSED_KEY) === "1") return;
    } catch {}

    const snoozeUntilRaw = localStorage.getItem(SNOOZE_UNTIL_KEY);
    const snoozeUntil = snoozeUntilRaw ? Number(snoozeUntilRaw) : 0;
    const now = Date.now();
    if (snoozeUntil && snoozeUntil > now) {
      timerRef.current = setTimeout(() => setShow(true), snoozeUntil - now);
    } else {
      // First-ever visit: give the page a moment to settle before
      // interrupting with a permission ask.
      timerRef.current = setTimeout(() => setShow(true), 2500);
    }
    return clearTimer;
  }, [alreadyEnabled]);

  async function handleEnable() {
    setBusy(true);
    try {
      const ok = await onEnable();
      setPermission(Notification.permission);
      if (ok) {
        setShow(false);
        clearTimer();
      } else if (Notification.permission === "denied") {
        // They hit "Allow" dialog's "Block" — can't re-prompt via JS at
        // all now, only show them how to fix it manually if they want to.
        setShow(true);
      } else {
        remindLater();
      }
    } finally {
      setBusy(false);
    }
  }

  function remindLater() {
    setShow(false);
    try {
      const remindCount = Number(localStorage.getItem(REMIND_COUNT_KEY) ?? "0");
      localStorage.setItem(REMIND_COUNT_KEY, String(remindCount + 1));
    } catch {}
    scheduleReminder();
  }

  function dismissForever() {
    setShow(false);
    clearTimer();
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {}
  }

  if (!show || permission === "unsupported" || alreadyEnabled) return null;

  const blocked = permission === "denied";

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notif-prompt-title"
    >
      <div className="bg-white rounded-3xl shadow-2xl border border-[#e8dcc8] w-full max-w-sm p-7 text-center animate-[fadeIn_0.2s_ease-out]">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white text-2xl shadow-md mx-auto mb-5">
          🔔
        </div>

        <h2 id="notif-prompt-title" className="text-xl font-bold text-[#2a1810] mb-2">
          {blocked ? "Reminders are blocked" : "Never miss the order cutoff"}
        </h2>
        <p className="text-sm text-[#6b5544] mb-6 leading-relaxed">
          {blocked
            ? "Notifications were blocked for this site earlier, so we can't ask again automatically. Turn them back on in your browser's site settings for this page."
            : "Get an alert with a loud siren if orders are about to close at 7:00 PM and you haven't ordered yet."}
        </p>

        <div className="flex flex-col gap-2.5">
          {!blocked && (
            <button
              onClick={handleEnable}
              disabled={busy}
              className="w-full bg-[#c8362b] hover:bg-[#a82a22] text-white font-bold py-3.5 rounded-xl transition disabled:opacity-60"
            >
              {busy ? "Enabling…" : "Enable closing reminders"}
            </button>
          )}
          <button
            onClick={blocked ? dismissForever : remindLater}
            className="w-full border-2 border-[#e8dcc8] text-[#8b6f4e] font-semibold py-3 rounded-xl hover:bg-[#fdf8f1] transition"
          >
            {blocked ? "Got it" : "Remind me later"}
          </button>
          {!blocked && (
            <button onClick={dismissForever} className="w-full text-[#8b6f4e] text-xs font-medium py-1 hover:underline">
              Don't ask again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
