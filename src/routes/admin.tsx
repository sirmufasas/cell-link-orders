import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { useSuspenseQuery, useQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line,
} from "recharts";
import {
  listCustomers, listProducts, listSubmissions, syncAllSheets, analyticsOverview, ensureSeeded,
  getSubmissionDetail, getEstimateProducts, saveEstimates, getProductStocks, saveProductStocks,
  getActiveSheetInfo, getDriverAssignments, saveCustomerDriver, exportOrdersForDate,
  autoSyncIfStale, getLiveSheetOrders, getPrintSheetForDate, adminSaveManualOrder, getHistoryRetentionInfo,
  clearOldOrderHistory, savePrintSheetState, type LiveSheetCustomerOrder,
} from "@/lib/bakery.functions";
import { primeAlertAudio, shoutAlert } from "@/lib/alertSound";

const customersQuery = queryOptions({ queryKey: ["customers"], queryFn: () => listCustomers() });
const productsQuery = queryOptions({ queryKey: ["products"], queryFn: () => listProducts() });
const submissionsQuery = queryOptions({ queryKey: ["submissions"], queryFn: () => listSubmissions({ data: {} }) });
const analyticsQuery = queryOptions({ queryKey: ["analytics"], queryFn: () => analyticsOverview() });
const sheetInfoQuery = queryOptions({ queryKey: ["sheet-info"], queryFn: () => getActiveSheetInfo() });
const historyRetentionQuery = queryOptions({
  queryKey: ["history-retention"],
  queryFn: () => getHistoryRetentionInfo(),
});
const liveSheetOrdersQuery = queryOptions({
  queryKey: ["live-sheet-orders"],
  queryFn: () => getLiveSheetOrders(),
  staleTime: 15_000,
});

// New-order sound alert preference. The actual siren + shouted-voice sound
// lives in src/lib/alertSound.ts, shared with the customer-facing
// "orders closing soon" reminders so both sound identical.
const SOUND_PREF_KEY = "adminSoundAlertsEnabled";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin · Portugal Bakery" }] }),
  loader: async ({ context }) => {
    // Auto-seed if empty — runs once, no-op afterwards
    try { await ensureSeeded(); } catch (_) {}
    // Self-healing background sync (throttled server-side, see
    // autoSyncIfStale / maybeAutoSync in bakery.functions.ts) — keeps the
    // dashboard current even if nobody remembered to hit "Re-sync".
    try { await autoSyncIfStale(); } catch (_) {}
    context.queryClient.ensureQueryData(customersQuery);
    context.queryClient.ensureQueryData(submissionsQuery);
    context.queryClient.ensureQueryData(analyticsQuery);
    context.queryClient.ensureQueryData(sheetInfoQuery);
  },
  errorComponent: ({ error }) => <div className="p-6 text-red-700">Failed: {error.message}</div>,
  notFoundComponent: () => <div className="p-6">Not found</div>,
  component: AdminPage,
});

type Bucket = "day" | "week" | "month";
type Dim = "items" | "products" | "customers";
type AdminTab = "customers" | "manual" | "print" | "history" | "analytics" | "estimates" | "stocks" | "drivers";

// ---------------------------------------------------------------------------
// Simple password gate
//
// Every admin tab except "Order History" requires this password before its
// content is shown. This is a lightweight, client-side gate (not real auth —
// there's no backend check), meant to keep casual visitors from poking at
// customer data, estimates, stocks, or driver assignments. Once entered
// correctly it stays unlocked for the rest of the browser tab's session
// (sessionStorage), so people don't have to re-type it every time they
// switch admin tabs, but a closed tab/browser will ask again.
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD = "portugalbakery";
const UNLOCK_STORAGE_KEY = "bakery_admin_unlocked";
const PROTECTED_TABS: AdminTab[] = ["customers", "manual", "print", "analytics", "estimates", "stocks", "drivers"];
const MANUAL_REGULARS_STORAGE_KEY = "bakery_manual_regulars_v1";
const PRINT_MODES_STORAGE_KEY = "bakery_print_customer_modes_v1";

function LockScreen({
  pwInput,
  setPwInput,
  pwError,
  onUnlock,
}: {
  pwInput: string;
  setPwInput: (v: string) => void;
  pwError: boolean;
  onUnlock: (e: React.FormEvent) => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-[#e8dcc8] shadow-sm p-8 max-w-sm mx-auto text-center space-y-4">
      <div className="w-12 h-12 mx-auto rounded-full bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center text-xl">
        🔒
      </div>
      <div>
        <h3 className="font-bold text-[#2a1810]">This section is locked</h3>
        <p className="text-xs text-[#8b6f4e] mt-1">Enter the admin password to continue.</p>
      </div>
      <form onSubmit={onUnlock} className="space-y-2">
        <input
          type="password"
          autoFocus
          value={pwInput}
          onChange={(e) => setPwInput(e.target.value)}
          placeholder="Password"
          className={`w-full bg-[#fdf8f1] border rounded-xl px-4 py-2.5 text-sm text-center focus:outline-none ${
            pwError ? "border-red-400" : "border-[#e8dcc8] focus:border-[#c8362b]"
          }`}
        />
        {pwError && <p className="text-xs text-red-600">Incorrect password, try again.</p>}
        <button
          type="submit"
          className="w-full bg-[#c8362b] hover:bg-[#a82a22] text-white font-bold py-2.5 rounded-xl transition text-sm"
        >
          Unlock
        </button>
      </form>
    </div>
  );
}

// Builds a YYYY-MM-DD key from a Date's *local* calendar fields. This is the
// piece that toISOString() gets wrong for this purpose — toISOString always
// converts to UTC first, so for anyone west/east of UTC at certain times of
// day it silently returns the previous/next calendar day. Since our data is
// keyed by real calendar dates (for_date), we build the string from local
// fields instead so the bucket always matches the actual date.
function toLocalISODate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function bucketKey(dateStr: string, bucket: Bucket) {
  const d = new Date(dateStr + "T00:00:00");
  if (bucket === "day") return dateStr;
  if (bucket === "month") return dateStr.slice(0, 7);
  // week: Monday start, computed and serialized entirely in local time so
  // the resulting key lines up with the real date the order was placed for.
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return toLocalISODate(d);
}

// Human-readable label for a bucket key, used consistently across day/week/
// month so all three render the same way on the chart (no raw ISO strings
// or raw "YYYY-MM" leaking into the axis/tooltip).
function bucketLabel(key: string, bucket: Bucket) {
  if (key.trim() === "" || key === "—") return key;
  if (bucket === "month") {
    const [y, m] = key.split("-").map(Number);
    if (!y || !m) return key;
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  const d = new Date(key + "T00:00:00");
  if (Number.isNaN(d.getTime())) return key;
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return bucket === "week" ? `Week of ${day}` : day;
}

function dateLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function orderTypeTag(type?: string | null) {
  switch (type) {
    case "changed":
      return { label: "Changed Order", className: "bg-amber-100 text-amber-800" };
    case "added":
      return { label: "Added Order", className: "bg-blue-100 text-blue-800" };
    case "late":
      return { label: "Late Order", className: "bg-red-100 text-red-800" };
    default:
      return { label: "New Order", className: "bg-green-100 text-green-800" };
  }
}

function parseOrderMessage(raw?: string | null): { senderName: string; comment: string } {
  const text = (raw ?? "").trim();
  if (!text) return { senderName: "", comment: "" };
  const idx = text.indexOf(":");
  if (idx === -1) return { senderName: text, comment: "" };
  return {
    senderName: text.slice(0, idx).trim(),
    comment: text.slice(idx + 1).trim(),
  };
}

// Decodes a base64 string (as returned by exportOrdersForDate) into a Blob
// with the correct .xlsx MIME type, ready to hand to the browser as a
// download.
function base64ToXlsxBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ---------------------------------------------------------------------------
// Shared: sheet-context awareness
//
// Estimates, Stocks, and Drivers all read/write live rows on whichever sheet
// is currently "active" (e.g. a Mon–Wed sheet vs a Thu–Sat sheet). Because
// each sheet has its own independent set of rows, someone can easily forget
// which sheet they're looking at, or worry that switching sheets wiped out
// what they just entered.
//
// `useSheetContext` remembers (in localStorage, per tab) the label of the
// sheet that was last acknowledged. Every time the tab is opened it shows a
// small "you're working on X" notice. If the active sheet's label differs
// from what was last seen, it instead shows a "the sheet changed — carry
// over the same values?" prompt. Nothing is ever deleted; carrying over just
// re-saves the previous values onto the new sheet's rows.
// ---------------------------------------------------------------------------

type SheetNotice = { show: boolean; changed: boolean; fromLabel?: string; toLabel?: string };

// Tracks which storageKeys have already shown their popup during THIS page
// load. This lives at module scope (not component state) so switching
// between admin tabs — which remounts the tab components — doesn't cause
// the popup to reappear each time. A hard refresh reloads the module and
// resets this set, which is exactly when the popup should be eligible to
// show again.
const shownThisPageLoad = new Set<string>();

function useSheetContext(label: string | undefined, storageKey: string) {
  const [notice, setNotice] = useState<SheetNotice>({ show: false, changed: false });
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!label || checked) return;
    setChecked(true);
    if (shownThisPageLoad.has(storageKey)) return; // already shown this page load
    shownThisPageLoad.add(storageKey);

    const stored = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
    if (stored && stored !== label) {
      setNotice({ show: true, changed: true, fromLabel: stored, toLabel: label });
    } else {
      setNotice({ show: true, changed: false, toLabel: label });
    }
    // Only re-check if the label itself changes (e.g. sheet rolled over
    // while the tab was open); `checked` guards the initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  function acknowledge() {
    if (label) localStorage.setItem(storageKey, label);
    setNotice((n) => ({ ...n, show: false }));
  }

  return { notice, acknowledge };
}

function SheetContextModal({
  notice,
  onAcknowledge,
  onCarryOver,
  itemLabel = "values",
  tabName,
}: {
  notice: SheetNotice;
  onAcknowledge: () => void;
  onCarryOver?: (useSame: boolean) => void;
  itemLabel?: string;
  tabName: string;
}) {
  if (!notice.show) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-sm w-full shadow-xl p-5 space-y-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-[#c8362b]">{tabName} tab</div>
        {notice.changed ? (
          <>
            <h3 className="font-bold text-[#2a1810]">Sheet changed</h3>
            <p className="text-sm text-[#6b5544]">
              You were working on the <span className="font-semibold">{notice.fromLabel}</span> sheet — you're now on{" "}
              <span className="font-semibold">{notice.toLabel}</span>. Each sheet keeps its own {itemLabel}, so nothing from before was removed.
            </p>
            <p className="text-sm text-[#6b5544]">Carry over the same {itemLabel} to this sheet?</p>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { onAcknowledge(); onCarryOver?.(false); }}
                className="flex-1 px-3 py-2 rounded-lg border border-[#e8dcc8] text-sm font-semibold hover:bg-[#fdf8f1]"
              >
                No, I'll enter new
              </button>
              <button
                onClick={() => { onAcknowledge(); onCarryOver?.(true); }}
                className="flex-1 px-3 py-2 rounded-lg bg-[#c8362b] text-white text-sm font-semibold hover:bg-[#a82a22]"
              >
                Yes, use same
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="font-bold text-[#2a1810]">Working on: {notice.toLabel}</h3>
            <p className="text-sm text-[#6b5544]">
              Heads up — this data belongs to the <span className="font-semibold">{notice.toLabel}</span> sheet. Other day-ranges keep their own separate data.
            </p>
            <button
              onClick={onAcknowledge}
              className="w-full px-3 py-2 rounded-lg bg-[#c8362b] text-white text-sm font-semibold hover:bg-[#a82a22]"
            >
              Got it
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Generic centered loading overlay, used for every save action.
function CenterLoader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-xl px-8 py-7 flex flex-col items-center gap-4 max-w-xs w-full text-center">
        <svg
          className="animate-spin w-9 h-9 text-[#c8362b]"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-4a6 6 0 0 0-6-6V2z" />
        </svg>
        <div>
          <p className="font-bold text-[#2a1810]">{title}</p>
          {subtitle && <p className="text-xs text-[#8b6f4e] mt-1">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

function AdminPage() {
  const qc = useQueryClient();
  const { data: customers } = useSuspenseQuery(customersQuery);
  const { data: submissions } = useSuspenseQuery(submissionsQuery);
  const { data: analytics } = useSuspenseQuery(analyticsQuery);
  const { data: sheetInfo } = useQuery(sheetInfoQuery);

  const [tab, setTabState] = useState<AdminTab>(() => {
    if (typeof window === "undefined") return "customers";
    const saved = sessionStorage.getItem("bakery_admin_active_tab") as AdminTab | null;
    if (saved && ["customers", "manual", "print", "history", "analytics", "estimates", "stocks", "drivers"].includes(saved)) {
      return saved;
    }
    return "customers";
  });

  function setTab(nextTab: AdminTab) {
    setTabState(nextTab);
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem("bakery_admin_active_tab", nextTab);
      } catch {}
    }
  }
  const [search, setSearch] = useState("");
  const [customerDriverFilter, setCustomerDriverFilter] = useState("__all__");
  const [customerStatusFilter, setCustomerStatusFilter] = useState<"all" | "ordered" | "pending" | "pinned">("all");
  const [manualSelectedSlug, setManualSelectedSlug] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>("all");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [dim, setDim] = useState<Dim>("items");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getSubmissionDetail>> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const { data: liveSheetData } = useQuery(liveSheetOrdersQuery);
  const { data: retentionInfo } = useQuery(historyRetentionQuery);
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearHistoryFeedback, setClearHistoryFeedback] = useState<string | null>(null);
  const [dismissedExpiryPrompt, setDismissedExpiryPrompt] = useState(false);

  // Automatically notify the admin with a confirmation dialog if orders older
  // than 3 months are waiting to be cleared.
  useEffect(() => {
    if ((retentionInfo?.expiredCount ?? 0) > 0 && !dismissedExpiryPrompt) {
      setShowClearHistoryModal(true);
    }
  }, [retentionInfo?.expiredCount, dismissedExpiryPrompt]);

  async function handleConfirmClearOldHistory() {
    setClearingHistory(true);
    setClearHistoryFeedback(null);
    try {
      const res = await clearOldOrderHistory();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["submissions"] }),
        qc.invalidateQueries({ queryKey: ["history-retention"] }),
      ]);
      setShowClearHistoryModal(false);
      setDismissedExpiryPrompt(true);
      setClearHistoryFeedback(
        res.deletedCount > 0
          ? `✓ Cleared ${res.deletedCount} order${res.deletedCount === 1 ? "" : "s"} older than 3 months (before ${res.cutoffDateISO}).`
          : `No orders older than 3 months (before ${res.cutoffDateISO}) to clear.`,
      );
      setTimeout(() => setClearHistoryFeedback(null), 6000);
    } catch (e) {
      setClearHistoryFeedback(`Error: ${(e as Error).message}`);
    } finally {
      setClearingHistory(false);
    }
  }

  // Pinned "Manual Regulars" customers stored in localStorage so Admin can
  // star the customers they always enter manually.
  const [manualRegulars, setManualRegulars] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(MANUAL_REGULARS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  function toggleManualRegular(slug: string) {
    setManualRegulars((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      try {
        localStorage.setItem(MANUAL_REGULARS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function copyCustomerLink(slug: string) {
    const url = `${window.location.origin}/order/${slug}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug((cur) => (cur === slug ? null : cur)), 2000);
    });
  }

  // --- Order History export (download button) ---
  const [exportDate, setExportDate] = useState(() => toLocalISODate(new Date()));
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Password gate state — unlocked once per browser tab session.
  const [unlocked, setUnlocked] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(UNLOCK_STORAGE_KEY) === "true";
  });
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState(false);

  // --- New-order sound alert ---
  const [soundEnabled, setSoundEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(SOUND_PREF_KEY);
    return stored === null ? true : stored === "true";
  });
  const lastSeenSubmissionIdRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  function toggleSound() {
    setSoundEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(SOUND_PREF_KEY, String(next));
      return next;
    });
  }

  // Browsers block all audio — the siren tone and speech alike — until the
  // user has interacted with the page at least once. Any click anywhere —
  // unlocking, switching tabs, re-syncing — creates/resumes the AudioContext
  // and touches the speech API once, so both are ready by the time a real
  // alert needs to fire. Chrome in particular loads its voice list
  // asynchronously, so also listen for "voiceschanged".
  useEffect(() => {
    function primeAlerts() {
      primeAlertAudio(audioCtxRef);
    }
    primeAlerts();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", primeAlerts);
    }
    document.addEventListener("click", primeAlerts);
    return () => {
      if ("speechSynthesis" in window) {
        window.speechSynthesis.removeEventListener("voiceschanged", primeAlerts);
      }
      document.removeEventListener("click", primeAlerts);
    };
  }, []);

  // Known Chrome bug: speechSynthesis silently stops working after the
  // engine has been idle for ~15 seconds (this gets worse if the tab isn't
  // focused) and never recovers on its own — this is almost certainly why
  // an alert works once and then goes silent later. The standard workaround
  // is to "tap" pause/resume periodically so Chrome's engine never goes
  // idle long enough to lock up.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const t = setInterval(() => {
      // Deliberately unconditional — the Chrome bug happens specifically
      // during idle gaps, so gating this on "is currently speaking" would
      // skip the exact moments it's needed. Pause+resume on an idle queue
      // is a harmless no-op.
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 10000);
    return () => clearInterval(t);
  }, []);

  // If the browser tab was backgrounded, timers (including the 30s
  // auto-refresh below) can get throttled or paused, so a new order might
  // not show up until well after it actually came in. Force an immediate
  // refetch as soon as the tab becomes visible again to catch up right away.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        qc.invalidateQueries({ queryKey: ["submissions"] });
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [qc]);

  // Fires whenever the submissions list changes (including the 30s
  // auto-refresh below). The list is sorted newest-first, so if the newest
  // id isn't the one we saw last time, a new order has come in. Late orders
  // (order_type "late") shout "LATE ORDER" instead of "NEW ORDER".
  useEffect(() => {
    const newest = submissions[0];
    const newestId = newest?.id ?? null;
    if (lastSeenSubmissionIdRef.current === null) {
      // First load — just record where we are, don't alert retroactively.
      lastSeenSubmissionIdRef.current = newestId;
      return;
    }
    if (newestId && newestId !== lastSeenSubmissionIdRef.current) {
      lastSeenSubmissionIdRef.current = newestId;
      if (soundEnabled) {
        const phrase =
          newest?.order_type === "added"
            ? "ADDED ORDER"
            : newest?.order_type === "changed"
              ? "CHANGED ORDER"
              : newest?.order_type === "late"
                ? "LATE ORDER"
                : "NEW ORDER";
        shoutAlert(phrase, audioCtxRef.current);
      }
    }
  }, [submissions, soundEnabled]);

  function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (pwInput === ADMIN_PASSWORD) {
      setUnlocked(true);
      sessionStorage.setItem(UNLOCK_STORAGE_KEY, "true");
      setPwInput("");
      setPwError(false);
    } else {
      setPwError(true);
    }
  }

  const needsPassword = PROTECTED_TABS.includes(tab) && !unlocked;

  async function openDetail(id: string) {
    setDetailId(id); setDetail(null); setDetailLoading(true);
    try {
      const d = await getSubmissionDetail({ data: { id } });
      setDetail(d);
    } finally {
      setDetailLoading(false);
    }
  }

  // Downloads a real, styled .xlsx of every order placed FOR `exportDate` —
  // one row per product ordered (Customer, Product, Quantity, Driver,
  // Comments), colored to match the live Google Sheet's look (header band
  // + a light color per customer). The file itself is built server-side in
  // exportOrdersForDate (via ExcelJS) and handed back as base64; this just
  // decodes it into a Blob and triggers the browser download. Only ordered
  // items ever reach order_submission_items (see
  // submitOrder/addOnToOrder/changeOrder — all filter to positive-quantity
  // items before inserting), so there's nothing to filter out here: every
  // row in the file is something that was actually ordered.
  async function handleExportOrders() {
    setExporting(true); setExportError(null);
    try {
      const { forDate, rows, fileBase64 } = await exportOrdersForDate({ data: { forDate: exportDate } });
      if (!rows.length || !fileBase64) {
        setExportError(`No orders found for ${forDate}.`);
        return;
      }
      const blob = base64ToXlsxBlob(fileBase64);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `orders_${forDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  // Auto-refresh data every 30s so the dashboard stays live
  useEffect(() => {
    const t = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["submissions"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    }, 30000);
    return () => clearInterval(t);
  }, [qc]);

  const sheetQtyBySlug = useMemo(() => {
    const m = new Map<string, number>();
    for (const sc of liveSheetData?.customers ?? []) {
      m.set(sc.slug, sc.totalQuantity);
    }
    return m;
  }, [liveSheetData]);

  const customerDriverOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of customers) {
      if (c.driver?.trim()) set.add(c.driver.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [customers]);

  const filteredCustomers = useMemo(() => {
    const s = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (s && !c.name.toLowerCase().includes(s) && !(c.driver ?? "").toLowerCase().includes(s)) {
        return false;
      }
      if (customerDriverFilter !== "__all__" && (c.driver ?? "") !== customerDriverFilter) {
        return false;
      }
      const onSheetQty = sheetQtyBySlug.get(c.slug) ?? 0;
      if (customerStatusFilter === "ordered" && onSheetQty <= 0) return false;
      if (customerStatusFilter === "pending" && onSheetQty > 0) return false;
      if (customerStatusFilter === "pinned" && !manualRegulars.includes(c.slug)) return false;
      return true;
    });
  }, [search, customers, customerDriverFilter, customerStatusFilter, sheetQtyBySlug, manualRegulars]);

  // Group submissions by created_at date (local) — same grouping as the
  // customer-facing HistoryModal, just across all customers.
  const historyGroups = useMemo(() => {
    const s = historySearch.trim().toLowerCase();
    const m = new Map<string, typeof submissions>();
    for (const sub of submissions) {
      if (s) {
        const cName = (sub.customer?.name ?? "").toLowerCase();
        const msg = (sub.message ?? "").toLowerCase();
        if (!cName.includes(s) && !msg.includes(s)) continue;
      }
      if (historyTypeFilter !== "all") {
        const t = sub.order_type ?? "new";
        if (t !== historyTypeFilter) continue;
      }
      const key = new Date(sub.created_at).toISOString().slice(0, 10);
      const arr = m.get(key) ?? [];
      arr.push(sub);
      m.set(key, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [submissions, historySearch, historyTypeFilter]);

  async function handleSync() {
    setSyncing(true); setSyncMsg(null);
    try {
      // Sync BOTH spreadsheets — the button isn't tied to an edit on one
      // specific sheet, and each sync only touches its own sheet's data.
      const r = await syncAllSheets();
      setSyncMsg(
        `Synced ${r.monWed.customers} customers / ${r.monWed.mappings} rows (Mon–Wed) and ${r.thuSat.customers} customers / ${r.thuSat.mappings} rows (Thu–Sat).`,
      );
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    } catch (e) {
      setSyncMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  // Build time-series chart data based on bucket + dimension. This is the
  // real per-order data (analytics), grouped by real calendar dates via
  // bucketKey — day/week/month all go through the exact same aggregation
  // and rendering path below, they just group by a different-sized bucket.
  const timeSeries = useMemo(() => {
    if (dim === "items") {
      const m = new Map<string, number>();
      for (const s of analytics) {
        const k = bucketKey(s.for_date, bucket);
        m.set(k, (m.get(k) ?? 0) + (s.total_items ?? 0));
      }
      const arr = Array.from(m.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value }));
      // Pad empty state so chart still renders
      if (arr.length === 0) return [{ key: "—", value: 0 }, { key: " ", value: 0 }];
      return arr;
    }
    return [];
  }, [analytics, bucket, dim]);

  const topProducts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of analytics) {
      for (const it of (s.items ?? [])) {
        m.set(it.product_name, (m.get(it.product_name) ?? 0) + it.quantity);
      }
    }
    const arr = Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, qty]) => ({ name: name.length > 18 ? name.slice(0, 18) + "…" : name, qty }));
    if (arr.length === 0) return [{ name: "No data yet", qty: 0 }];
    return arr;
  }, [analytics]);

  const topCustomers = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of analytics) {
      const n = s.customer?.name ?? "—";
      m.set(n, (m.get(n) ?? 0) + (s.total_items ?? 0));
    }
    const arr = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, qty]) => ({ name: name.length > 16 ? name.slice(0, 16) + "…" : name, qty }));
    if (arr.length === 0) return [{ name: "No data yet", qty: 0 }];
    return arr;
  }, [analytics]);

  const activeOnSheetCount = useMemo(
    () => (liveSheetData?.customers ?? []).filter((c) => c.totalQuantity > 0).length,
    [liveSheetData],
  );
  const totalItemsOnSheet = useMemo(
    () => (liveSheetData?.customers ?? []).reduce((a, b) => a + b.totalQuantity, 0),
    [liveSheetData],
  );

  return (
    <div className="min-h-screen bg-[#fdf8f1] text-[#2a1810]">
      <header className="bg-white border-b border-[#e8dcc8] print:hidden">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-sm px-3 py-2 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]" aria-label="Back to home">
              ← Back
            </Link>
            <Link to="/" className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-lg shadow-sm">P</div>
              <div>
                <h1 className="font-bold text-lg leading-none">Portugal Bakery</h1>
                <p className="text-xs text-[#8b6f4e]">Admin Dashboard</p>
              </div>
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={toggleSound}
              className={`text-sm px-3 py-2 rounded-lg border font-semibold ${
                soundEnabled
                  ? "border-[#2a1810] bg-[#2a1810] text-white"
                  : "border-[#e8dcc8] text-[#8b6f4e] hover:bg-[#fdf8f1]"
              }`}
              title={soundEnabled ? "New-order sound alerts are ON — click to mute" : "New-order sound alerts are OFF — click to unmute"}
            >
              {soundEnabled ? "🔊 Alerts On" : "🔇 Alerts Off"}
            </button>
            <button
              onClick={() => shoutAlert("NEW ORDER", audioCtxRef.current)}
              className="text-sm px-3 py-2 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
              title="Play the alert now, without waiting for a real order"
            >
              🔔 Test Alert
            </button>
            <a
              href={sheetInfo?.url ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="text-sm px-3 py-2 rounded-lg bg-green-700 text-white font-semibold hover:bg-green-800"
            >
              📊 {sheetInfo?.label ?? "…"} Sheet
            </a>
            <button onClick={handleSync} disabled={syncing}
              className="text-sm px-3 py-2 rounded-lg border border-[#2a1810] hover:bg-[#2a1810] hover:text-white disabled:opacity-50">
              {syncing ? "Syncing…" : "↻ Re-sync"}
            </button>
            {unlocked && (
              <button
                onClick={() => {
                  setUnlocked(false);
                  sessionStorage.removeItem(UNLOCK_STORAGE_KEY);
                }}
                className="text-sm px-3 py-2 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
                title="Lock protected tabs again"
              >
                🔒 Lock
              </button>
            )}
          </div>
        </div>
        {syncMsg && (
          <div className="max-w-6xl mx-auto px-6 pb-3 text-sm text-[#6b5544]">{syncMsg}</div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6 print:max-w-none print:p-0 print:space-y-0">
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 print:hidden">
          {[
            { label: "Customers", value: customers.length },
            {
              label: "On Sheet Today",
              value: liveSheetData
                ? `${activeOnSheetCount} (${totalItemsOnSheet.toLocaleString()} items)`
                : "Loading…",
            },
            { label: "Orders Logged", value: submissions.length },
            { label: "Active Sheet", value: sheetInfo ? `✓ ${sheetInfo.label}` : "✓ Connected" },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-2xl border border-[#e8dcc8] p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wider text-[#8b6f4e] font-semibold">{s.label}</div>
              <div className="text-xl font-bold mt-1 truncate">{s.value}</div>
            </div>
          ))}
        </section>

        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1 w-fit flex-wrap print:hidden">
          {(["customers", "manual", "print", "history", "analytics", "estimates", "stocks", "drivers"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition ${
                tab === t ? "bg-[#c8362b] text-white" : "text-[#6b5544] hover:bg-[#fdf8f1]"
              }`}
            >
              {t === "customers"
                ? "Customers"
                : t === "manual"
                ? "⚡ Manual Orders"
                : t === "print"
                ? "🖨️ Print Sheet"
                : t === "history"
                ? "Order History"
                : t === "analytics"
                ? "Analytics"
                : t === "estimates"
                ? "Estimates"
                : t === "stocks"
                ? "Stocks"
                : "Drivers"}
              {PROTECTED_TABS.includes(t) && !unlocked ? " 🔒" : ""}
            </button>
          ))}
        </div>

        {needsPassword ? (
          <div className="py-10 print:hidden">
            <LockScreen pwInput={pwInput} setPwInput={setPwInput} pwError={pwError} onUnlock={handleUnlock} />
          </div>
        ) : (
        <>
        {tab === "customers" && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search customers by name or driver…"
                  className="w-full bg-white border border-[#e8dcc8] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#c8362b]"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8b6f4e] hover:text-[#2a1810] text-lg leading-none"
                    title="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1 flex-wrap">
                {([
                  { id: "all", label: `All (${customers.length})` },
                  { id: "pinned", label: `★ Manual (${manualRegulars.length})` },
                  { id: "ordered", label: `🟢 On Sheet (${activeOnSheetCount})` },
                  { id: "pending", label: `⚪ Not Ordered` },
                ] as const).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setCustomerStatusFilter(f.id)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                      customerStatusFilter === f.id ? "bg-[#c8362b] text-white" : "text-[#6b5544] hover:bg-[#fdf8f1]"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <select
                value={customerDriverFilter}
                onChange={(e) => setCustomerDriverFilter(e.target.value)}
                className="bg-white border border-[#e8dcc8] rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:border-[#c8362b]"
              >
                <option value="__all__">All drivers</option>
                {customerDriverOptions.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>

            <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
              {filteredCustomers.length === 0 && (
                <div className="p-6 text-center text-sm text-[#8b6f4e]">No customers match your filter.</div>
              )}
              {filteredCustomers.map((c) => {
                const onSheetQty = sheetQtyBySlug.get(c.slug) ?? 0;
                const isPinned = manualRegulars.includes(c.slug);
                return (
                  <div key={c.id} className="p-3 flex flex-wrap items-center justify-between gap-3 hover:bg-[#fdf8f1]">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <button
                        onClick={() => toggleManualRegular(c.slug)}
                        title={isPinned ? "Pinned in Manual Orders — click to unpin" : "Pin to Manual Regulars"}
                        className={`text-lg leading-none transition ${
                          isPinned ? "text-amber-500" : "text-[#d5c5ae] hover:text-amber-400"
                        }`}
                      >
                        ★
                      </button>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold truncate">{c.name}</span>
                          {onSheetQty > 0 ? (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                              🟢 {onSheetQty} on sheet
                            </span>
                          ) : (
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] text-[#8b6f4e]">
                              0 on sheet
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[#8b6f4e] truncate">
                          /order/{c.slug}{c.driver ? ` · ${c.driver}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => {
                          setManualSelectedSlug(c.slug);
                          setTab("manual");
                        }}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#c8362b]/10 text-[#c8362b] hover:bg-[#c8362b] hover:text-white transition"
                        title="Enter or edit order in Manual Orders"
                      >
                        ⚡ Manual Order
                      </button>
                      <button
                        onClick={() => copyCustomerLink(c.slug)}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#e8dcc8] hover:bg-white transition"
                        title="Copy customer order link"
                      >
                        {copiedSlug === c.slug ? "✓ Copied!" : "📋 Copy Link"}
                      </button>
                      <Link
                        to="/order/$slug"
                        params={{ slug: c.slug }}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#e8dcc8] hover:bg-white"
                      >
                        Open
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {tab === "manual" && (
          <ManualOrdersTab
            selectedSlug={manualSelectedSlug}
            onSelectSlug={setManualSelectedSlug}
            manualRegulars={manualRegulars}
            onToggleManualRegular={toggleManualRegular}
            onCopyLink={copyCustomerLink}
            copiedSlug={copiedSlug}
          />
        )}

        {tab === "print" && <PrintSheetTab />}

        {tab === "history" && (
          <section className="space-y-4">
            {/* 3-Month Order History Retention & Notification Banner */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl px-4 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-[#2a1810]">
                <span className="font-bold text-[#c8362b]">📅 3-Month Order History</span>
                <span className="text-[#8b6f4e]">·</span>
                <span>
                  Showing <strong>{submissions.length}</strong> orders from the last 3 months
                  {retentionInfo?.oldestCreatedAt
                    ? ` (since ${new Date(retentionInfo.oldestCreatedAt).toLocaleDateString()})`
                    : ""}
                </span>
                {retentionInfo?.nextClearDateISO && (
                  <>
                    <span className="text-[#8b6f4e]">·</span>
                    <span className="text-[#6b5544]">
                      Next 3-month mark: <strong>{retentionInfo.nextClearDateISO}</strong> (system will notify you before clearing)
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(retentionInfo?.expiredCount ?? 0) > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold">
                    ⚠️ {retentionInfo?.expiredCount} order{retentionInfo?.expiredCount === 1 ? "" : "s"} &gt; 3 months old
                  </span>
                )}
                {clearHistoryFeedback && (
                  <span className="text-green-700 font-semibold">{clearHistoryFeedback}</span>
                )}
                <button
                  onClick={() => setShowClearHistoryModal(true)}
                  className="px-2.5 py-1 rounded-lg border border-[#e8dcc8] bg-white hover:bg-[#f5ede0] text-[#6b5544] font-semibold transition-colors"
                >
                  🧹 Clear &gt;3 Months Old
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[#e8dcc8] rounded-xl p-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs font-semibold text-[#6b5544]">Download orders for:</label>
                <input
                  type="date"
                  value={exportDate}
                  onChange={(e) => setExportDate(e.target.value)}
                  className="border border-[#e8dcc8] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#c8362b]"
                />
                <button
                  onClick={handleExportOrders}
                  disabled={exporting}
                  className="text-sm px-3 py-1.5 rounded-lg bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold"
                >
                  {exporting ? "Preparing…" : "⬇ Download"}
                </button>
                {exportError && <span className="text-xs text-red-600">{exportError}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px] justify-end">
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search customer, person name, or comment…"
                  className="border border-[#e8dcc8] rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#c8362b] min-w-[220px]"
                />
                <select
                  value={historyTypeFilter}
                  onChange={(e) => setHistoryTypeFilter(e.target.value)}
                  className="border border-[#e8dcc8] rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-white focus:outline-none focus:border-[#c8362b]"
                >
                  <option value="all">All types</option>
                  <option value="new">New Order</option>
                  <option value="added">Added Order</option>
                  <option value="changed">Changed Order</option>
                  <option value="late">Late Order</option>
                </select>
              </div>
            </div>

            {historyGroups.length === 0 && (
              <div className="bg-white rounded-2xl border border-[#e8dcc8] p-6 text-center text-sm text-[#8b6f4e] shadow-sm">
                No orders match your filter.
              </div>
            )}
            {historyGroups.map(([day, subs]) => (
              <div key={day}>
                <h4 className="font-bold text-sm text-[#2a1810] mb-2">{dateLabel(day)}</h4>
                <div className="space-y-3">
                  {subs.map((s) => {
                    const tag = orderTypeTag(s.order_type);
                    const { senderName, comment } = parseOrderMessage(s.message);
                    return (
                      <button
                        key={s.id}
                        onClick={() => openDetail(s.id)}
                        className="w-full text-left border border-[#e8dcc8] bg-white rounded-xl p-3 shadow-sm hover:bg-[#fdf8f1] transition-colors"
                      >
                        <div className="flex items-center justify-between mb-1.5 gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-bold text-sm text-[#2a1810] truncate">{s.customer?.name ?? "—"}</span>
                            {senderName && (
                              <span className="text-xs px-2 py-0.5 rounded-md bg-[#f5ede0] text-[#5c4433] font-semibold shrink-0">
                                👤 {senderName}
                              </span>
                            )}
                          </div>
                          <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${tag.className}`}>
                            {tag.label}
                          </span>
                        </div>
                        {comment && (
                          <div className="mb-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-[#2a1810]">
                            <span className="font-bold text-amber-900">💬 Comment:</span>{" "}
                            <span className="font-medium">{comment}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-xs text-[#8b6f4e]">
                          <span>
                            For {s.for_date} · {s.total_items} items · {new Date(s.created_at).toLocaleString()}
                          </span>
                          <span className="text-[#c8362b] font-semibold shrink-0">View order →</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        )}

        {tab === "analytics" && (
          <section className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1">
                {(["day", "week", "month"] as const).map((b) => (
                  <button key={b} onClick={() => setBucket(b)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold ${bucket === b ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}>
                    {b === "day" ? "Days" : b === "week" ? "Weeks" : "Months"}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1">
                {(["items", "products", "customers"] as const).map((d) => (
                  <button key={d} onClick={() => setDim(d)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold ${dim === d ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}>
                    {d === "items" ? "Items over time" : d === "products" ? "Top products" : "Top customers"}
                  </button>
                ))}
              </div>
            </div>

            <ChartCard title={
              dim === "items" ? `Items per ${bucket}` : dim === "products" ? "Top 10 products (all time)" : "Top 10 customers (all time)"
            }>
              <ResponsiveContainer width="100%" height={300}>
                {dim === "items" ? (
                  <LineChart data={timeSeries}>
                    <CartesianGrid stroke="#e8dcc8" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="key"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(k: string) => bucketLabel(k, bucket)}
                    />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} domain={[0, "auto"]} />
                    <Tooltip labelFormatter={(k: string) => bucketLabel(k, bucket)} />
                    <Line type="monotone" dataKey="value" stroke="#c8362b" strokeWidth={2} dot />
                  </LineChart>
                ) : (
                  <BarChart data={dim === "products" ? topProducts : topCustomers}>
                    <CartesianGrid stroke="#e8dcc8" strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={70} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} domain={[0, "auto"]} />
                    <Tooltip />
                    <Bar dataKey="qty" fill="#c8362b" />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </ChartCard>

            {analytics.length === 0 && (
              <p className="text-center text-xs text-[#8b6f4e]">
                No orders yet — charts will update automatically as orders come in.
              </p>
            )}
          </section>
        )}

        {tab === "estimates" && <EstimatesTab />}
        {tab === "stocks" && <StocksTab />}
        {tab === "drivers" && <DriversTab />}
        </>
        )}
      </main>

      {detailId && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setDetailId(null)}>
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[85vh] overflow-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[#e8dcc8] sticky top-0 bg-white">
              <h3 className="font-bold text-[#2a1810]">Order details</h3>
              <button onClick={() => setDetailId(null)} className="text-2xl leading-none text-[#8b6f4e]">×</button>
            </div>
            <div className="p-4 space-y-3">
              {detailLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
              {detail && (() => {
                const tag = orderTypeTag((detail as any).order_type);
                const { senderName, comment } = parseOrderMessage((detail as any).message);
                return (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-base text-[#2a1810]">{detail.customer?.name ?? "—"}</div>
                        <div className="text-xs text-[#8b6f4e] mt-0.5">
                          For {detail.for_date} · {detail.total_items} items · {new Date(detail.created_at).toLocaleString()}
                        </div>
                      </div>
                      <span className={`text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full shrink-0 ${tag.className}`}>
                        {tag.label}
                      </span>
                    </div>

                    {/* Customer Name & Comment Box */}
                    <div className="rounded-xl border border-[#e8dcc8] bg-[#fdf8f1] p-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#6b5544]">👤 Placed by (Customer Name):</span>
                        <span className="font-bold text-[#2a1810] text-sm">{senderName || "—"}</span>
                      </div>
                      <div className="border-t border-[#e8dcc8] pt-2">
                        <div className="font-semibold text-[#6b5544] mb-1">💬 Customer Comment / Note:</div>
                        {comment ? (
                          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm font-semibold text-[#2a1810]">
                            {comment}
                          </div>
                        ) : (
                          <div className="text-xs italic text-[#8b6f4e]">No comment left on this order.</div>
                        )}
                      </div>
                    </div>

                    <ul className="text-sm divide-y divide-[#e8dcc8] border border-[#e8dcc8] rounded-xl">
                      {detail.items.map((it, i) => (
                        <li key={i} className="flex justify-between px-3 py-2">
                          <span>{it.product_name}</span>
                          <span className="font-semibold">{it.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {showClearHistoryModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowClearHistoryModal(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5 shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">🔔</span>
                <div>
                  <h3 className="font-bold text-[#2a1810] text-base">3-Month Order History Notice</h3>
                  <p className="text-xs text-[#8b6f4e]">Confirmation required before clearing old history</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowClearHistoryModal(false);
                  setDismissedExpiryPrompt(true);
                }}
                className="text-2xl leading-none text-[#8b6f4e]"
              >
                ×
              </button>
            </div>

            <div className="rounded-xl bg-[#fdf8f1] border border-[#e8dcc8] p-3.5 text-xs text-[#2a1810] space-y-1.5">
              <p>
                Order history is kept for <strong>3 months</strong> (cutoff date:{" "}
                <strong>{retentionInfo?.cutoffDateISO ?? "—"}</strong>).
              </p>
              {(retentionInfo?.expiredCount ?? 0) > 0 ? (
                <p className="text-amber-900 font-semibold">
                  ⚠️ There {retentionInfo?.expiredCount === 1 ? "is" : "are"} currently{" "}
                  <strong>{retentionInfo?.expiredCount}</strong> order
                  {retentionInfo?.expiredCount === 1 ? "" : "s"} older than 3 months waiting for your confirmation to clear.
                </p>
              ) : (
                <p className="text-green-800 font-semibold">
                  ✓ All <strong>{retentionInfo?.totalActiveCount ?? submissions.length}</strong> orders in your history are within the last 3 months.
                  {retentionInfo?.nextClearDateISO
                    ? ` The oldest orders will reach 3 months on ${retentionInfo.nextClearDateISO}.`
                    : ""}
                </p>
              )}
              <p className="text-[#8b6f4e]">
                Nothing is ever deleted automatically without notifying you first.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  setShowClearHistoryModal(false);
                  setDismissedExpiryPrompt(true);
                }}
                className="px-3.5 py-2 rounded-xl border border-[#e8dcc8] text-xs font-semibold text-[#6b5544] hover:bg-[#fdf8f1]"
              >
                Keep History / Remind Later
              </button>
              <button
                onClick={handleConfirmClearOldHistory}
                disabled={clearingHistory || (retentionInfo?.expiredCount ?? 0) === 0}
                className="px-4 py-2 rounded-xl bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white text-xs font-bold"
              >
                {clearingHistory
                  ? "Clearing…"
                  : (retentionInfo?.expiredCount ?? 0) > 0
                    ? `Confirm & Clear (${retentionInfo?.expiredCount})`
                    : "Nothing >3 Months to Clear"}
              </button>
            </div>
          </div>
        </div>
      )}

      {syncing && <SyncingOverlay />}
    </div>
  );
}

// Both Estimates and Stocks now read/write live sheet rows (Freezer /
// Production tab on the active spreadsheet), split cleanly by section —
// no merging, no Supabase table, no "category" (the sheet has none).
// Each product's id is its sheet ROW NUMBER, unique within that section.
//
// Because each active sheet (e.g. Mon–Wed vs Thu–Sat) has its own separate
// set of rows, we also cache the last-saved values per section in
// localStorage (keyed by product NAME, which is stable across sheets, not
// by row number, which isn't). That cache is what powers the "carry over
// the same estimates/stock to the new sheet" prompt below — nothing is ever
// deleted when the active sheet changes, it just isn't visible until you
// choose to carry it over (or re-enter it).

function EstimatesTab() {
  const qc = useQueryClient();
  const [section, setSection] = useState<"Production" | "Freezer">("Production");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [edits, setEdits] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data: sheetInfo } = useQuery(sheetInfoQuery);
  const { notice, acknowledge } = useSheetContext(sheetInfo?.label, "bakery_seen_sheet_estimates");

  const query = useQuery({
    queryKey: ["estimate-products", section],
    queryFn: () => getEstimateProducts({ data: { section } }),
  });

  useEffect(() => { setEdits({}); setMessage(null); }, [section]);

  const items = query.data ?? [];

  // Visibility rule:
  // - If at least one product already has a saved value, hide the zero ones
  //   (toggle "show all" to see everything anyway).
  // - If NO product has a value yet, show everything so values can be entered.
  const anyHasValue = items.some((p) => p.quantity > 0);

  const valueFor = (id: number, original: number) => edits[id] ?? original;

  // Position and visibility are both based on the SAVED value only — not
  // the live edit — so nothing jumps or disappears while you're typing or
  // clearing a field. Everything settles into its new spot only after Save
  // actually completes and the data is refetched.
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items
      .filter((p) => {
        if (s && !p.name.toLowerCase().includes(s)) return false;
        if (anyHasValue && !showAll && p.quantity <= 0) return false;
        return true;
      })
      .sort((a, b) => {
        const aFilled = a.quantity > 0 ? 0 : 1;
        const bFilled = b.quantity > 0 ? 0 : 1;
        if (aFilled !== bFilled) return aFilled - bFilled;
        return a.name.localeCompare(b.name);
      });
  }, [items, search, showAll, anyHasValue]);

  const changedCount = Object.keys(edits).length;

  async function handleSave() {
    setSaving(true); setMessage(null);
    try {
      const updates = Object.entries(edits).map(([row, quantity]) => ({ row: Number(row), quantity }));
      const res = await saveEstimates({ data: { section, updates } });
      setMessage(`Saved ${res.updated} update${res.updated === 1 ? "" : "s"}.`);

      // Cache the fresh values (post-save) by product name so they can be
      // carried over to the next active sheet if/when it changes.
      const cacheValues: Record<string, number> = {};
      for (const p of items) {
        const v = valueFor(p.id, p.quantity);
        if (v > 0) cacheValues[p.name] = v;
      }
      localStorage.setItem(`bakery_estimates_cache_${section}`, JSON.stringify({ values: cacheValues }));

      setEdits({});
      await qc.invalidateQueries({ queryKey: ["estimate-products", section] });
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  // Carries over cached values (from whichever sheet was active before)
  // into the NEW active sheet, for both sections, matched by product name.
  async function handleCarryOver(useSame: boolean) {
    if (!useSame) return;
    setSaving(true); setMessage(null);
    try {
      let totalUpdated = 0;
      for (const sec of ["Production", "Freezer"] as const) {
        const cacheRaw = localStorage.getItem(`bakery_estimates_cache_${sec}`);
        if (!cacheRaw) continue;
        const cache = JSON.parse(cacheRaw) as { values: Record<string, number> };
        const secItems = sec === section ? items : await getEstimateProducts({ data: { section: sec } });
        const updates = secItems
          .filter((p) => (cache.values[p.name] ?? 0) > 0)
          .map((p) => ({ row: p.id, quantity: cache.values[p.name] }));
        if (updates.length) {
          const res = await saveEstimates({ data: { section: sec, updates } });
          totalUpdated += res.updated;
        }
      }
      setMessage(
        totalUpdated > 0
          ? `Carried over ${totalUpdated} estimate${totalUpdated === 1 ? "" : "s"} from the previous sheet.`
          : "No previous estimates found to carry over.",
      );
      await qc.invalidateQueries({ queryKey: ["estimate-products"] });
    } catch (e) {
      setMessage(`Error carrying over: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 max-w-md">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1">
          {(["Production", "Freezer"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${section === s ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          className="flex-1 min-w-[140px] bg-white border border-[#e8dcc8] rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:border-[#c8362b]"
        />
        <label className="flex items-center gap-1.5 text-xs font-semibold text-[#6b5544] shrink-0">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
      {query.isError && <p className="text-sm text-red-700">Failed to load: {(query.error as Error).message}</p>}

      <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
        {filtered.length === 0 && !query.isLoading && (
          <div className="p-6 text-center text-sm text-[#8b6f4e]">
            {anyHasValue ? 'No products match. Toggle "Show all" to see everything.' : "No products match your search."}
          </div>
        )}
        {filtered.map((p) => (
          <div key={p.id} className="px-3 py-2 flex items-center gap-2 hover:bg-[#fdf8f1]">
            <div className="font-semibold text-sm truncate text-[#2a1810]">{p.name}</div>
            <div className="flex-1 border-b border-dotted border-[#e2d4be] min-w-[12px]" />
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={valueFor(p.id, p.quantity) === 0 ? "" : valueFor(p.id, p.quantity)}
              placeholder="0"
              onChange={(e) =>
                setEdits((s) => ({ ...s, [p.id]: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) }))
              }
              className="w-20 h-8 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b] shrink-0"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 sticky bottom-0 bg-[#fdf8f1] py-2">
        <div className="text-xs text-[#8b6f4e] flex-1">
          {changedCount > 0 ? `${changedCount} change${changedCount === 1 ? "" : "s"} pending` : "No changes"}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || changedCount === 0}
          className="bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-2 px-5 rounded-xl transition text-sm"
        >
          {saving ? "Saving…" : "Save Estimates"}
        </button>
      </div>
      {message && <p className="text-xs text-[#6b5544]">{message}</p>}

      {saving && <CenterLoader title="Saving estimates…" />}
      <SheetContextModal notice={notice} onAcknowledge={acknowledge} onCarryOver={handleCarryOver} itemLabel="estimates" tabName="Estimates" />
    </section>
  );
}

function StocksTab() {
  const qc = useQueryClient();
  const [section, setSection] = useState<"Production" | "Freezer">("Production");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [edits, setEdits] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data: sheetInfo } = useQuery(sheetInfoQuery);
  const { notice, acknowledge } = useSheetContext(sheetInfo?.label, "bakery_seen_sheet_stocks");

  const query = useQuery({
    queryKey: ["product-stocks", section],
    queryFn: () => getProductStocks({ data: { section } }),
  });

  useEffect(() => { setEdits({}); setMessage(null); }, [section]);

  const items = query.data ?? [];

  // Same visibility rule as estimates: hide zero-quantity rows once at least
  // one product in THIS section has a value, otherwise show everything.
  const anyHasValue = items.some((p) => p.quantity > 0);

  const valueFor = (id: number, original: number) => edits[id] ?? original;

  // Position and visibility are both based on the SAVED value only — not
  // the live edit — so nothing jumps or disappears while you're typing or
  // clearing a field. Everything settles into its new spot only after Save
  // actually completes and the data is refetched.
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items
      .filter((p) => {
        if (s && !p.name.toLowerCase().includes(s)) return false;
        if (anyHasValue && !showAll && p.quantity <= 0) return false;
        return true;
      })
      .sort((a, b) => {
        const aFilled = a.quantity > 0 ? 0 : 1;
        const bFilled = b.quantity > 0 ? 0 : 1;
        if (aFilled !== bFilled) return aFilled - bFilled;
        return a.name.localeCompare(b.name);
      });
  }, [items, search, showAll, anyHasValue]);

  const changedCount = Object.keys(edits).length;

  async function handleSave() {
    setSaving(true); setMessage(null);
    try {
      const updates = Object.entries(edits).map(([row, quantity]) => ({ row: Number(row), quantity }));
      const res = await saveProductStocks({ data: { section, updates } });
      setMessage(`Saved ${res.updated} update${res.updated === 1 ? "" : "s"}.`);

      // Cache the fresh values (post-save) by product name so they can be
      // carried over ("keep yesterday's stock") to the next active sheet.
      const cacheValues: Record<string, number> = {};
      for (const p of items) {
        const v = valueFor(p.id, p.quantity);
        if (v > 0) cacheValues[p.name] = v;
      }
      localStorage.setItem(`bakery_stocks_cache_${section}`, JSON.stringify({ values: cacheValues }));

      setEdits({});
      await qc.invalidateQueries({ queryKey: ["product-stocks", section] });
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  // Carries over cached stock values into the NEW active sheet, for both
  // sections, matched by product name. Choosing "No" just leaves the new
  // sheet's stock clear so it can be entered fresh.
  async function handleCarryOver(useSame: boolean) {
    if (!useSame) return;
    setSaving(true); setMessage(null);
    try {
      let totalUpdated = 0;
      for (const sec of ["Production", "Freezer"] as const) {
        const cacheRaw = localStorage.getItem(`bakery_stocks_cache_${sec}`);
        if (!cacheRaw) continue;
        const cache = JSON.parse(cacheRaw) as { values: Record<string, number> };
        const secItems = sec === section ? items : await getProductStocks({ data: { section: sec } });
        const updates = secItems
          .filter((p) => (cache.values[p.name] ?? 0) > 0)
          .map((p) => ({ row: p.id, quantity: cache.values[p.name] }));
        if (updates.length) {
          const res = await saveProductStocks({ data: { section: sec, updates } });
          totalUpdated += res.updated;
        }
      }
      setMessage(
        totalUpdated > 0
          ? `Carried over ${totalUpdated} stock count${totalUpdated === 1 ? "" : "s"} from the previous sheet.`
          : "No previous stock counts found to carry over.",
      );
      await qc.invalidateQueries({ queryKey: ["product-stocks"] });
    } catch (e) {
      setMessage(`Error carrying over: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 max-w-md">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1">
          {(["Production", "Freezer"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${section === s ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          className="flex-1 min-w-[140px] bg-white border border-[#e8dcc8] rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:border-[#c8362b]"
        />
        <label className="flex items-center gap-1.5 text-xs font-semibold text-[#6b5544] shrink-0">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
      {query.isError && <p className="text-sm text-red-700">Failed to load: {(query.error as Error).message}</p>}

      <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
        {filtered.length === 0 && !query.isLoading && (
          <div className="p-6 text-center text-sm text-[#8b6f4e]">
            {anyHasValue ? 'No products match. Toggle "Show all" to see everything.' : "No products yet — add quantities below and save."}
          </div>
        )}
        {filtered.map((p) => (
          <div key={p.id} className="px-3 py-2 flex items-center gap-2 hover:bg-[#fdf8f1]">
            <div className="font-semibold text-sm truncate text-[#2a1810]">{p.name}</div>
            <div className="flex-1 border-b border-dotted border-[#e2d4be] min-w-[12px]" />
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={valueFor(p.id, p.quantity) === 0 ? "" : valueFor(p.id, p.quantity)}
              placeholder="0"
              onChange={(e) =>
                setEdits((s) => ({ ...s, [p.id]: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) }))
              }
              className="w-20 h-8 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b] shrink-0"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 sticky bottom-0 bg-[#fdf8f1] py-2">
        <div className="text-xs text-[#8b6f4e] flex-1">
          {changedCount > 0 ? `${changedCount} change${changedCount === 1 ? "" : "s"} pending` : "No changes"}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || changedCount === 0}
          className="bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-2 px-5 rounded-xl transition text-sm"
        >
          {saving ? "Saving…" : "Save Stock"}
        </button>
      </div>
      {message && <p className="text-xs text-[#6b5544]">{message}</p>}

      {saving && <CenterLoader title="Saving stock…" />}
      <SheetContextModal notice={notice} onAcknowledge={acknowledge} onCarryOver={handleCarryOver} itemLabel="stock counts" tabName="Stocks" />
    </section>
  );
}

// Drivers read/write column D of "Customer Order Details" directly on the
// active (day-based) sheet — same source of truth as everything else, no
// Supabase table, no separate tab. One customer can have many product rows;
// saving a driver change writes it to ALL of that customer's rows at once.

function DriversTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data: sheetInfo } = useQuery(sheetInfoQuery);
  const { notice, acknowledge } = useSheetContext(sheetInfo?.label, "bakery_seen_sheet_drivers");

  const query = useQuery({
    queryKey: ["driver-assignments"],
    queryFn: () => getDriverAssignments(),
  });

  const customers = query.data?.customers ?? [];
  const driverOptions = query.data?.driverOptions ?? [];

  const [driverFilter, setDriverFilter] = useState<string>("__all__");

  const valueFor = (name: string, original: string) => edits[name] ?? original;

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (s && !c.name.toLowerCase().includes(s)) return false;
      if (driverFilter !== "__all__") {
        const current = valueFor(c.name, c.driver).trim();
        if (driverFilter === "__unassigned__") {
          if (current !== "") return false;
        } else if (current !== driverFilter) {
          return false;
        }
      }
      return true;
    });
  }, [customers, search, driverFilter, edits]);
  const changedEntries = Object.entries(edits).filter(([name, driver]) => {
    const original = customers.find((c) => c.name === name)?.driver ?? "";
    return driver.trim() !== original.trim();
  });
  const changedCount = changedEntries.length;

  async function handleSave() {
    if (!changedEntries.length) return;
    setSaving(true); setMessage(null);
    setSaveProgress({ done: 0, total: changedEntries.length });
    let failures = 0;
    for (let i = 0; i < changedEntries.length; i++) {
      const [customerName, driver] = changedEntries[i];
      try {
        await saveCustomerDriver({ data: { customerName, driver: driver.trim() } });
      } catch {
        failures += 1;
      }
      setSaveProgress({ done: i + 1, total: changedEntries.length });
    }
    setMessage(
      failures === 0
        ? `Saved ${changedEntries.length} driver change${changedEntries.length === 1 ? "" : "s"}.`
        : `Saved ${changedEntries.length - failures}, ${failures} failed — try again for those.`,
    );

    // Cache the fresh driver assignments so they can be carried over to
    // whichever sheet becomes active next.
    const cacheValues: Record<string, string> = {};
    for (const c of customers) {
      const v = valueFor(c.name, c.driver);
      if (v) cacheValues[c.name] = v;
    }
    localStorage.setItem("bakery_drivers_cache", JSON.stringify({ values: cacheValues }));

    setEdits({});
    setSaving(false);
    setSaveProgress(null);
    await qc.invalidateQueries({ queryKey: ["driver-assignments"] });
    await qc.invalidateQueries({ queryKey: ["customers"] });
  }

  // Carries over cached driver assignments onto the NEW active sheet.
  async function handleCarryOver(useSame: boolean) {
    if (!useSame) return;
    const cacheRaw = localStorage.getItem("bakery_drivers_cache");
    if (!cacheRaw) { setMessage("No previous driver assignments found to carry over."); return; }
    const cache = JSON.parse(cacheRaw) as { values: Record<string, string> };
    const entries = Object.entries(cache.values).filter(([, driver]) => driver);
    if (!entries.length) { setMessage("No previous driver assignments found to carry over."); return; }

    setSaving(true); setMessage(null);
    setSaveProgress({ done: 0, total: entries.length });
    let failures = 0;
    for (let i = 0; i < entries.length; i++) {
      const [customerName, driver] = entries[i];
      try {
        await saveCustomerDriver({ data: { customerName, driver } });
      } catch {
        failures += 1;
      }
      setSaveProgress({ done: i + 1, total: entries.length });
    }
    setMessage(
      failures === 0
        ? `Carried over ${entries.length} driver assignment${entries.length === 1 ? "" : "s"} from the previous sheet.`
        : `Carried over ${entries.length - failures}, ${failures} failed.`,
    );
    setSaving(false);
    setSaveProgress(null);
    await qc.invalidateQueries({ queryKey: ["driver-assignments"] });
    await qc.invalidateQueries({ queryKey: ["customers"] });
  }

  return (
    <section className="space-y-3 max-w-md">
      {query.data?.sheetLabel && (
        <p className="text-xs text-[#8b6f4e]">
          Reading and writing the <span className="font-semibold">{query.data.sheetLabel}</span> sheet — the same one used for order submission.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customers…"
          className="flex-1 min-w-[140px] bg-white border border-[#e8dcc8] rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:border-[#c8362b]"
        />
        <select
          value={driverFilter}
          onChange={(e) => setDriverFilter(e.target.value)}
          className="bg-white border border-[#e8dcc8] rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:border-[#c8362b]"
        >
          <option value="__all__">All drivers</option>
          <option value="__unassigned__">Unassigned</option>
          {driverOptions.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      {query.isLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
      {query.isError && <p className="text-sm text-red-700">Failed to load: {(query.error as Error).message}</p>}

      <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
        {filtered.length === 0 && !query.isLoading && (
          <div className="p-6 text-center text-sm text-[#8b6f4e]">No customers match your search.</div>
        )}
        {filtered.map((c) => {
          const current = valueFor(c.name, c.driver);
          // Guard against a driver value that's somehow not in the known
          // list (shouldn't happen, but keeps the select from silently
          // blanking if it does) by including it as an extra option.
          const options = current && !driverOptions.includes(current)
            ? [current, ...driverOptions]
            : driverOptions;
          return (
            <div key={c.name} className="px-3 py-2 flex items-center gap-2 hover:bg-[#fdf8f1]">
              <div className="font-semibold text-sm truncate text-[#2a1810]">{c.name}</div>
              <div className="flex-1 border-b border-dotted border-[#e2d4be] min-w-[12px]" />
              <select
                value={current}
                onChange={(e) => setEdits((s) => ({ ...s, [c.name]: e.target.value }))}
                className="w-36 h-8 px-2 text-xs font-semibold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b] shrink-0"
              >
                <option value="">Unassigned</option>
                {options.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 sticky bottom-0 bg-[#fdf8f1] py-2">
        <div className="text-xs text-[#8b6f4e] flex-1">
          {saveProgress
            ? `Saving ${saveProgress.done}/${saveProgress.total}…`
            : changedCount > 0
              ? `${changedCount} change${changedCount === 1 ? "" : "s"} pending`
              : "No changes"}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || changedCount === 0}
          className="bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-2 px-5 rounded-xl transition text-sm"
        >
          {saving ? "Saving…" : "Save Drivers"}
        </button>
      </div>
      {message && <p className="text-xs text-[#6b5544]">{message}</p>}

      {saving && (
        <CenterLoader
          title="Saving driver assignments…"
          subtitle={saveProgress ? `${saveProgress.done}/${saveProgress.total}` : undefined}
        />
      )}
      <SheetContextModal notice={notice} onAcknowledge={acknowledge} onCarryOver={handleCarryOver} itemLabel="driver assignments" tabName="Drivers" />
    </section>
  );
}

function SyncingOverlay() {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-xl px-8 py-7 flex flex-col items-center gap-4 max-w-xs w-full text-center">
        <svg
          className="animate-spin w-9 h-9 text-[#c8362b]"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-4a6 6 0 0 0-6-6V2z" />
        </svg>
        <div>
          <p className="font-bold text-[#2a1810]">Syncing with sheet…</p>
          <p className="text-xs text-[#8b6f4e] mt-1">Pulling the latest customers and products.</p>
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="bg-white rounded-2xl border border-[#e8dcc8] p-4 shadow-sm">
      <h3 className="font-semibold text-sm mb-2">{title}</h3>
      {children}
    </div>
  );
}

// ============================================================================
// MANUAL ORDERS TAB (Live Sheet Reader + Fast Admin Order Entry)
// ============================================================================

function ManualOrdersTab({
  selectedSlug,
  onSelectSlug,
  manualRegulars,
  onToggleManualRegular,
  onCopyLink,
  copiedSlug,
}: {
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
  manualRegulars: string[];
  onToggleManualRegular: (slug: string) => void;
  onCopyLink: (slug: string) => void;
  copiedSlug: string | null;
}) {
  const qc = useQueryClient();
  const liveQuery = useQuery(liveSheetOrdersQuery);
  const productsQ = useQuery(productsQuery);

  const [customerSearch, setCustomerSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pinned" | "pending" | "ordered">("all");
  const [driverFilter, setDriverFilter] = useState("__all__");

  const [entryMode, setEntryMode] = useState<"set" | "addon">("set");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [rawQtyInput, setRawQtyInput] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [showExtraProducts, setShowExtraProducts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const customers = liveQuery.data?.customers ?? [];
  const allProducts = productsQ.data ?? [];

  const driverOptions = useMemo(() => {
    const s = new Set<string>();
    for (const c of customers) {
      if (c.driver?.trim()) s.add(c.driver.trim());
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [customers]);

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    return customers.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !c.driver.toLowerCase().includes(q)) {
        return false;
      }
      if (driverFilter !== "__all__" && c.driver !== driverFilter) return false;
      if (statusFilter === "pinned" && !manualRegulars.includes(c.slug)) return false;
      if (statusFilter === "pending" && c.totalQuantity > 0) return false;
      if (statusFilter === "ordered" && c.totalQuantity <= 0) return false;
      return true;
    });
  }, [customers, customerSearch, driverFilter, statusFilter, manualRegulars]);

  // Default to first customer in list if none selected yet
  useEffect(() => {
    if (!selectedSlug && filteredCustomers.length > 0) {
      onSelectSlug(filteredCustomers[0].slug);
    }
  }, [selectedSlug, filteredCustomers, onSelectSlug]);

  const selectedCustomer: LiveSheetCustomerOrder | null = useMemo(
    () => customers.find((c) => c.slug === selectedSlug) ?? null,
    [customers, selectedSlug],
  );

  // Sync the form inputs whenever the selected customer or entryMode changes
  useEffect(() => {
    setFeedback(null);
    setProductSearch("");
    setShowExtraProducts(false);
    setRawQtyInput({});
    if (!selectedCustomer) {
      setQty({});
      setComment("");
      return;
    }
    if (entryMode === "set") {
      const next: Record<string, number> = {};
      for (const r of selectedCustomer.rows) {
        if (r.quantity > 0) {
          next[`r:${r.sheetRow}`] = r.quantity;
        }
      }
      setQty(next);
      setComment(selectedCustomer.comment || "");
    } else {
      setQty({});
      setComment("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.slug, entryMode, liveQuery.dataUpdatedAt]);

  const regularProductNamesLower = useMemo(
    () => new Set((selectedCustomer?.rows ?? []).map((r) => r.productName.trim().toLowerCase())),
    [selectedCustomer],
  );

  const filteredRegulars = useMemo(() => {
    if (!selectedCustomer) return [];
    const s = productSearch.trim().toLowerCase();
    if (!s) return selectedCustomer.rows;
    return selectedCustomer.rows.filter((r) => r.productName.toLowerCase().includes(s));
  }, [selectedCustomer, productSearch]);

  const extraProducts = useMemo(() => {
    const s = productSearch.trim().toLowerCase();
    if (!showExtraProducts && !s) return [];
    return allProducts.filter((p) => {
      if (regularProductNamesLower.has(p.name.trim().toLowerCase())) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s);
    });
  }, [allProducts, regularProductNamesLower, productSearch, showExtraProducts]);

  function setLineQty(key: string, val: number) {
    const clean = Math.max(0, Math.round((val || 0) * 1000) / 1000);
    setQty((prev) => ({ ...prev, [key]: clean }));
  }

  function handleRawQtyChange(key: string, raw: string) {
    const normalized = raw.replace(/,/g, ".");
    if (!/^[0-9]*\.?[0-9]*$/.test(normalized)) return;
    setRawQtyInput((prev) => ({ ...prev, [key]: normalized }));
    if (normalized === "" || normalized === ".") {
      setLineQty(key, 0);
      return;
    }
    const parsed = parseFloat(normalized);
    if (Number.isFinite(parsed)) {
      setLineQty(key, parsed);
    }
  }

  function displayQtyValue(key: string, val: number): string {
    if (rawQtyInput[key] !== undefined) return rawQtyInput[key];
    return val === 0 ? "" : String(val);
  }

  function clearRawForKey(key: string) {
    setRawQtyInput((prev) => {
      if (prev[key] === undefined) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function adjustLineQty(key: string, delta: number) {
    clearRawForKey(key);
    setQty((prev) => {
      const nextVal = Math.max(0, Math.round(((prev[key] ?? 0) + delta) * 1000) / 1000);
      return { ...prev, [key]: nextVal };
    });
  }

  function handleRepeatLastOrder() {
    if (!selectedCustomer?.lastOrder) return;
    const next: Record<string, number> = {};
    for (const item of selectedCustomer.lastOrder.items) {
      const matchRow = selectedCustomer.rows.find(
        (r) =>
          (item.productId && r.productId === item.productId) ||
          r.productName.trim().toLowerCase() === item.productName.trim().toLowerCase(),
      );
      if (matchRow) {
        next[`r:${matchRow.sheetRow}`] = item.quantity;
      } else {
        const extraProd = allProducts.find(
          (p) =>
            (item.productId && p.id === item.productId) ||
            p.name.trim().toLowerCase() === item.productName.trim().toLowerCase(),
        );
        if (extraProd) {
          next[`x:${extraProd.id}`] = item.quantity;
          setShowExtraProducts(true);
        }
      }
    }
    setRawQtyInput({});
    setQty(next);
    setFeedback({
      type: "ok",
      text: `Loaded ${selectedCustomer.lastOrder.totalItems} items from last order (${selectedCustomer.lastOrder.forDate}). Click "Save to Sheet" to confirm.`,
    });
  }

  function handleResetToSheet() {
    if (!selectedCustomer) return;
    const next: Record<string, number> = {};
    if (entryMode === "set") {
      for (const r of selectedCustomer.rows) {
        if (r.quantity > 0) next[`r:${r.sheetRow}`] = r.quantity;
      }
    }
    setRawQtyInput({});
    setQty(next);
    setFeedback(null);
  }

  const builtItems = useMemo(() => {
    if (!selectedCustomer) return [];
    const out: Array<{ sheetRow: number; productName: string; productId: string | null; quantity: number }> = [];
    for (const r of selectedCustomer.rows) {
      const v = qty[`r:${r.sheetRow}`] ?? 0;
      if (v > 0) {
        out.push({
          sheetRow: r.sheetRow,
          productName: r.productName,
          productId: r.productId,
          quantity: v,
        });
      }
    }
    for (const [k, v] of Object.entries(qty)) {
      if (!k.startsWith("x:") || v <= 0) continue;
      const pid = k.slice(2);
      const p = allProducts.find((x) => x.id === pid);
      if (!p) continue;
      out.push({
        sheetRow: 0,
        productName: p.name,
        productId: p.id,
        quantity: v,
      });
    }
    return out;
  }, [selectedCustomer, qty, allProducts]);

  const totalToSave = useMemo(
    () => builtItems.reduce((a, b) => a + b.quantity, 0),
    [builtItems],
  );

  async function saveOrder(advanceToNextPending: boolean) {
    if (!selectedCustomer) return;
    if (builtItems.length === 0 || totalToSave <= 0) {
      setFeedback({
        type: "err",
        text: "Enter a quantity for at least 1 product (or click 'Clear Sheet Order to 0' to zero out).",
      });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const res = await adminSaveManualOrder({
        data: {
          customerName: selectedCustomer.name,
          slug: selectedCustomer.slug,
          mode: entryMode,
          items: builtItems,
          comment,
        },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["live-sheet-orders"] }),
        qc.invalidateQueries({ queryKey: ["submissions"] }),
        qc.invalidateQueries({ queryKey: ["analytics"] }),
      ]);
      setFeedback({
        type: "ok",
        text:
          entryMode === "addon"
            ? `Added +${res.totalItems} items onto ${selectedCustomer.name}'s sheet order.`
            : `Saved ${res.totalItems} items to ${selectedCustomer.name} on the sheet.`,
      });

      if (advanceToNextPending) {
        const currentIdx = filteredCustomers.findIndex((c) => c.slug === selectedCustomer.slug);
        const nextPending =
          filteredCustomers.slice(currentIdx + 1).find((c) => c.totalQuantity === 0) ??
          filteredCustomers.find((c) => c.slug !== selectedCustomer.slug && c.totalQuantity === 0);
        if (nextPending) {
          onSelectSlug(nextPending.slug);
        }
      }
    } catch (e) {
      setFeedback({ type: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearCustomerOrder() {
    if (!selectedCustomer) return;
    setSaving(true);
    setFeedback(null);
    try {
      await adminSaveManualOrder({
        data: {
          customerName: selectedCustomer.name,
          slug: selectedCustomer.slug,
          mode: "clear",
          items: [],
          comment: "",
        },
      });
      setQty({});
      setComment("");
      await qc.invalidateQueries({ queryKey: ["live-sheet-orders"] });
      setFeedback({
        type: "ok",
        text: `Cleared ${selectedCustomer.name}'s quantities to 0 on the active sheet.`,
      });
    } catch (e) {
      setFeedback({ type: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const orderedCount = customers.filter((c) => c.totalQuantity > 0).length;
  const pendingCount = customers.length - orderedCount;

  return (
    <section className="space-y-4">
      {/* Top status bar */}
      <div className="bg-white rounded-2xl border border-[#e8dcc8] p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-[#c8362b]/10 text-[#c8362b]">
              Active Sheet: {liveQuery.data?.sheetLabel ?? "…"}
            </span>
            {liveQuery.data?.forDate && (
              <span className="text-xs font-semibold text-[#6b5544]">
                Delivery Date: <strong>{liveQuery.data.forDate}</strong>
              </span>
            )}
          </div>
          <p className="text-xs text-[#8b6f4e] mt-1">
            Reads live quantities directly from Column C of the active Google Sheet — including orders typed straight into the sheet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void qc.invalidateQueries({ queryKey: ["live-sheet-orders"] })}
            disabled={liveQuery.isFetching}
            className="text-xs font-bold px-3 py-2 rounded-xl border border-[#2a1810] hover:bg-[#2a1810] hover:text-white transition disabled:opacity-50"
          >
            {liveQuery.isFetching ? "Reading Sheet…" : "↻ Refresh from Sheet"}
          </button>
        </div>
      </div>

      {liveQuery.isLoading && (
        <div className="bg-white rounded-2xl border border-[#e8dcc8] p-8 text-center text-sm text-[#8b6f4e]">
          Reading live customer orders from the Google Sheet…
        </div>
      )}

      {liveQuery.isError && (
        <div className="bg-white rounded-2xl border border-red-300 p-6 text-center text-sm text-red-700">
          Failed to read live sheet: {(liveQuery.error as Error).message}
        </div>
      )}

      {!liveQuery.isLoading && !liveQuery.isError && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* LEFT PANEL: Customer Search & Picker */}
          <div className="lg:col-span-5 bg-white rounded-2xl border border-[#e8dcc8] shadow-sm overflow-hidden flex flex-col">
            <div className="p-3.5 border-b border-[#e8dcc8] space-y-2.5 bg-[#fdf8f1]/60">
              <div className="relative">
                <input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search customer or driver…"
                  className="w-full bg-white border border-[#e8dcc8] rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#c8362b]"
                />
                {customerSearch && (
                  <button
                    onClick={() => setCustomerSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8b6f4e] hover:text-[#2a1810] font-bold"
                  >
                    ×
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1">
                {([
                  { id: "all", label: `All (${customers.length})` },
                  { id: "pinned", label: `★ Manual (${manualRegulars.length})` },
                  { id: "pending", label: `⚪ 0 on Sheet (${pendingCount})` },
                  { id: "ordered", label: `🟢 On Sheet (${orderedCount})` },
                ] as const).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setStatusFilter(f.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                      statusFilter === f.id
                        ? "bg-[#c8362b] text-white"
                        : "bg-white border border-[#e8dcc8] text-[#6b5544] hover:bg-[#fdf8f1]"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <select
                value={driverFilter}
                onChange={(e) => setDriverFilter(e.target.value)}
                className="w-full bg-white border border-[#e8dcc8] rounded-xl px-3 py-1.5 text-xs font-semibold focus:outline-none focus:border-[#c8362b]"
              >
                <option value="__all__">All drivers</option>
                {driverOptions.map((d) => (
                  <option key={d} value={d}>
                    Driver: {d}
                  </option>
                ))}
              </select>
            </div>

            <div className="divide-y divide-[#e8dcc8] max-h-[640px] overflow-y-auto">
              {filteredCustomers.length === 0 && (
                <div className="p-6 text-center text-xs text-[#8b6f4e]">
                  No customers match your search/filter.
                </div>
              )}
              {filteredCustomers.map((c) => {
                const active = c.slug === selectedCustomer?.slug;
                const pinned = manualRegulars.includes(c.slug);
                return (
                  <div
                    key={c.slug}
                    onClick={() => onSelectSlug(c.slug)}
                    className={`p-3 flex items-center justify-between gap-2 cursor-pointer transition ${
                      active ? "bg-[#c8362b]/10 border-l-4 border-l-[#c8362b]" : "hover:bg-[#fdf8f1]"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleManualRegular(c.slug);
                        }}
                        title={pinned ? "Unpin from Manual Regulars" : "Pin to Manual Regulars"}
                        className={`text-base leading-none ${
                          pinned ? "text-amber-500" : "text-[#d5c5ae] hover:text-amber-400"
                        }`}
                      >
                        ★
                      </button>
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">{c.name}</div>
                        <div className="text-[11px] text-[#8b6f4e] truncate">
                          {c.driver || "Unassigned"} · {c.rows.length} regular items
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {c.totalQuantity > 0 ? (
                        <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-800">
                          🟢 {c.totalQuantity}
                        </span>
                      ) : (
                        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] text-[#8b6f4e]">
                          0
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT PANEL: Order Entry Pad */}
          <div className="lg:col-span-7 bg-white rounded-2xl border border-[#e8dcc8] shadow-sm overflow-hidden">
            {!selectedCustomer ? (
              <div className="p-10 text-center text-sm text-[#8b6f4e]">
                Select a customer on the left to view or enter their order.
              </div>
            ) : (
              <div className="divide-y divide-[#e8dcc8]">
                {/* Customer Header */}
                <div className="p-4 bg-[#fdf8f1]/70 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-bold text-[#2a1810]">{selectedCustomer.name}</h2>
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-white border border-[#e8dcc8] text-[#6b5544]">
                        🚚 {selectedCustomer.driver || "Unassigned"}
                      </span>
                      {selectedCustomer.totalQuantity > 0 ? (
                        <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-green-100 text-green-800">
                          🟢 Currently on sheet: {selectedCustomer.totalQuantity} items
                        </span>
                      ) : (
                        <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800">
                          ⚪ Not ordered yet (0 on sheet)
                        </span>
                      )}
                    </div>
                    {selectedCustomer.comment && (
                      <p className="text-xs text-[#6b5544] mt-1">
                        💬 Current sheet comment: <strong>{selectedCustomer.comment}</strong>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => onCopyLink(selectedCustomer.slug)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#e8dcc8] bg-white hover:bg-[#fdf8f1]"
                    >
                      {copiedSlug === selectedCustomer.slug ? "✓ Copied!" : "📋 Copy Link"}
                    </button>
                    <Link
                      to="/order/$slug"
                      params={{ slug: selectedCustomer.slug }}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#e8dcc8] bg-white hover:bg-[#fdf8f1]"
                    >
                      Customer View ↗
                    </Link>
                  </div>
                </div>

                {/* Mode & Quick Fill Toolbar */}
                <div className="p-3.5 flex flex-wrap items-center justify-between gap-2 bg-white">
                  <div className="flex gap-1 bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl p-1">
                    <button
                      type="button"
                      onClick={() => setEntryMode("set")}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                        entryMode === "set" ? "bg-[#c8362b] text-white" : "text-[#6b5544]"
                      }`}
                    >
                      ✏️ Set / Overwrite Sheet (Col C)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEntryMode("addon")}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                        entryMode === "addon" ? "bg-[#c8362b] text-white" : "text-[#6b5544]"
                      }`}
                    >
                      ➕ Add onto Existing
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {selectedCustomer.lastOrder && (
                      <button
                        type="button"
                        onClick={handleRepeatLastOrder}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-100 text-amber-900 hover:bg-amber-200 transition"
                        title={`Fill quantities from their last order (${selectedCustomer.lastOrder.forDate})`}
                      >
                        ⟳ Repeat Last ({selectedCustomer.lastOrder.totalItems} items)
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleResetToSheet}
                      className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
                    >
                      ↺ Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setQty({});
                        setRawQtyInput({});
                      }}
                      className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
                    >
                      Zero Inputs
                    </button>
                  </div>
                </div>

                {/* Product Search */}
                <div className="p-3 bg-[#fdf8f1]/40">
                  <div className="relative">
                    <input
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      placeholder="Filter regular products or type any product name to add extra…"
                      className="w-full bg-white border border-[#e8dcc8] rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#c8362b]"
                    />
                    {productSearch && (
                      <button
                        onClick={() => setProductSearch("")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8b6f4e] hover:text-[#2a1810] font-bold"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>

                {/* Regular Products List */}
                <div className="divide-y divide-[#e8dcc8] max-h-[420px] overflow-y-auto">
                  {filteredRegulars.map((r) => {
                    const k = `r:${r.sheetRow}`;
                    const val = qty[k] ?? 0;
                    return (
                      <div
                        key={r.sheetRow}
                        className={`p-3 flex items-center justify-between gap-3 ${
                          val > 0 ? "bg-[#c8362b]/[0.04]" : "hover:bg-[#fdf8f1]/60"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-sm leading-snug">{r.productName}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] text-[#8b6f4e]">Row #{r.sheetRow}</span>
                            {r.quantity > 0 && (
                              <span className="text-[11px] font-bold text-green-700">
                                On sheet: {r.quantity}
                              </span>
                            )}
                            {r.lateQuantity > 0 && (
                              <span className="text-[11px] font-bold text-red-600">
                                Late: {r.lateQuantity}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => adjustLineQty(k, -1)}
                            className="w-8 h-8 rounded-lg bg-[#fdf8f1] border border-[#e8dcc8] font-bold text-base hover:bg-[#e8dcc8]/50"
                          >
                            −
                          </button>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={displayQtyValue(k, val)}
                            placeholder="0"
                            onChange={(e) => handleRawQtyChange(k, e.target.value)}
                            onBlur={() => clearRawForKey(k)}
                            className={`w-16 h-8 text-center font-bold border rounded-lg focus:outline-none ${
                              val > 0
                                ? "border-[#c8362b] bg-white text-[#c8362b]"
                                : "border-[#e8dcc8] bg-[#fdf8f1] text-[#2a1810]"
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => adjustLineQty(k, 1)}
                            className="w-8 h-8 rounded-lg bg-[#c8362b] text-white font-bold text-base hover:bg-[#a82a22]"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            onClick={() => adjustLineQty(k, 0.5)}
                            className="px-2 h-8 rounded-lg bg-[#fdf8f1] border border-[#e8dcc8] text-xs font-bold text-[#6b5544] hover:bg-[#e8dcc8]/50"
                            title="Add 0.5"
                          >
                            +0.5
                          </button>
                          <button
                            type="button"
                            onClick={() => adjustLineQty(k, 5)}
                            className="px-2 h-8 rounded-lg bg-[#fdf8f1] border border-[#e8dcc8] text-xs font-bold text-[#6b5544] hover:bg-[#e8dcc8]/50"
                            title="Add 5"
                          >
                            +5
                          </button>
                          <button
                            type="button"
                            onClick={() => adjustLineQty(k, 10)}
                            className="px-2 h-8 rounded-lg bg-[#fdf8f1] border border-[#e8dcc8] text-xs font-bold text-[#6b5544] hover:bg-[#e8dcc8]/50"
                            title="Add 10"
                          >
                            +10
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Extra Products Section */}
                  <div className="p-3 bg-[#fdf8f1]/40">
                    {!showExtraProducts && !productSearch.trim() ? (
                      <button
                        type="button"
                        onClick={() => setShowExtraProducts(true)}
                        className="w-full py-2 rounded-xl border border-dashed border-[#c8362b]/50 text-xs font-bold text-[#c8362b] hover:bg-[#c8362b]/5"
                      >
                        + Add Extra Product (from full bakery list)
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold uppercase tracking-wider text-[#8b6f4e]">
                            Extra Products ({extraProducts.length}) — inserts into sheet automatically
                          </span>
                          {showExtraProducts && (
                            <button
                              type="button"
                              onClick={() => setShowExtraProducts(false)}
                              className="text-xs font-semibold text-[#c8362b] hover:underline"
                            >
                              Hide extra
                            </button>
                          )}
                        </div>
                        <div className="divide-y divide-[#e8dcc8] bg-white rounded-xl border border-[#e8dcc8] max-h-60 overflow-y-auto">
                          {extraProducts.slice(0, 60).map((p) => {
                            const k = `x:${p.id}`;
                            const val = qty[k] ?? 0;
                            return (
                              <div key={p.id} className="p-2.5 flex items-center justify-between gap-2">
                                <span className="text-xs font-medium truncate">{p.name}</span>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => adjustLineQty(k, -1)}
                                    className="w-7 h-7 rounded-lg bg-[#fdf8f1] border border-[#e8dcc8] font-bold text-sm"
                                  >
                                    −
                                  </button>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={displayQtyValue(k, val)}
                                    placeholder="0"
                                    onChange={(e) => handleRawQtyChange(k, e.target.value)}
                                    onBlur={() => clearRawForKey(k)}
                                    className="w-14 h-7 text-center text-xs font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1]"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => adjustLineQty(k, 1)}
                                    className="w-7 h-7 rounded-lg bg-[#c8362b] text-white font-bold text-sm"
                                  >
                                    +
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => adjustLineQty(k, 0.5)}
                                    className="px-1.5 h-7 rounded-lg bg-[#fdf8f1] border border-[#e8dcc8] text-[10px] font-bold text-[#6b5544]"
                                  >
                                    +0.5
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Comment & Save Bar */}
                <div className="p-4 bg-[#fdf8f1] space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={comment}
                      onChange={(e) => setComment(e.target.value.replace(/[\r\n\t]+/g, " "))}
                      placeholder="Optional note / comment (writes to Column J on sheet)…"
                      className="flex-1 min-w-[200px] bg-white border border-[#e8dcc8] rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#c8362b]"
                    />
                  </div>

                  {feedback && (
                    <div
                      className={`text-xs font-semibold px-3 py-2 rounded-xl border ${
                        feedback.type === "ok"
                          ? "bg-green-50 border-green-200 text-green-800"
                          : "bg-red-50 border-red-200 text-red-700"
                      }`}
                    >
                      {feedback.text}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-[#6b5544]">
                      Total entered: <strong className="text-sm text-[#2a1810]">{totalToSave} items</strong> across{" "}
                      <strong>{builtItems.length} products</strong>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {selectedCustomer.totalQuantity > 0 && (
                        <button
                          type="button"
                          onClick={handleClearCustomerOrder}
                          disabled={saving}
                          className="text-xs font-bold px-3 py-2.5 rounded-xl border border-red-300 text-red-700 bg-white hover:bg-red-50 transition disabled:opacity-50"
                          title="Zero out this customer's quantities on the active sheet"
                        >
                          🗑 Clear Sheet Order to 0
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void saveOrder(false)}
                        disabled={saving || totalToSave <= 0}
                        className="text-xs font-bold px-4 py-2.5 rounded-xl bg-[#c8362b] hover:bg-[#a82a22] text-white transition disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e]"
                      >
                        {saving
                          ? "Saving…"
                          : entryMode === "addon"
                          ? `➕ Add +${totalToSave} to Sheet`
                          : `💾 Save to Sheet (${totalToSave})`}
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveOrder(true)}
                        disabled={saving || totalToSave <= 0}
                        className="text-xs font-bold px-4 py-2.5 rounded-xl bg-[#2a1810] hover:bg-black text-white transition disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e]"
                        title="Save this customer's order and jump to the next customer with 0 on the sheet"
                      >
                        💾 Save & Next Pending →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {saving && <CenterLoader title="Updating Google Sheet…" subtitle={selectedCustomer?.name} />}
    </section>
  );
}

// ============================================================================
// PRINT SHEET TAB (16px Crisp Print Layout + Printed/Added Snapshot Tracking)
// ============================================================================

type PrintCustomerMode = "items" | "total_only" | "hidden";

type PrintedCustomerSnapshot = {
  printedAt: string;
  totalQuantity: number;
  items: Record<string, number>; // normalized productName -> printed quantity
};

type CustomerPrintStatus = "unprinted" | "printed_clean" | "printed_added";

// Default customers that show ONLY their "[Customer] Total" row on the print
// sheet (matching the bakery's standard pivot print layout).
const DEFAULT_TOTAL_ONLY_CUSTOMERS = new Set([
  "louise",
  "discountjeppe",
  "jose",
  "discountplain",
  "lilly",
  "newstop",
  "sasol",
  "patrick",
  "shaft22",
  "shopcollections",
  "tiptopcafe",
  "illovo",
]);

function normPrintKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getDefaultPrintMode(name: string): PrintCustomerMode {
  return DEFAULT_TOTAL_ONLY_CUSTOMERS.has(normPrintKey(name)) ? "total_only" : "items";
}

type PrintLine = {
  kind: "item" | "customer_total" | "driver_subtotal";
  customerName: string;
  rawCustomerName?: string;
  customerSlug?: string;
  productName: string;
  quantity: number | string;
  driver?: string;
  printStatus?: CustomerPrintStatus;
  printedQty?: number;
  addedQty?: number;
};

function buildCustomerSnapshot(
  c: LiveSheetCustomerOrder,
  nowIso = new Date().toISOString(),
): PrintedCustomerSnapshot {
  const itemsMap: Record<string, number> = {};
  for (const r of c.rows) {
    if (r.quantity > 0) {
      const pKey = r.productName.trim().toLowerCase();
      itemsMap[pKey] = (itemsMap[pKey] ?? 0) + r.quantity;
    }
  }
  return {
    printedAt: nowIso,
    totalQuantity: c.totalQuantity,
    items: itemsMap,
  };
}

function getCustomerPrintStatus(
  c: LiveSheetCustomerOrder,
  snap: PrintedCustomerSnapshot | undefined,
): CustomerPrintStatus {
  if (!snap) return "unprinted";
  // Only re-show a printed customer if an order/item was ADDED to it
  if (c.totalQuantity > snap.totalQuantity) return "printed_added";
  const currentByProduct: Record<string, number> = {};
  for (const r of c.rows) {
    if (r.quantity <= 0) continue;
    const pKey = r.productName.trim().toLowerCase();
    currentByProduct[pKey] = (currentByProduct[pKey] ?? 0) + r.quantity;
  }
  for (const [pKey, qty] of Object.entries(currentByProduct)) {
    const prev = snap.items[pKey] ?? 0;
    if (qty > prev) return "printed_added";
  }
  return "printed_clean";
}

const PRINT_SNAPSHOTS_STORAGE_KEY = "bakery_printed_snapshots_v2";

function loadInitialPrintedSnapshots(): Record<string, PrintedCustomerSnapshot> {
  if (typeof window === "undefined") return {};
  const merged: Record<string, PrintedCustomerSnapshot> = {};
  try {
    // Migrate any earlier date-keyed v1 snapshots so nothing previously printed today is lost
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("bakery_printed_snapshots_v1_")) {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<
            string,
            PrintedCustomerSnapshot
          >;
          Object.assign(merged, parsed);
        } catch {}
      }
    }
    const rawV2 = localStorage.getItem(PRINT_SNAPSHOTS_STORAGE_KEY);
    if (rawV2) {
      const parsedV2 = JSON.parse(rawV2) as Record<string, PrintedCustomerSnapshot>;
      Object.assign(merged, parsedV2);
    }
    if (Object.keys(merged).length > 0) {
      localStorage.setItem(PRINT_SNAPSHOTS_STORAGE_KEY, JSON.stringify(merged));
    }
  } catch {}
  return merged;
}

type PrintLayoutSettings = {
  colWidths: [number, number, number, number, number, number, number]; // A, B, C, D, E, F, G in px
  rowHeightPx: number;
  fontSizePx: number;
  marginTopBottomMm: number;
  marginLeftRightMm: number;
  linkLeftRightCols: boolean;
};

const DEFAULT_PRINT_LAYOUT: PrintLayoutSettings = {
  colWidths: [166, 160, 42, 14, 166, 160, 42],
  rowHeightPx: 20,
  fontSizePx: 14,
  marginTopBottomMm: 5,
  marginLeftRightMm: 5,
  linkLeftRightCols: true,
};

const PRINT_LAYOUT_STORAGE_KEY = "bakery_print_layout_settings_v1";
const PRINT_REMOVED_PRODUCTS_STORAGE_KEY = "bakery_print_removed_products_v1";

function PrintSheetTab() {
  const qc = useQueryClient();
  const liveQuery = useQuery(liveSheetOrdersQuery);

  // Delivery date source: "__live__" = Live Google Sheet (Tomorrow), or a YYYY-MM-DD delivery date
  // (e.g. Today's Delivery after the Google Sheet has already cleared for the next day)
  const [selectedPrintDate, setSelectedPrintDate] = useState<string>("__live__");

  const savedDateQuery = useQuery({
    queryKey: ["print-sheet-for-date", selectedPrintDate],
    queryFn: () => getPrintSheetForDate({ data: { forDate: selectedPrintDate } }),
    enabled: selectedPrintDate !== "__live__",
    staleTime: 10_000,
  });

  const activeDataSource = selectedPrintDate === "__live__" ? liveQuery.data : savedDateQuery.data;
  const isFetchingSource =
    selectedPrintDate === "__live__" ? liveQuery.isFetching : savedDateQuery.isFetching;
  const isLoadingSource =
    selectedPrintDate === "__live__" ? liveQuery.isLoading : savedDateQuery.isLoading;

  const [driverFilter, setDriverFilter] = useState("__all__");
  const [groupByDriver, setGroupByDriver] = useState(true);
  const [viewFilter, setViewFilter] = useState<"to_print" | "all_highlight" | "printed_only">("to_print");
  const [showCustomize, setShowCustomize] = useState(false);
  const [showLayoutControls, setShowLayoutControls] = useState(true);
  const [customizeSearch, setCustomizeSearch] = useState("");

  const [layout, setLayout] = useState<PrintLayoutSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_PRINT_LAYOUT;
    try {
      const raw = localStorage.getItem(PRINT_LAYOUT_STORAGE_KEY);
      if (!raw) return DEFAULT_PRINT_LAYOUT;
      const parsed = JSON.parse(raw) as Partial<PrintLayoutSettings>;
      return {
        ...DEFAULT_PRINT_LAYOUT,
        ...parsed,
        colWidths:
          Array.isArray(parsed.colWidths) && parsed.colWidths.length === 7
            ? (parsed.colWidths as [number, number, number, number, number, number, number])
            : DEFAULT_PRINT_LAYOUT.colWidths,
      };
    } catch {
      return DEFAULT_PRINT_LAYOUT;
    }
  });

  function updateLayout(patch: Partial<PrintLayoutSettings>) {
    setLayout((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(PRINT_LAYOUT_STORAGE_KEY, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  }

  function setColWidth(colIdx: number, rawPx: number) {
    const minPx = colIdx === 3 ? 2 : colIdx === 2 || colIdx === 6 ? 24 : 60;
    const maxPx = colIdx === 3 ? 60 : colIdx === 2 || colIdx === 6 ? 140 : 420;
    const clamped = Math.max(minPx, Math.min(maxPx, Math.round(rawPx)));
    setLayout((prev) => {
      const nextCols = [...prev.colWidths] as [number, number, number, number, number, number, number];
      nextCols[colIdx] = clamped;
      if (prev.linkLeftRightCols) {
        if (colIdx === 0) nextCols[4] = clamped;
        if (colIdx === 4) nextCols[0] = clamped;
        if (colIdx === 1) nextCols[5] = clamped;
        if (colIdx === 5) nextCols[1] = clamped;
        if (colIdx === 2) nextCols[6] = clamped;
        if (colIdx === 6) nextCols[2] = clamped;
      }
      const next = { ...prev, colWidths: nextCols };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(PRINT_LAYOUT_STORAGE_KEY, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  }

  function startColResize(colIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = layout.colWidths[colIdx];
    const onMove = (ev: MouseEvent) => {
      setColWidth(colIdx, startW + (ev.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const {
    colWidths,
    rowHeightPx,
    fontSizePx,
    marginTopBottomMm,
    marginLeftRightMm,
    linkLeftRightCols,
  } = layout;
  const totalSheetWidthPx = colWidths.reduce((s, w) => s + w, 0);

  const [printedSnapshots, setPrintedSnapshots] = useState<Record<string, PrintedCustomerSnapshot>>(() =>
    loadInitialPrintedSnapshots(),
  );

  const [customModes, setCustomModes] = useState<Record<string, PrintCustomerMode>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(PRINT_MODES_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, PrintCustomerMode>) : {};
    } catch {
      return {};
    }
  });

  // Individual product lines removed from the print sheet per customer:
  // { [normPrintKey(customerName)]: [lowerProductName, ...] }
  const [removedProducts, setRemovedProducts] = useState<Record<string, string[]>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(PRINT_REMOVED_PRODUCTS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    } catch {
      return {};
    }
  });

  // Merge server-persisted print state (from Supabase) with local state whenever
  // liveQuery finishes loading.
  const serverSyncedOnceRef = useRef(false);
  useEffect(() => {
    if (!liveQuery.data) return;
    const serverSnaps = liveQuery.data.printState?.printedSnapshots ?? {};
    const serverModes = liveQuery.data.printState?.customModes ?? {};
    const serverRemoved = liveQuery.data.printState?.removedProducts ?? {};
    const liveCusts = liveQuery.data.customers ?? [];
    // Only clear stale snapshots for individual customers if the live sheet is NOT completely blank
    // (so if the whole sheet clears for the next day, printed state isn't wiped prematurely).
    const anyActiveOnLiveSheet = liveCusts.some((c) => c.totalQuantity > 0);

    setPrintedSnapshots((prev) => {
      const merged: Record<string, PrintedCustomerSnapshot> = { ...serverSnaps, ...prev };
      for (const [k, sSnap] of Object.entries(serverSnaps)) {
        const lSnap = prev[k];
        if (!lSnap || (sSnap.printedAt ?? "") > (lSnap.printedAt ?? "")) {
          merged[k] = sSnap;
        }
      }
      if (anyActiveOnLiveSheet) {
        for (const c of liveCusts) {
          const k = normPrintKey(c.name);
          if (c.totalQuantity === 0 && merged[k]) {
            delete merged[k];
          }
        }
      }
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(PRINT_SNAPSHOTS_STORAGE_KEY, JSON.stringify(merged));
        } catch {}
      }
      if (!serverSyncedOnceRef.current && Object.keys(merged).length > Object.keys(serverSnaps).length) {
        serverSyncedOnceRef.current = true;
        void savePrintSheetState({ data: { printedSnapshots: merged } });
      } else {
        serverSyncedOnceRef.current = true;
      }
      return merged;
    });

    if (Object.keys(serverModes).length > 0) {
      setCustomModes((prev) => {
        const mergedModes = { ...serverModes, ...prev };
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(PRINT_MODES_STORAGE_KEY, JSON.stringify(mergedModes));
          } catch {}
        }
        return mergedModes;
      });
    }

    if (Object.keys(serverRemoved).length > 0) {
      setRemovedProducts((prev) => {
        const mergedRemoved = { ...serverRemoved, ...prev };
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(PRINT_REMOVED_PRODUCTS_STORAGE_KEY, JSON.stringify(mergedRemoved));
          } catch {}
        }
        return mergedRemoved;
      });
    }
  }, [liveQuery.data]);

  function persistSnapshotsOnly(next: Record<string, PrintedCustomerSnapshot>) {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(PRINT_SNAPSHOTS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
    }
    void savePrintSheetState({ data: { printedSnapshots: next } });
  }

  function saveSnapshots(next: Record<string, PrintedCustomerSnapshot>) {
    setPrintedSnapshots(next);
    persistSnapshotsOnly(next);
  }

  function saveRemovedProductsState(next: Record<string, string[]>) {
    setRemovedProducts(next);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(PRINT_REMOVED_PRODUCTS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
    }
    void savePrintSheetState({ data: { removedProducts: next } });
  }

  function removeSingleProductFromPrint(customerName: string, productName: string) {
    const cKey = normPrintKey(customerName);
    const pKey = productName.trim().toLowerCase();
    const existing = removedProducts[cKey] ?? [];
    if (existing.includes(pKey)) return;
    const nextList = [...existing, pKey];
    const next = { ...removedProducts, [cKey]: nextList };
    saveRemovedProductsState(next);
  }

  function restoreRemovedProductsForCustomer(customerName: string) {
    const cKey = normPrintKey(customerName);
    if (!removedProducts[cKey]) return;
    const next = { ...removedProducts };
    delete next[cKey];
    saveRemovedProductsState(next);
  }

  function modeForCustomer(name: string): PrintCustomerMode {
    const k = normPrintKey(name);
    return customModes[k] ?? getDefaultPrintMode(name);
  }

  function setCustomerMode(name: string, mode: PrintCustomerMode) {
    const k = normPrintKey(name);
    setCustomModes((prev) => {
      const next = { ...prev, [k]: mode };
      try {
        localStorage.setItem(PRINT_MODES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      void savePrintSheetState({ data: { customModes: next } });
      return next;
    });
    if (mode === "total_only" || mode === "hidden") {
      const cust = (activeDataSource?.customers ?? []).find((c) => normPrintKey(c.name) === k);
      if (cust && printedSnapshots[k]) {
        const nextSnaps = {
          ...printedSnapshots,
          [k]: buildCustomerSnapshot(cust),
        };
        saveSnapshots(nextSnaps);
      }
    }
  }

  function cycleCustomerMode(name: string) {
    const k = normPrintKey(name);
    const status = customerStatuses.get(k) ?? "unprinted";
    const current = modeForCustomer(name);
    const isCurrentlyOpen = current === "items" || status === "printed_added";
    const next: PrintCustomerMode = isCurrentlyOpen ? "total_only" : "items";
    setCustomerMode(name, next);
  }

  function setAllCustomerModes(mode: PrintCustomerMode | "default") {
    if (mode === "default") {
      setCustomModes({});
      try {
        localStorage.removeItem(PRINT_MODES_STORAGE_KEY);
      } catch {}
      void savePrintSheetState({ data: { customModes: {} } });
      return;
    }
    const next: Record<string, PrintCustomerMode> = {};
    for (const c of activeDataSource?.customers ?? []) {
      next[normPrintKey(c.name)] = mode;
    }
    setCustomModes(next);
    try {
      localStorage.setItem(PRINT_MODES_STORAGE_KEY, JSON.stringify(next));
    } catch {}
    void savePrintSheetState({ data: { customModes: next } });
  }

  // Apply removedProducts to each customer's rows and totalQuantity so removing an item
  // completely removes that line and recalculates the customer's total (and removes the customer if 0 left).
  const rawAllCustomers = activeDataSource?.customers ?? [];
  const allCustomers: LiveSheetCustomerOrder[] = useMemo(() => {
    return rawAllCustomers.map((c) => {
      const cKey = normPrintKey(c.name);
      const removedSet = new Set(removedProducts[cKey] ?? []);
      if (removedSet.size === 0) return c;
      const filteredRows = c.rows.filter(
        (r) => !removedSet.has(r.productName.trim().toLowerCase()),
      );
      const nextTotal =
        Math.round(
          filteredRows.reduce((sum, r) => sum + (r.quantity > 0 ? r.quantity : 0), 0) * 1000,
        ) / 1000;
      return {
        ...c,
        rows: filteredRows,
        totalQuantity: nextTotal,
      };
    });
  }, [rawAllCustomers, removedProducts]);

  // Customers whose orders were completely removed via individual product removal or "hidden" mode
  const manuallyRemovedCustomers = useMemo(() => {
    return rawAllCustomers.filter((rawC) => {
      if (rawC.totalQuantity <= 0) return false;
      const cKey = normPrintKey(rawC.name);
      if (modeForCustomer(rawC.name) === "hidden") return true;
      const afterC = allCustomers.find((x) => normPrintKey(x.name) === cKey);
      return afterC ? afterC.totalQuantity <= 0 : false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawAllCustomers, allCustomers, customModes]);

  const activeCustomers = useMemo(
    () =>
      allCustomers.filter((c) => {
        if (c.totalQuantity <= 0) return false;
        if (driverFilter !== "__all__" && c.driver !== driverFilter) return false;
        return true;
      }),
    [allCustomers, driverFilter],
  );

  // Classify every active customer into unprinted / printed_clean / printed_added
  const customerStatuses = useMemo(() => {
    const map = new Map<string, CustomerPrintStatus>();
    for (const c of activeCustomers) {
      const k = normPrintKey(c.name);
      map.set(k, getCustomerPrintStatus(c, printedSnapshots[k]));
    }
    return map;
  }, [activeCustomers, printedSnapshots]);

  const unprintedOrAddedCustomers = useMemo(
    () =>
      activeCustomers.filter((c) => {
        const st = customerStatuses.get(normPrintKey(c.name));
        return st === "unprinted" || st === "printed_added";
      }),
    [activeCustomers, customerStatuses],
  );

  const printedCleanCustomers = useMemo(
    () =>
      activeCustomers.filter(
        (c) => customerStatuses.get(normPrintKey(c.name)) === "printed_clean",
      ),
    [activeCustomers, customerStatuses],
  );

  const printedAddedCustomers = useMemo(
    () =>
      activeCustomers.filter(
        (c) => customerStatuses.get(normPrintKey(c.name)) === "printed_added",
      ),
    [activeCustomers, customerStatuses],
  );

  // Customers currently shown on the sheet based on viewFilter
  const sheetCustomers = useMemo(() => {
    const pool =
      viewFilter === "to_print"
        ? unprintedOrAddedCustomers
        : viewFilter === "printed_only"
        ? printedCleanCustomers
        : activeCustomers;
    return pool.filter((c) => modeForCustomer(c.name) !== "hidden");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewFilter,
    unprintedOrAddedCustomers,
    printedCleanCustomers,
    activeCustomers,
    customModes,
  ]);

  function buildUpdatedSnapshotsForList(
    custList: LiveSheetCustomerOrder[],
    base: Record<string, PrintedCustomerSnapshot> = printedSnapshots,
  ): Record<string, PrintedCustomerSnapshot> {
    const next = { ...base };
    const nowIso = new Date().toISOString();
    for (const c of custList) {
      next[normPrintKey(c.name)] = buildCustomerSnapshot(c, nowIso);
    }
    return next;
  }

  function markCustomersPrinted(custList: LiveSheetCustomerOrder[]) {
    if (!custList.length) return;
    const next = buildUpdatedSnapshotsForList(custList);
    saveSnapshots(next);
  }

  // Completely removes a customer from the Print Sheet (instead of collapsing to Total Only).
  // They stay removed across refreshes and overnight unless a new order is added to them or restored.
  function removeCustomerFromPrintSheet(customerName: string) {
    const targetKey = normPrintKey(customerName);
    const found =
      allCustomers.find((c) => normPrintKey(c.name) === targetKey) ??
      rawAllCustomers.find((c) => normPrintKey(c.name) === targetKey);
    if (!found) return;
    markCustomersPrinted([found]);
  }

  function restoreCustomerToPrintSheet(customerName: string) {
    const k = normPrintKey(customerName);
    const next = { ...printedSnapshots };
    delete next[k];
    saveSnapshots(next);
    restoreRemovedProductsForCustomer(customerName);
    if (customModes[k] === "hidden") {
      setCustomerMode(customerName, getDefaultPrintMode(customerName));
    }
  }

  function resetAllPrinted() {
    saveSnapshots({});
    saveRemovedProductsState({});
  }

  // Keep a ref to the current sheetCustomers + printedSnapshots so even if the
  // user prints via keyboard (Ctrl+P / Cmd+P) instead of clicking the button,
  // beforeprint/afterprint automatically persists and hides the printed customers!
  const sheetCustomersRef = useRef<LiveSheetCustomerOrder[]>(sheetCustomers);
  sheetCustomersRef.current = sheetCustomers;
  const printedSnapshotsRef = useRef<Record<string, PrintedCustomerSnapshot>>(printedSnapshots);
  printedSnapshotsRef.current = printedSnapshots;
  const pendingPrintSnapshotsRef = useRef<Record<string, PrintedCustomerSnapshot> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforePrint = () => {
      if (sheetCustomersRef.current.length > 0 && !pendingPrintSnapshotsRef.current) {
        const next = buildUpdatedSnapshotsForList(
          sheetCustomersRef.current,
          printedSnapshotsRef.current,
        );
        pendingPrintSnapshotsRef.current = next;
        // Persist immediately to localStorage + Supabase BEFORE the print dialog
        // even closes, so refreshing at any point never loses the printed state!
        persistSnapshotsOnly(next);
      }
    };
    const onAfterPrint = () => {
      if (pendingPrintSnapshotsRef.current) {
        const next = pendingPrintSnapshotsRef.current;
        pendingPrintSnapshotsRef.current = null;
        setPrintedSnapshots(next);
      }
    };
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePrintAndHide() {
    if (!sheetCustomers.length) return;
    const next = buildUpdatedSnapshotsForList(sheetCustomers, printedSnapshots);
    pendingPrintSnapshotsRef.current = next;
    // Persist immediately to localStorage AND Supabase before window.print()
    // so even if the user refreshes right away, the printed state is saved!
    persistSnapshotsOnly(next);
    window.print();
    // Apply to React state so the printed customers immediately move to "Printed & Hidden"
    pendingPrintSnapshotsRef.current = null;
    setPrintedSnapshots(next);
  }

  const driverOptions = useMemo(() => {
    const s = new Set<string>();
    for (const c of allCustomers) {
      if (c.driver?.trim()) s.add(c.driver.trim());
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [allCustomers]);

  // Build the flat sequence of PrintLines, grouped by Driver (with driver
  // subtotals like 66, 946, 105, 74) and sorted A-Z like the Google Sheet pivot.
  const printLines: PrintLine[] = useMemo(() => {
    const lines: PrintLine[] = [];

    const appendCustomerLines = (c: LiveSheetCustomerOrder) => {
      const k = normPrintKey(c.name);
      const status = customerStatuses.get(k) ?? "unprinted";
      const snap = printedSnapshots[k];
      const mode = modeForCustomer(c.name);
      const positiveRows = [...c.rows]
        .filter((r) => r.quantity > 0)
        .sort((a, b) => a.productName.localeCompare(b.productName));

      // If a customer was ALREADY printed and later ADDED a product, always
      // expand their product rows so the bakery can see what was printed & added.
      const showItems = mode === "items" || status === "printed_added";

      if (showItems) {
        positiveRows.forEach((r, idx) => {
          const pKey = r.productName.trim().toLowerCase();
          const prevQty = snap ? snap.items[pKey] ?? 0 : 0;
          const addedQty = snap ? r.quantity - prevQty : 0;
          lines.push({
            kind: "item",
            customerName: idx === 0 ? c.name : "",
            rawCustomerName: c.name,
            customerSlug: c.slug,
            productName: r.productName,
            quantity: r.quantity,
            driver: c.driver,
            printStatus: status,
            printedQty: snap ? prevQty : undefined,
            addedQty: snap ? addedQty : undefined,
          });
        });
      }

      const prevTotal = snap ? snap.totalQuantity : undefined;
      const addedTotal = snap ? c.totalQuantity - snap.totalQuantity : undefined;

      lines.push({
        kind: "customer_total",
        customerName: `${c.name} Total`,
        rawCustomerName: c.name,
        customerSlug: c.slug,
        productName: "",
        quantity: c.totalQuantity,
        driver: c.driver,
        printStatus: status,
        printedQty: prevTotal,
        addedQty: addedTotal,
      });
    };

    if (!groupByDriver) {
      const sorted = [...sheetCustomers].sort((a, b) => a.name.localeCompare(b.name));
      for (const c of sorted) appendCustomerLines(c);
      return lines;
    }

    const byDriver = new Map<string, LiveSheetCustomerOrder[]>();
    for (const c of sheetCustomers) {
      const d = c.driver || "Unassigned";
      const list = byDriver.get(d) ?? [];
      list.push(c);
      byDriver.set(d, list);
    }

    for (const [driver, groupCusts] of byDriver.entries()) {
      const sortedGroup = [...groupCusts].sort((a, b) => a.name.localeCompare(b.name));
      let groupTotal = 0;
      for (const c of sortedGroup) {
        appendCustomerLines(c);
        groupTotal += c.totalQuantity;
      }
      lines.push({
        kind: "driver_subtotal",
        customerName: "",
        productName: "",
        quantity: groupTotal,
        driver,
      });
    }

    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetCustomers, customerStatuses, printedSnapshots, customModes, groupByDriver]);

  // Split printLines into Left Column (A:C) and Right Column (E:G)
  const { leftLines, rightLines, rowCount } = useMemo(() => {
    const mid = Math.ceil(printLines.length / 2);
    const left = printLines.slice(0, mid);
    const right = printLines.slice(mid);
    return {
      leftLines: left,
      rightLines: right,
      rowCount: Math.max(left.length, right.length),
    };
  }, [printLines]);

  const filteredCustomizeCustomers = useMemo(() => {
    const q = customizeSearch.trim().toLowerCase();
    const base = allCustomers.filter((c) => c.totalQuantity > 0 || q.length > 0);
    if (!q) return base;
    return base.filter((c) => c.name.toLowerCase().includes(q) || c.driver.toLowerCase().includes(q));
  }, [allCustomers, customizeSearch]);

  return (
    <section className="space-y-3 print:space-y-0">
      {/* Print-specific @page rules, custom margins, and 100% scrollbar removal */}
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: ${marginTopBottomMm}mm ${marginLeftRightMm}mm;
          }
          html, body, #root, main, section, div {
            overflow: visible !important;
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
          }
          *::-webkit-scrollbar {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
          }
          body {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>

      {/* Screen-only toolbar */}
      <div className="bg-white rounded-2xl border border-[#e8dcc8] p-3.5 shadow-sm space-y-2.5 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-bold text-sm text-[#2a1810]">Print Sheet (A1:G38 Layout)</h2>
              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-[#c8362b]/10 text-[#c8362b]">
                {activeDataSource?.sheetLabel ?? liveQuery.data?.sheetLabel ?? "…"} ·{" "}
                {selectedPrintDate === "__live__"
                  ? liveQuery.data?.forDate ?? "Tomorrow"
                  : selectedPrintDate}
              </span>
              <span className="text-xs text-[#8b6f4e]">
                {sheetCustomers.length} customers · {rowCount} rows · {totalSheetWidthPx}px wide
              </span>
              {printedAddedCustomers.length > 0 && (
                <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                  ⚡ {printedAddedCustomers.length} Printed Customer{printedAddedCustomers.length === 1 ? "" : "s"} Added Items!
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePrintAndHide}
              disabled={printLines.length === 0}
              className="text-xs font-bold px-3.5 py-2 rounded-xl bg-[#c8362b] hover:bg-[#a82a22] text-white shadow-sm transition disabled:opacity-50"
              title="Print this sheet and mark these customers as Printed (removing them until they add new items)"
            >
              🖨️ Print & Hide Printed ({sheetCustomers.length})
            </button>

            <button
              type="button"
              onClick={() => markCustomersPrinted(sheetCustomers)}
              disabled={sheetCustomers.length === 0}
              className="text-xs font-bold px-3 py-2 rounded-xl border border-green-700 text-green-800 bg-green-50 hover:bg-green-100 transition disabled:opacity-50"
            >
              ✓ Mark Printed
            </button>

            <button
              type="button"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ["live-sheet-orders"] });
                if (selectedPrintDate !== "__live__") {
                  void qc.invalidateQueries({ queryKey: ["print-sheet-for-date", selectedPrintDate] });
                }
              }}
              disabled={isFetchingSource}
              className="text-xs font-bold px-3 py-2 rounded-xl border border-[#2a1810] hover:bg-[#2a1810] hover:text-white transition"
            >
              {isFetchingSource ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>
        </div>

        {/* Delivery Date / Saved Orders Switcher (solves printing after the Google Sheet clears for the next day) */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#e8dcc8] bg-[#fdf8f1]/60 rounded-xl px-2.5 py-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-bold text-[#2a1810]">📅 Delivery Sheet:</span>
            <button
              type="button"
              onClick={() => setSelectedPrintDate("__live__")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                selectedPrintDate === "__live__"
                  ? "bg-[#c8362b] text-white shadow-sm"
                  : "bg-white border border-[#e8dcc8] text-[#6b5544] hover:bg-[#e8dcc8]/40"
              }`}
            >
              🟢 Live Sheet ({liveQuery.data?.forDate ?? "Tomorrow"})
            </button>
            {liveQuery.data?.todayDate && (
              <button
                type="button"
                onClick={() => setSelectedPrintDate(liveQuery.data!.todayDate)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                  selectedPrintDate === liveQuery.data.todayDate
                    ? "bg-[#2a1810] text-white shadow-sm"
                    : "bg-white border border-[#e8dcc8] text-[#2a1810] hover:bg-[#e8dcc8]/40"
                }`}
                title="Load Today's Delivery orders from saved snapshots & submissions — works even after the Google Sheet clears for the next day!"
              >
                📦 Today's Delivery ({liveQuery.data.todayDate} — Saved Orders)
              </button>
            )}
            {liveQuery.data?.forDate && (
              <button
                type="button"
                onClick={() => setSelectedPrintDate(liveQuery.data!.forDate)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                  selectedPrintDate === liveQuery.data.forDate
                    ? "bg-[#2a1810] text-white shadow-sm"
                    : "bg-white border border-[#e8dcc8] text-[#6b5544] hover:bg-[#e8dcc8]/40"
                }`}
                title="Load Tomorrow's Delivery orders from saved snapshots + submissions even if the Google Sheet was cleared early"
              >
                💾 Tomorrow Saved ({liveQuery.data.forDate})
              </button>
            )}
            <label className="flex items-center gap-1 text-xs font-semibold text-[#6b5544] bg-white border border-[#e8dcc8] rounded-lg px-2 py-0.5">
              <span>Other Date:</span>
              <input
                type="date"
                value={
                  selectedPrintDate === "__live__"
                    ? liveQuery.data?.forDate ?? ""
                    : selectedPrintDate
                }
                onChange={(e) => {
                  if (e.target.value) setSelectedPrintDate(e.target.value);
                }}
                className="text-xs font-bold text-[#2a1810] bg-transparent focus:outline-none"
              />
            </label>
          </div>
          <span className="text-[11px] text-[#8b6f4e]">
            💡 Click any customer or <b>✕</b> on a row to completely remove it from the Print Sheet
          </span>
        </div>

        {/* Filter & Layout Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#e8dcc8]">
          <div className="flex flex-wrap gap-1 bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl p-1">
            <button
              type="button"
              onClick={() => setViewFilter("to_print")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                viewFilter === "to_print" ? "bg-[#c8362b] text-white" : "text-[#6b5544]"
              }`}
            >
              To Print & Added ({unprintedOrAddedCustomers.length})
            </button>
            <button
              type="button"
              onClick={() => setViewFilter("all_highlight")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                viewFilter === "all_highlight" ? "bg-[#c8362b] text-white" : "text-[#6b5544]"
              }`}
            >
              Show All — Highlight Printed ({activeCustomers.length})
            </button>
            <button
              type="button"
              onClick={() => setViewFilter("printed_only")}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                viewFilter === "printed_only" ? "bg-green-700 text-white" : "text-green-800"
              }`}
            >
              ✓ Printed / Removed ({printedCleanCustomers.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
              className="bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl px-2.5 py-1 text-xs font-semibold focus:outline-none focus:border-[#c8362b]"
            >
              <option value="__all__">All drivers</option>
              {driverOptions.map((d) => (
                <option key={d} value={d}>
                  Driver: {d}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-1.5 text-xs font-semibold text-[#6b5544] px-2.5 py-1 rounded-xl border border-[#e8dcc8] bg-[#fdf8f1] cursor-pointer">
              <input
                type="checkbox"
                checked={groupByDriver}
                onChange={(e) => setGroupByDriver(e.target.checked)}
              />
              Driver subtotals
            </label>

            <button
              type="button"
              onClick={() => setShowLayoutControls((s) => !s)}
              className={`text-xs font-bold px-2.5 py-1 rounded-xl border transition ${
                showLayoutControls
                  ? "bg-[#2a1810] text-white border-[#2a1810]"
                  : "border-[#e8dcc8] hover:bg-[#fdf8f1]"
              }`}
            >
              📐 Columns & Margins
            </button>

            <button
              type="button"
              onClick={() => setShowCustomize((s) => !s)}
              className="text-xs font-bold px-2.5 py-1 rounded-xl border border-[#e8dcc8] hover:bg-[#fdf8f1]"
            >
              {showCustomize ? "Hide Toggles" : "⚙️ Customers"}
            </button>
          </div>
        </div>

        {/* Interactive Column Width, Row Height, Font Size & Margin Controls */}
        {showLayoutControls && (
          <div className="pt-2.5 border-t border-[#e8dcc8] bg-[#fdf8f1]/70 rounded-xl p-3 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold text-[#2a1810]">
                📐 Resize Columns & Print Margins{" "}
                <span className="font-normal text-[#8b6f4e]">
                  (you can also drag the column borders between A..G directly on the sheet below)
                </span>
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-[#6b5544] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={linkLeftRightCols}
                    onChange={(e) => updateLayout({ linkLeftRightCols: e.target.checked })}
                  />
                  Mirror Left & Right Columns (A=E, B=F, C=G)
                </label>
                <button
                  type="button"
                  onClick={() => updateLayout(DEFAULT_PRINT_LAYOUT)}
                  className="text-xs font-bold px-2.5 py-1 rounded-lg border border-[#e8dcc8] bg-white hover:bg-[#e8dcc8]/40"
                >
                  ↺ Reset Sizes
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5 text-xs">
              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Customer (A/E)</span>
                  <span className="font-bold text-[#2a1810]">{colWidths[0]}px</span>
                </div>
                <input
                  type="range"
                  min={80}
                  max={320}
                  value={colWidths[0]}
                  onChange={(e) => setColWidth(0, parseInt(e.target.value, 10))}
                  className="w-full accent-[#c8362b]"
                />
              </label>

              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Product (B/F)</span>
                  <span className="font-bold text-[#2a1810]">{colWidths[1]}px</span>
                </div>
                <input
                  type="range"
                  min={80}
                  max={320}
                  value={colWidths[1]}
                  onChange={(e) => setColWidth(1, parseInt(e.target.value, 10))}
                  className="w-full accent-[#c8362b]"
                />
              </label>

              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Qty (C/G)</span>
                  <span className="font-bold text-[#2a1810]">{colWidths[2]}px</span>
                </div>
                <input
                  type="range"
                  min={26}
                  max={100}
                  value={colWidths[2]}
                  onChange={(e) => setColWidth(2, parseInt(e.target.value, 10))}
                  className="w-full accent-[#c8362b]"
                />
              </label>

              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Divider (D)</span>
                  <span className="font-bold text-[#2a1810]">{colWidths[3]}px</span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={40}
                  value={colWidths[3]}
                  onChange={(e) => setColWidth(3, parseInt(e.target.value, 10))}
                  className="w-full accent-[#c8362b]"
                />
              </label>

              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Font / Row</span>
                  <span className="font-bold text-[#2a1810]">
                    {fontSizePx}px / {rowHeightPx}px
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={10}
                    max={22}
                    value={fontSizePx}
                    onChange={(e) =>
                      updateLayout({
                        fontSizePx: Math.max(10, Math.min(22, parseInt(e.target.value || "14", 10))),
                      })
                    }
                    className="w-1/2 border border-[#e8dcc8] rounded px-1.5 py-0.5 text-center font-bold"
                    title="Font size (px)"
                  />
                  <input
                    type="number"
                    min={16}
                    max={36}
                    value={rowHeightPx}
                    onChange={(e) =>
                      updateLayout({
                        rowHeightPx: Math.max(16, Math.min(36, parseInt(e.target.value || "20", 10))),
                      })
                    }
                    className="w-1/2 border border-[#e8dcc8] rounded px-1.5 py-0.5 text-center font-bold"
                    title="Row height (px)"
                  />
                </div>
              </label>

              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Top/Bot Margin</span>
                  <span className="font-bold text-[#2a1810]">{marginTopBottomMm}mm</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={25}
                  value={marginTopBottomMm}
                  onChange={(e) =>
                    updateLayout({ marginTopBottomMm: parseInt(e.target.value, 10) })
                  }
                  className="w-full accent-[#c8362b]"
                />
              </label>

              <label className="bg-white border border-[#e8dcc8] rounded-lg p-2 flex flex-col gap-1">
                <div className="flex justify-between font-semibold text-[#6b5544]">
                  <span>Left/Right Margin</span>
                  <span className="font-bold text-[#2a1810]">{marginLeftRightMm}mm</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={25}
                  value={marginLeftRightMm}
                  onChange={(e) =>
                    updateLayout({ marginLeftRightMm: parseInt(e.target.value, 10) })
                  }
                  className="w-full accent-[#c8362b]"
                />
              </label>
            </div>
          </div>
        )}

        {/* Printed & Removed Customers / Products Bar */}
        {(Object.keys(printedSnapshots).length > 0 ||
          Object.keys(removedProducts).length > 0 ||
          manuallyRemovedCustomers.length > 0) && (
          <div className="pt-2 border-t border-[#e8dcc8] flex flex-wrap items-center justify-between gap-2 bg-green-50/60 p-2 rounded-xl">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold text-green-900">
                ✓ Printed / Removed ({printedCleanCustomers.length + manuallyRemovedCustomers.length}):
              </span>
              {printedCleanCustomers.length === 0 &&
              manuallyRemovedCustomers.length === 0 &&
              Object.keys(removedProducts).length === 0 ? (
                <span className="text-xs text-green-700">None currently removed</span>
              ) : (
                <>
                  {printedCleanCustomers.map((c) => (
                    <button
                      key={`printed-${c.slug}`}
                      type="button"
                      onClick={() => restoreCustomerToPrintSheet(c.name)}
                      title="Click to restore this customer back onto the print sheet"
                      className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-200/80 text-green-900 hover:bg-red-100 hover:text-red-800 transition"
                    >
                      ✓ {c.name} ({c.totalQuantity}) ↺
                    </button>
                  ))}
                  {manuallyRemovedCustomers.map((c) => (
                    <button
                      key={`removed-${c.slug}`}
                      type="button"
                      onClick={() => restoreCustomerToPrintSheet(c.name)}
                      title="Click to restore this removed customer back onto the print sheet"
                      className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-200/80 text-amber-900 hover:bg-green-100 hover:text-green-800 transition"
                    >
                      ✕ {c.name} ({c.totalQuantity}) ↺
                    </button>
                  ))}
                  {Object.entries(removedProducts).map(([cKey, prodList]) => {
                    if (!prodList.length) return null;
                    const matchCust = rawAllCustomers.find((x) => normPrintKey(x.name) === cKey);
                    // Skip if already listed in manuallyRemovedCustomers
                    if (
                      matchCust &&
                      manuallyRemovedCustomers.some((m) => normPrintKey(m.name) === cKey)
                    ) {
                      return null;
                    }
                    const label = matchCust?.name ?? cKey;
                    return (
                      <button
                        key={`remprod-${cKey}`}
                        type="button"
                        onClick={() => restoreRemovedProductsForCustomer(label)}
                        title={`Restore removed items for ${label}: ${prodList.join(", ")}`}
                        className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 hover:bg-green-100 transition"
                      >
                        ✕ {label}: {prodList.length} item{prodList.length === 1 ? "" : "s"} removed ↺
                      </button>
                    );
                  })}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={resetAllPrinted}
              className="text-xs font-bold px-2.5 py-1 rounded-lg border border-green-700 text-green-900 hover:bg-green-200 shrink-0"
            >
              ↺ Restore All Printed / Removed
            </button>
          </div>
        )}

        {showCustomize && (
          <div className="pt-3 border-t border-[#e8dcc8] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <input
                value={customizeSearch}
                onChange={(e) => setCustomizeSearch(e.target.value)}
                placeholder="Search customer to Remove / Expand / Collapse…"
                className="flex-1 min-w-[220px] bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-[#c8362b]"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAllCustomerModes("items")}
                  className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
                >
                  Expand All (Items + Total)
                </button>
                <button
                  type="button"
                  onClick={() => setAllCustomerModes("total_only")}
                  className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
                >
                  Collapse All (Totals Only)
                </button>
                <button
                  type="button"
                  onClick={() => setAllCustomerModes("default")}
                  className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-[#e8dcc8] hover:bg-[#fdf8f1]"
                >
                  Reset to Default Layout
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-56 overflow-y-auto p-1">
              {filteredCustomizeCustomers.map((c) => {
                const m = modeForCustomer(c.name);
                return (
                  <div
                    key={c.slug}
                    className="flex items-center justify-between gap-2 p-2 rounded-xl border border-[#e8dcc8] bg-[#fdf8f1]/50 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{c.name}</div>
                      <div className="text-[10px] text-[#8b6f4e]">
                        {c.driver} · {c.totalQuantity} items
                      </div>
                    </div>
                    <select
                      value={m}
                      onChange={(e) => setCustomerMode(c.name, e.target.value as PrintCustomerMode)}
                      className="border border-[#e8dcc8] rounded-lg px-2 py-1 text-[11px] font-bold bg-white"
                    >
                      <option value="items">Items + Total</option>
                      <option value="total_only">Total Only</option>
                      <option value="hidden">Completely Remove</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Exact Google Sheets 'print sheet' A1:G38 Grid (No dark right column H, no print scrollbars) */}
      <div className="bg-white rounded-xl border border-[#c0c0c0] shadow-sm p-2 print:border-0 print:shadow-none print:p-0 print:rounded-none overflow-x-auto print:overflow-visible">
        {isLoadingSource ? (
          <div className="p-8 text-center text-sm text-[#8b6f4e]">
            Loading orders for Print Sheet…
          </div>
        ) : rowCount === 0 ? (
          <div className="p-8 text-center text-sm text-[#8b6f4e] space-y-3">
            <p>
              {viewFilter === "to_print" && printedCleanCustomers.length > 0
                ? `All ${printedCleanCustomers.length} active customer orders on this sheet have already been printed / removed!`
                : `No orders with quantity > 0 match this view on the ${
                    activeDataSource?.sheetLabel ?? "active"
                  } sheet.`}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {viewFilter === "to_print" && printedCleanCustomers.length > 0 && (
                <button
                  type="button"
                  onClick={() => setViewFilter("all_highlight")}
                  className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#c8362b] text-white"
                >
                  Show All ({activeCustomers.length}) with Printed Highlighted
                </button>
              )}
              {selectedPrintDate === "__live__" && liveQuery.data?.todayDate && (
                <button
                  type="button"
                  onClick={() => setSelectedPrintDate(liveQuery.data!.todayDate)}
                  className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#2a1810] text-white"
                >
                  📦 Did the Google Sheet clear for the next day? Load Today's Delivery ({liveQuery.data.todayDate})
                </button>
              )}
              {selectedPrintDate === "__live__" && liveQuery.data?.forDate && (
                <button
                  type="button"
                  onClick={() => setSelectedPrintDate(liveQuery.data!.forDate)}
                  className="text-xs font-bold px-3 py-1.5 rounded-lg border border-[#2a1810] text-[#2a1810]"
                >
                  💾 Load Tomorrow's Saved Orders ({liveQuery.data.forDate})
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="inline-block print:block">
            <table
              style={{
                fontFamily: 'Calibri, "Carlito", "Segoe UI", Arial, sans-serif',
                fontSize: `${fontSizePx}px`,
                fontWeight: 400,
                lineHeight: `${Math.max(14, rowHeightPx - 2)}px`,
                tableLayout: "fixed",
                width: `${totalSheetWidthPx}px`,
                borderCollapse: "collapse",
              }}
            >
              <colgroup>
                {/* Screen-only row index column */}
                <col className="print:hidden" style={{ width: "28px" }} />
                {/* Col A: Left Customer */}
                <col style={{ width: `${colWidths[0]}px` }} />
                {/* Col B: Left Product */}
                <col style={{ width: `${colWidths[1]}px` }} />
                {/* Col C: Left Qty */}
                <col style={{ width: `${colWidths[2]}px` }} />
                {/* Col D: Center divider */}
                <col style={{ width: `${colWidths[3]}px` }} />
                {/* Col E: Right Customer */}
                <col style={{ width: `${colWidths[4]}px` }} />
                {/* Col F: Right Product */}
                <col style={{ width: `${colWidths[5]}px` }} />
                {/* Col G: Right Qty */}
                <col style={{ width: `${colWidths[6]}px` }} />
              </colgroup>
              {/* Screen-only Google Sheets A..G header bar with drag-to-resize handles */}
              <thead className="print:hidden">
                <tr style={{ height: "20px" }} className="bg-[#f8f9fa] text-[#5f6368] text-[11px] select-none">
                  <th className="border border-[#c0c0c0] font-normal text-center" />
                  {(["A", "B", "C", "D", "E", "F", "G"] as const).map((letter, cIdx) => (
                    <th
                      key={letter}
                      className="border border-[#c0c0c0] font-normal text-center relative group"
                      title={`Drag right edge to resize Column ${letter} (${colWidths[cIdx]}px)`}
                    >
                      <span>{letter}</span>
                      <div
                        onMouseDown={(e) => startColResize(cIdx, e)}
                        className="absolute top-0 right-0 h-full w-2 cursor-col-resize hover:bg-[#1a73e8] z-10"
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rowCount }).map((_, idx) => {
                  const left = leftLines[idx];
                  const right = rightLines[idx];
                  return (
                    <tr key={idx} style={{ height: `${rowHeightPx}px` }}>
                      <td
                        className="print:hidden border border-[#c0c0c0] bg-[#f8f9fa] text-[#5f6368] text-[11px] text-center select-none"
                        style={{ padding: 0, lineHeight: `${Math.max(14, rowHeightPx - 2)}px` }}
                      >
                        {idx + 1}
                      </td>
                      <PrintHalfRowCells
                        line={left}
                        fontSizePx={fontSizePx}
                        rowHeightPx={rowHeightPx}
                        custColWidth={colWidths[0]}
                        prodColWidth={colWidths[1]}
                        onToggleCustomer={cycleCustomerMode}
                        onRemoveCustomer={removeCustomerFromPrintSheet}
                        onRemoveProduct={removeSingleProductFromPrint}
                      />
                      <td
                        style={{
                          backgroundColor: "#434343",
                          borderTop: "1px solid #333333",
                          borderBottom: "1px solid #333333",
                          padding: 0,
                        }}
                      />
                      <PrintHalfRowCells
                        line={right}
                        fontSizePx={fontSizePx}
                        rowHeightPx={rowHeightPx}
                        custColWidth={colWidths[4]}
                        prodColWidth={colWidths[5]}
                        onToggleCustomer={cycleCustomerMode}
                        onRemoveCustomer={removeCustomerFromPrintSheet}
                        onRemoveProduct={removeSingleProductFromPrint}
                      />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function fitCellFontSize(text: string, basePx: number, colWidthPx: number): string {
  const approxCharWidth = basePx * 0.52;
  const maxChars = Math.max(8, Math.floor((colWidthPx - 8) / approxCharWidth));
  if (text.length > maxChars + 6) return `${Math.max(10, basePx - 2.5)}px`;
  if (text.length > maxChars) return `${Math.max(11, basePx - 1.5)}px`;
  return `${basePx}px`;
}

function PrintHalfRowCells({
  line,
  fontSizePx,
  rowHeightPx,
  custColWidth,
  prodColWidth,
  onToggleCustomer,
  onRemoveCustomer,
  onRemoveProduct,
}: {
  line: PrintLine | undefined;
  fontSizePx: number;
  rowHeightPx: number;
  custColWidth: number;
  prodColWidth: number;
  onToggleCustomer: (rawCustomerName: string) => void;
  onRemoveCustomer?: (rawCustomerName: string) => void;
  onRemoveProduct?: (rawCustomerName: string, productName: string) => void;
}) {
  const baseCellStyle: React.CSSProperties = {
    padding: "0px 4px",
    height: `${rowHeightPx}px`,
    lineHeight: `${Math.max(14, rowHeightPx - 1)}px`,
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontWeight: 400,
    color: "#000000",
  };

  if (!line) {
    return (
      <>
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: "#dfe8f3",
            border: "1px solid #9e9e9e",
          }}
        />
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: "#ffffff",
            border: "1px solid #b7b7b7",
          }}
        />
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: "#ffffff",
            border: "1px solid #b7b7b7",
          }}
        />
      </>
    );
  }

  // Driver subtotal line: Blank Col A, Blank Col B, Subtotal in Col C (all #dfe8f3 blue-grey)
  if (line.kind === "driver_subtotal") {
    return (
      <>
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: "#dfe8f3",
            borderTop: "1px solid #434343",
            borderBottom: "1px solid #434343",
            borderLeft: "1px solid #434343",
            borderRight: "1px solid #9e9e9e",
          }}
        />
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: "#dfe8f3",
            borderTop: "1px solid #434343",
            borderBottom: "1px solid #434343",
            borderLeft: "1px solid #9e9e9e",
            borderRight: "1px solid #9e9e9e",
          }}
        />
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: "#dfe8f3",
            borderTop: "1px solid #434343",
            borderBottom: "1px solid #434343",
            borderLeft: "1px solid #9e9e9e",
            borderRight: "1px solid #434343",
            textAlign: "left",
          }}
        >
          {line.quantity}
        </td>
      </>
    );
  }

  const isPrintedClean = line.printStatus === "printed_clean";
  const isPrintedAdded = line.printStatus === "printed_added";

  // Customer Total row: "[Customer] Total" spanning Col A+B, Qty in Col C
  if (line.kind === "customer_total") {
    const baseName = line.rawCustomerName ?? line.customerName.replace(/\s+Total$/i, "");
    const rowBg = isPrintedClean
      ? "#d9ead3"
      : isPrintedAdded
      ? "#fff2cc"
      : "#dfe8f3";

    const labelText =
      isPrintedAdded && line.printedQty !== undefined && line.addedQty !== undefined
        ? `${line.customerName} (P:${line.printedQty} +${line.addedQty})`
        : isPrintedClean
        ? `${line.customerName} ✓`
        : line.customerName;

    return (
      <>
        <td
          onClick={() => (onRemoveCustomer ? onRemoveCustomer(baseName) : onToggleCustomer(baseName))}
          title="Click to completely remove this customer from the Print Sheet (or use ↕ to collapse/expand)"
          colSpan={2}
          className="group relative"
          style={{
            ...baseCellStyle,
            fontSize: fitCellFontSize(labelText, fontSizePx, custColWidth + prodColWidth),
            backgroundColor: rowBg,
            borderTop: "1px solid #434343",
            borderBottom: "1px solid #434343",
            borderLeft: "1px solid #434343",
            borderRight: "1px solid #9e9e9e",
            cursor: "pointer",
          }}
        >
          <span>{labelText}</span>
          <div className="print:hidden opacity-0 group-hover:opacity-100 transition-opacity absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCustomer(baseName);
              }}
              title="Collapse / Expand items (Total Only vs Items)"
              className="px-1 py-0 rounded bg-slate-700 text-white text-[10px] leading-tight font-bold"
            >
              ↕
            </button>
            {!isPrintedClean && onRemoveCustomer && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveCustomer(baseName);
                }}
                title="Completely remove this customer from the Print Sheet"
                className="px-1.5 py-0 rounded bg-[#c8362b] text-white text-[10px] leading-tight font-bold"
              >
                ✕ Remove
              </button>
            )}
          </div>
        </td>
        <td
          style={{
            ...baseCellStyle,
            backgroundColor: rowBg,
            borderTop: "1px solid #434343",
            borderBottom: "1px solid #434343",
            borderLeft: "1px solid #9e9e9e",
            borderRight: "1px solid #434343",
            textAlign: "left",
          }}
        >
          {line.quantity}
        </td>
      </>
    );
  }

  // Regular item row
  const custBg = isPrintedClean
    ? "#d9ead3"
    : isPrintedAdded
    ? "#fff2cc"
    : "#dfe8f3";

  const itemBg = isPrintedClean
    ? "#eef7eb"
    : isPrintedAdded && (line.addedQty ?? 0) > 0
    ? "#fff9e6"
    : "#ffffff";

  let prodLabel = line.productName;
  if (isPrintedAdded && line.printedQty !== undefined) {
    if (line.printedQty > 0 && (line.addedQty ?? 0) > 0) {
      prodLabel = `${line.productName} (P:${line.printedQty}+${line.addedQty})`;
    } else if (line.printedQty === 0 && (line.addedQty ?? 0) > 0) {
      prodLabel = `${line.productName} (+${line.addedQty} NEW)`;
    }
  }

  return (
    <>
      <td
        onClick={() =>
          line.rawCustomerName &&
          (onRemoveCustomer
            ? onRemoveCustomer(line.rawCustomerName)
            : onToggleCustomer(line.rawCustomerName))
        }
        title={
          line.customerName
            ? `Click to completely remove ${line.rawCustomerName} from the Print Sheet`
            : undefined
        }
        className="group relative"
        style={{
          ...baseCellStyle,
          fontSize: fitCellFontSize(line.customerName, fontSizePx, custColWidth),
          backgroundColor: custBg,
          borderTop: line.customerName ? "1px solid #434343" : "1px solid #9e9e9e",
          borderBottom: "1px solid #9e9e9e",
          borderLeft: "1px solid #434343",
          borderRight: "1px solid #9e9e9e",
          cursor: line.customerName ? "pointer" : "default",
        }}
      >
        <span>{line.customerName}</span>
        {line.customerName && line.rawCustomerName && onRemoveCustomer && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveCustomer(line.rawCustomerName!);
            }}
            title={`Completely remove ${line.rawCustomerName} from the Print Sheet`}
            className="print:hidden opacity-0 group-hover:opacity-100 transition-opacity absolute right-1 top-1/2 -translate-y-1/2 px-1 py-0 rounded bg-[#c8362b] text-white text-[10px] leading-tight font-bold"
          >
            ✕
          </button>
        )}
      </td>
      <td
        className="group relative"
        style={{
          ...baseCellStyle,
          fontSize: fitCellFontSize(prodLabel, fontSizePx, prodColWidth),
          backgroundColor: itemBg,
          border: "1px solid #b7b7b7",
        }}
      >
        <span>{prodLabel}</span>
        {line.rawCustomerName && onRemoveProduct && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveProduct(line.rawCustomerName!, line.productName);
            }}
            title={`Remove only "${line.productName}" from ${line.rawCustomerName}'s print order`}
            className="print:hidden opacity-0 group-hover:opacity-100 transition-opacity absolute right-1 top-1/2 -translate-y-1/2 px-1 py-0 rounded bg-[#c8362b] text-white text-[10px] leading-tight font-bold"
          >
            ✕
          </button>
        )}
      </td>
      <td
        style={{
          ...baseCellStyle,
          backgroundColor: itemBg,
          border: "1px solid #b7b7b7",
          textAlign: "left",
        }}
      >
        {line.quantity}
      </td>
    </>
  );
}

