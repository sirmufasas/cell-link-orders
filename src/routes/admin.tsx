import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useSuspenseQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line,
} from "recharts";
import {
  listCustomers, listSubmissions, syncFromSheet, analyticsOverview,
} from "@/lib/bakery.functions";

const SHEET_URL = "https://docs.google.com/spreadsheets/d/18n8m7xpZleB6d9l2ccwOqRWbc8QxLVBXftdBVlxL2tQ/edit";

const customersQuery = queryOptions({ queryKey: ["customers"], queryFn: () => listCustomers() });
const submissionsQuery = queryOptions({ queryKey: ["submissions"], queryFn: () => listSubmissions({ data: {} }) });
const analyticsQuery = queryOptions({ queryKey: ["analytics"], queryFn: () => analyticsOverview() });

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin · Portugal Bakery" }] }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(customersQuery);
    context.queryClient.ensureQueryData(submissionsQuery);
  },
  errorComponent: ({ error }) => <div className="p-6 text-red-700">Failed: {error.message}</div>,
  notFoundComponent: () => <div className="p-6">Not found</div>,
  component: AdminPage,
});

function AdminPage() {
  const qc = useQueryClient();
  const { data: customers } = useSuspenseQuery(customersQuery);
  const { data: submissions } = useSuspenseQuery(submissionsQuery);
  const { data: analytics } = useSuspenseQuery(analyticsQuery);

  const [tab, setTab] = useState<"customers" | "history" | "analytics">("customers");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const filteredCustomers = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(s));
  }, [search, customers]);

  async function handleSync() {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await syncFromSheet();
      setSyncMsg(`Synced ${r.customers} customers, ${r.products} products, ${r.mappings} rows.`);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    } catch (e) {
      setSyncMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  // Build chart data: orders per day (last 30)
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of analytics) {
      m.set(s.for_date, (m.get(s.for_date) ?? 0) + (s.total_items ?? 0));
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30)
      .map(([date, items]) => ({ date: date.slice(5), items }));
  }, [analytics]);

  const topProducts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of analytics) {
      for (const it of (s.items ?? [])) {
        m.set(it.product_name, (m.get(it.product_name) ?? 0) + it.quantity);
      }
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, qty]) => ({ name: name.length > 18 ? name.slice(0, 18) + "…" : name, qty }));
  }, [analytics]);

  const topCustomers = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of analytics) {
      const n = s.customer?.name ?? "—";
      m.set(n, (m.get(n) ?? 0) + (s.total_items ?? 0));
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, qty]) => ({ name: name.length > 16 ? name.slice(0, 16) + "…" : name, qty }));
  }, [analytics]);

  return (
    <div className="min-h-screen bg-[#fdf8f1] text-[#2a1810]">
      <header className="bg-white border-b border-[#e8dcc8]">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-lg shadow-sm">P</div>
            <div>
              <h1 className="font-bold text-lg leading-none">Portugal Bakery</h1>
              <p className="text-xs text-[#8b6f4e]">Admin Dashboard</p>
            </div>
          </Link>
          <div className="flex gap-2">
            <a href={SHEET_URL} target="_blank" rel="noreferrer"
              className="text-sm px-3 py-2 rounded-lg bg-green-700 text-white font-semibold hover:bg-green-800">
              📊 Open Google Sheet
            </a>
            <button onClick={handleSync} disabled={syncing}
              className="text-sm px-3 py-2 rounded-lg border border-[#2a1810] hover:bg-[#2a1810] hover:text-white disabled:opacity-50">
              {syncing ? "Syncing…" : "↻ Sync from Sheet"}
            </button>
          </div>
        </div>
        {syncMsg && (
          <div className="max-w-6xl mx-auto px-6 pb-3 text-sm text-[#6b5544]">{syncMsg}</div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        {/* Stats */}
        <section className="grid grid-cols-3 gap-3">
          {[
            { label: "Customers", value: customers.length },
            { label: "Orders logged", value: submissions.length },
            { label: "Sheet", value: "✓ Connected" },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-2xl border border-[#e8dcc8] p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wider text-[#8b6f4e] font-semibold">{s.label}</div>
              <div className="text-xl font-bold mt-1">{s.value}</div>
            </div>
          ))}
        </section>

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-[#e8dcc8] rounded-xl p-1 w-fit">
          {(["customers", "history", "analytics"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${tab === t ? "bg-[#c8362b] text-white" : "text-[#6b5544]"}`}>
              {t === "customers" ? "Customers" : t === "history" ? "Order History" : "Analytics"}
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
                <div className="p-6 text-center text-sm text-[#8b6f4e]">No customers — click “Sync from Sheet” above.</div>
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
          <section className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
            {submissions.length === 0 && (
              <div className="p-6 text-center text-sm text-[#8b6f4e]">No orders submitted yet.</div>
            )}
            {submissions.map((s) => (
              <div key={s.id} className="p-3 flex items-center justify-between text-sm">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{s.customer?.name ?? "—"}</div>
                  <div className="text-xs text-[#8b6f4e]">
                    For {s.for_date} · {s.total_items} items · submitted {new Date(s.created_at).toLocaleString()}
                  </div>
                </div>
                <span className="text-green-700 text-xs font-semibold">✓ Synced</span>
              </div>
            ))}
          </section>
        )}

        {tab === "analytics" && (
          <section className="grid gap-4 md:grid-cols-2">
            <ChartCard title="Items per day (last 30)">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={perDay}>
                  <CartesianGrid stroke="#e8dcc8" strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="items" stroke="#c8362b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Top 10 products">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={topProducts}>
                  <CartesianGrid stroke="#e8dcc8" strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="qty" fill="#c8362b" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Top 10 customers">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={topCustomers}>
                  <CartesianGrid stroke="#e8dcc8" strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="qty" fill="#8b1e1e" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>
        )}
      </main>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-[#e8dcc8] p-4 shadow-sm">
      <h3 className="font-semibold text-sm mb-2">{title}</h3>
      {children}
    </div>
  );
}
