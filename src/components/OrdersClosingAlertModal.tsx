import { useEffect } from "react";

type Props = {
  title: string;
  body: string;
  onOrderNow: () => void;
  onSnooze: () => void;
  onCancel: () => void;
};

/**
 * Full-screen popup shown alongside the siren + shouted-voice alert. The
 * sound alone doesn't tell someone what to actually do about it — this
 * gives them three clear choices, and taking any of them stops the sound
 * immediately (see stopAlert() calls in the handlers passed in).
 */
export function OrdersClosingAlertModal({ title, body, onOrderNow, onSnooze, onCancel }: Props) {
  // Let Escape act as "Cancel" — same as tapping the button.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="orders-closing-title"
    >
      <div className="bg-white rounded-3xl shadow-2xl border border-[#e8dcc8] w-full max-w-sm p-7 text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white text-3xl shadow-md mx-auto mb-5 animate-pulse">
          🚨
        </div>

        <h2 id="orders-closing-title" className="text-xl font-bold text-[#2a1810] mb-2">
          {title}
        </h2>
        <p className="text-sm text-[#6b5544] mb-6 leading-relaxed">{body}</p>

        <div className="flex flex-col gap-2.5">
          <button
            onClick={onOrderNow}
            className="w-full bg-[#c8362b] hover:bg-[#a82a22] text-white font-bold py-3.5 rounded-xl transition"
          >
            Order now
          </button>
          <button
            onClick={onSnooze}
            className="w-full border-2 border-[#e8dcc8] text-[#8b6f4e] font-semibold py-3 rounded-xl hover:bg-[#fdf8f1] transition"
          >
            Snooze 5 minutes
          </button>
          <button
            onClick={onCancel}
            className="w-full text-[#8b6f4e] text-sm font-medium py-2 hover:underline"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
