import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "pb-install-dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;

    // Already installed (standalone)?
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // @ts-expect-error iOS Safari
      window.navigator.standalone === true;
    if (standalone) return;

    const ua = window.navigator.userAgent.toLowerCase();
    const ios = /iphone|ipad|ipod/.test(ua) && !/crios|fxios/.test(ua);
    if (ios) {
      setIsIos(true);
      setShow(true);
      return;
    }

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  function dismiss() {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    dismiss();
  }

  if (!show) return null;

  return (
    <div className="fixed bottom-3 left-3 right-3 z-[100] bg-white border border-[#e8dcc8] shadow-xl rounded-2xl p-4 flex items-start gap-3 max-w-md mx-auto">
      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold shrink-0">P</div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm">Install this app to your home screen</p>
        {isIos ? (
          <p className="text-xs text-[#6b5544] mt-1">
            Tap the Share button, then "Add to Home Screen".
          </p>
        ) : (
          <p className="text-xs text-[#6b5544] mt-1">
            Quick access for faster ordering.
          </p>
        )}
        <div className="flex gap-2 mt-2">
          {!isIos && (
            <button
              onClick={install}
              className="bg-[#c8362b] text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
            >
              Install
            </button>
          )}
          <button
            onClick={dismiss}
            className="text-xs text-[#8b6f4e] underline px-2 py-1.5"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
