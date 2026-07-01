import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo, useEffect } from "react";
import { useSuspenseQuery, useQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line,
} from "recharts";
import {
  listCustomers, listSubmissions, syncFromSheet, analyticsOverview, ensureSeeded,
  getSubmissionDetail, getEstimateProducts, saveEstimates, getProductStocks, saveProductStocks,
  getActiveSheetInfo, getDriverAssignments, saveCustomerDriver,
} from "@/lib/bakery.functions";

const customersQuery = queryOptions({ queryKey: ["customers"], queryFn: () => listCustomers() });
const submissionsQuery = queryOptions({ queryKey: ["submissions"], queryFn: () => listSubmissions({ data: {} }) });
const analyticsQuery = queryOptions({ queryKey: ["analytics"], queryFn: () => analyticsOverview() });
const sheetInfoQuery = queryOptions({ queryKey: ["sheet-info"], queryFn: () => getActiveSheetInfo() });

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin · Portugal Bakery" }] }),
  loader: async ({ context }) => {
    // Auto-seed if empty — runs once, no-op afterwards
    try { await ensureSeeded(); } catch (_) {}
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
type AdminTab = "customers" | "history" | "analytics" | "estimates" | "stocks" | "drivers";

function bucketKey(dateStr: string, bucket: Bucket) {
  const d = new Date(dateStr + "T00:00:00");
  if (bucket === "day") return dateStr;
  if (bucket === "month") return dateStr.slice(0, 7);
  // week: ISO-ish, Monday start
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
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
    default:
      return { label: "New Order", className: "bg-green-100 text-green-800" };
  }
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

  const [tab, setTab] = useState<AdminTab>("customers");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [dim, setDim] = useState<Dim>("items");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getSubmissionDetail>> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function openDetail(id: string) {
    setDetailId(id); setDetail(null); setDetailLoading(true);
    try {
      const d = await getSubmissionDetail({ data: { id } });
      setDetail(d);
    } finally {
      setDetailLoading(false);
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

  const filteredCustomers = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(s));
  }, [search, customers]);

  // Group submissions by created_at date (local) — same grouping as the
  // customer-facing HistoryModal, just across all customers.
  const historyGroups = useMemo(() => {
    const m = new Map<string, typeof submissions>();
    for (const s of submissions) {
      const key = new Date(s.created_at).toISOString().slice(0, 10);
      const arr = m.get(key) ?? [];
      arr.push(s);
      m.set(key, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [submissions]);

  async function handleSync() {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await syncFromSheet();
      setSyncMsg(`Synced ${r.customers} customers, ${r.products} products, ${r.mappings} rows from ${sheetInfo?.label ?? "sheet"}.`);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    } catch (e) {
      setSyncMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  // Build time-series chart data based on bucket + dimension
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

  return (
    <div className="min-h-screen bg-[#fdf8f1] text-[#2a1810]">
      <header className="bg-white border-b border-[#e8dcc8]">
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
          <div className="flex gap-2">
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
          </div>
        </div>
        {syncMsg && (
          <div className="max-w-6xl mx-auto px-6 pb-3 text-sm text-[#6b5544]">{syncMsg}</div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <section className="grid grid-cols-3 gap-3">
          {[
            { label: "Customers", value: customers.length },
            { label: "Orders logged", value: submissions.length },
            { label: "Sheet", value: sheetInfo ? `✓ ${sheetInfo.label}` : "✓ Connected" },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-2xl border border-[#e8dcc8] p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wider text-[#8b6f4e] font-semibold">{s.label}</div>
              <div className="text-xl font-bold mt-1">{s.value}</div>
            </div>
          ))}
        </section>

        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1 w-fit flex-wrap">
          {/* "drivers" temporarily hidden — DriversTab is still defined below, just not linked in the nav */}
          {(["customers", "history", "analytics", "estimates", "stocks"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${tab === t ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}>
              {t === "customers" ? "Customers" : t === "history" ? "Order History" : t === "analytics" ? "Analytics" : t === "estimates" ? "Estimates" : "Stocks"}
            </button>
          ))}
        </div>

        {tab === "customers" && (
          <section className="space-y-3">
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customers…"
              className="w-full bg-white border border-[#e8dcc8] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#c8362b]" />
            <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
              {filteredCustomers.length === 0 && (
                <div className="p-6 text-center text-sm text-[#8b6f4e]">No customers yet — data will load automatically from your sheet.</div>
              )}
              {filteredCustomers.map((c) => (
                <div key={c.id} className="p-3 flex items-center justify-between hover:bg-[#fdf8f1]">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{c.name}</div>
                    <div className="text-xs text-[#8b6f4e] truncate">/order/{c.slug}{c.driver ? ` · ${c.driver}` : ""}</div>
                  </div>
                  <Link to="/order/$slug" params={{ slug: c.slug }}
                    className="text-sm px-3 py-1.5 rounded-lg border border-[#e8dcc8] hover:bg-white">Open</Link>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "history" && (
          <section className="space-y-5">
            {historyGroups.length === 0 && (
              <div className="bg-white rounded-2xl border border-[#e8dcc8] p-6 text-center text-sm text-[#8b6f4e] shadow-sm">
                No orders submitted yet.
              </div>
            )}
            {historyGroups.map(([day, subs]) => (
              <div key={day}>
                <h4 className="font-bold text-sm text-[#2a1810] mb-2">{dateLabel(day)}</h4>
                <div className="space-y-3">
                  {subs.map((s) => {
                    const tag = orderTypeTag(s.order_type);
                    return (
                      <button
                        key={s.id}
                        onClick={() => openDetail(s.id)}
                        className="w-full text-left border border-[#e8dcc8] bg-white rounded-xl p-3 shadow-sm hover:bg-[#fdf8f1]"
                      >
                        <div className="flex items-center justify-between mb-1 gap-2">
                          <div className="font-semibold text-sm truncate">{s.customer?.name ?? "—"}</div>
                          <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${tag.className}`}>
                            {tag.label}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-[#8b6f4e]">
                          <span>For {s.for_date} · {s.total_items} items · {new Date(s.created_at).toLocaleString()}</span>
                          <span className="text-[#c8362b] font-semibold shrink-0">View →</span>
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
                    <XAxis dataKey="key" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} domain={[0, "auto"]} />
                    <Tooltip />
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
        {/* {tab === "drivers" && <DriversTab />} — hidden for now */}
      </main>

      {detailId && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setDetailId(null)}>
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[85vh] overflow-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[#e8dcc8] sticky top-0 bg-white">
              <h3 className="font-bold">Order details</h3>
              <button onClick={() => setDetailId(null)} className="text-2xl leading-none text-[#8b6f4e]">×</button>
            </div>
            <div className="p-4">
              {detailLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
              {detail && (
                <>
                  <div className="mb-3">
                    <div className="font-bold">{detail.customer?.name ?? "—"}</div>
                    <div className="text-xs text-[#8b6f4e]">
                      For {detail.for_date} · {detail.total_items} items · {new Date(detail.created_at).toLocaleString()}
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
              )}
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

  // Filled-in products (using the LIVE value, so it reacts as you type) sort
  // to the top and stay there — alphabetical within each group — so you
  // never have to scroll to find something you just filled in, even with
  // "Show all products" on.
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items
      .filter((p) => {
        if (s && !p.name.toLowerCase().includes(s)) return false;
        const current = valueFor(p.id, p.quantity);
        if (anyHasValue && !showAll && current <= 0) return false;
        return true;
      })
      .sort((a, b) => {
        const aFilled = valueFor(a.id, a.quantity) > 0 ? 0 : 1;
        const bFilled = valueFor(b.id, b.quantity) > 0 ? 0 : 1;
        if (aFilled !== bFilled) return aFilled - bFilled;
        return a.name.localeCompare(b.name);
      });
  }, [items, search, showAll, anyHasValue, edits]);

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
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1">
          {(["Production", "Freezer"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${section === s ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          className="flex-1 min-w-[180px] bg-white border border-[#e8dcc8] rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-[#c8362b]"
        />
        <label className="flex items-center gap-2 text-xs font-semibold text-[#6b5544] shrink-0">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all products
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
      {query.isError && <p className="text-sm text-red-700">Failed to load: {(query.error as Error).message}</p>}

      <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
        {filtered.length === 0 && !query.isLoading && (
          <div className="p-6 text-center text-sm text-[#8b6f4e]">
            {anyHasValue ? 'No products match. Toggle "Show all products" to see everything.' : "No products match your search."}
          </div>
        )}
        {filtered.map((p) => (
          <div key={p.id} className="p-3 flex items-center justify-between gap-3 hover:bg-[#fdf8f1]">
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{p.name}</div>
            </div>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={valueFor(p.id, p.quantity) === 0 ? "" : valueFor(p.id, p.quantity)}
              placeholder="0"
              onChange={(e) =>
                setEdits((s) => ({ ...s, [p.id]: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) }))
              }
              className="w-20 h-9 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
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

  // Filled-in products (using the LIVE value, so it reacts as you type) sort
  // to the top and stay there — alphabetical within each group — so you
  // never have to scroll to find something you just filled in, even with
  // "Show all products" on.
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items
      .filter((p) => {
        if (s && !p.name.toLowerCase().includes(s)) return false;
        const current = valueFor(p.id, p.quantity);
        if (anyHasValue && !showAll && current <= 0) return false;
        return true;
      })
      .sort((a, b) => {
        const aFilled = valueFor(a.id, a.quantity) > 0 ? 0 : 1;
        const bFilled = valueFor(b.id, b.quantity) > 0 ? 0 : 1;
        if (aFilled !== bFilled) return aFilled - bFilled;
        return a.name.localeCompare(b.name);
      });
  }, [items, search, showAll, anyHasValue, edits]);

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
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1">
          {(["Production", "Freezer"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${section === s ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          className="flex-1 min-w-[180px] bg-white border border-[#e8dcc8] rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-[#c8362b]"
        />
        <label className="flex items-center gap-2 text-xs font-semibold text-[#6b5544] shrink-0">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all products
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-[#8b6f4e]">Loading…</p>}
      {query.isError && <p className="text-sm text-red-700">Failed to load: {(query.error as Error).message}</p>}

      <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
        {filtered.length === 0 && !query.isLoading && (
          <div className="p-6 text-center text-sm text-[#8b6f4e]">
            {anyHasValue ? 'No products match. Toggle "Show all products" to see everything.' : "No products yet — add quantities below and save."}
          </div>
        )}
        {filtered.map((p) => (
          <div key={p.id} className="p-3 flex items-center justify-between gap-3 hover:bg-[#fdf8f1]">
            <div className="font-semibold text-sm truncate">{p.name}</div>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={valueFor(p.id, p.quantity) === 0 ? "" : valueFor(p.id, p.quantity)}
              placeholder="0"
              onChange={(e) =>
                setEdits((s) => ({ ...s, [p.id]: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) }))
              }
              className="w-20 h-9 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
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
    <section className="space-y-3">
      {query.data?.sheetLabel && (
        <p className="text-xs text-[#8b6f4e]">
          Reading and writing the <span className="font-semibold">{query.data.sheetLabel}</span> sheet — the same one used for order submission.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customers…"
          className="flex-1 min-w-[180px] bg-white border border-[#e8dcc8] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#c8362b]"
        />
        <select
          value={driverFilter}
          onChange={(e) => setDriverFilter(e.target.value)}
          className="bg-white border border-[#e8dcc8] rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:border-[#c8362b]"
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
            <div key={c.name} className="p-3 flex items-center justify-between gap-3 hover:bg-[#fdf8f1]">
              <div className="font-semibold text-sm truncate">{c.name}</div>
              <select
                value={current}
                onChange={(e) => setEdits((s) => ({ ...s, [c.name]: e.target.value }))}
                className="w-40 h-9 px-2 text-sm font-semibold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
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