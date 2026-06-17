import { useEffect, useRef, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// We no longer permanently hide after one dismissal — instead we snooze and
// re-show after REMIND_AFTER_MS, up to MAX_REMINDS times, then stop.
const SNOOZE_UNTIL_KEY = "pb-install-snooze-until";
const REMIND_COUNT_KEY = "pb-install-remind-count";
const INSTALLED_KEY = "pb-install-installed";

const REMIND_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REMINDS = 3; // stop nagging after a few cycles

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [isIos, setIsIos] = useState(false);
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

    timerRef.current = setTimeout(() => {
      setShow(true);
    }, REMIND_AFTER_MS);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already installed — never show again.
    if (localStorage.getItem(INSTALLED_KEY) === "1") return;

    // Already running as an installed app (standalone)?
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // @ts-expect-error iOS Safari
      window.navigator.standalone === true;
    if (standalone) {
      try { localStorage.setItem(INSTALLED_KEY, "1"); } catch {}
      return;
    }

    const ua = window.navigator.userAgent.toLowerCase();
    const ios = /iphone|ipad|ipod/.test(ua) && !/crios|fxios/.test(ua);

    // If we're mid-snooze from a previous dismissal, pick up where we left off
    // instead of showing immediately.
    const snoozeUntilRaw = localStorage.getItem(SNOOZE_UNTIL_KEY);
    const snoozeUntil = snoozeUntilRaw ? Number(snoozeUntilRaw) : 0;
    const now = Date.now();

    if (ios) {
      setIsIos(true);
      if (snoozeUntil && snoozeUntil > now) {
        timerRef.current = setTimeout(() => setShow(true), snoozeUntil - now);
      } else {
        setShow(true);
      }
      return;
    }

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      if (snoozeUntil && snoozeUntil > now) {
        timerRef.current = setTimeout(() => setShow(true), snoozeUntil - now);
      } else {
        setShow(true);
      }
    };
    window.addEventListener("beforeinstallprompt", onBip);

    const onInstalled = () => {
      try {
        localStorage.setItem(INSTALLED_KEY, "1");
        localStorage.removeItem(SNOOZE_UNTIL_KEY);
        localStorage.removeItem(REMIND_COUNT_KEY);
      } catch {}
      setShow(false);
      clearTimer();
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
      clearTimer();
    };
  }, []);

  function remindLater() {
    setShow(false);
    try {
      const remindCount = Number(localStorage.getItem(REMIND_COUNT_KEY) ?? "0");
      localStorage.setItem(REMIND_COUNT_KEY, String(remindCount + 1));
    } catch {}
    scheduleReminder();
  }

  async function install() {
    if (!deferred) return;
    const result = await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") {
      try {
        localStorage.setItem(INSTALLED_KEY, "1");
        localStorage.removeItem(SNOOZE_UNTIL_KEY);
        localStorage.removeItem(REMIND_COUNT_KEY);
      } catch {}
      setShow(false);
      clearTimer();
    } else {
      // They explicitly declined the native prompt — treat like "remind later".
      remindLater();
    }
    return result;
  }

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-prompt-title"
    >
      <div className="bg-white rounded-3xl shadow-2xl border border-[#e8dcc8] w-full max-w-sm p-7 text-center animate-[fadeIn_0.2s_ease-out]">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-2xl shadow-md mx-auto mb-5">
          P
        </div>

        <h2 id="install-prompt-title" className="text-xl font-bold text-[#2a1810] mb-2">
          Add your order page to your Home Screen
        </h2>
        <p className="text-sm text-[#6b5544] mb-6 leading-relaxed">
          Get one-tap access to your personal Portugal Bakery order page — no need to dig
          up the link every time.
        </p>

        {isIos ? (
          <div className="bg-[#fdf8f1] border border-[#e8dcc8] rounded-2xl p-4 mb-5 text-left">
            <p className="text-sm font-semibold text-[#2a1810] mb-2">How to add it:</p>
            <ol className="text-sm text-[#6b5544] space-y-1.5 list-decimal list-inside">
              <li>
                Tap the <span className="font-semibold">Share</span> button{" "}
                <span aria-hidden="true">⬆️</span> in Safari
              </li>
              <li>
                Scroll down and tap{" "}
                <span className="font-semibold">"Add to Home Screen"</span>
              </li>
              <li>
                Tap <span className="font-semibold">Add</span> in the top right
              </li>
            </ol>
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5">
          {!isIos && deferred && (
            <button
              onClick={install}
              className="w-full bg-[#c8362b] hover:bg-[#a82a22] text-white font-bold py-3.5 rounded-xl transition"
            >
              Add to Home Screen
            </button>
          )}
          <button
            onClick={remindLater}
            className="w-full border-2 border-[#e8dcc8] text-[#8b6f4e] font-semibold py-3 rounded-xl hover:bg-[#fdf8f1] transition"
          >
            Remind me in 5 minutes
          </button>
        </div>
      </div>
    </div>
  );
}