import { createFileRoute, Link } from "@tanstack/react-router";
import { MOCK_CUSTOMERS } from "@/lib/mock-data";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin · Portugal Bakery" }] }),
  component: AdminPage,
});

function AdminPage() {
  return (
    <div className="min-h-screen bg-[#fdf8f1] text-[#2a1810]">
      <header className="bg-white border-b border-[#e8dcc8]">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-lg shadow-sm">
              P
            </div>
            <div>
              <h1 className="font-bold text-lg leading-none">Portugal Bakery</h1>
              <p className="text-xs text-[#8b6f4e]">Admin Dashboard</p>
            </div>
          </Link>
          <button className="text-sm text-[#8b6f4e] underline">Logout</button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-10">
        {/* Stats */}
        <section className="grid grid-cols-3 gap-4">
          {[
            { label: "Customers", value: MOCK_CUSTOMERS.length },
            { label: "Orders today", value: 12 },
            { label: "Sheet status", value: "✓ Synced" },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-2xl border border-[#e8dcc8] p-5 shadow-sm">
              <div className="text-xs uppercase tracking-wider text-[#8b6f4e] font-semibold">
                {s.label}
              </div>
              <div className="text-2xl font-bold mt-1">{s.value}</div>
            </div>
          ))}
        </section>

        {/* Customers */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">Customers</h2>
            <div className="flex gap-2">
              <button className="px-4 py-2 text-sm rounded-lg border border-[#e8dcc8] bg-white hover:bg-[#fdf8f1]">
                Import from Sheet
              </button>
              <button className="px-4 py-2 text-sm rounded-lg bg-[#c8362b] text-white hover:bg-[#a82a22] font-semibold">
                + New Customer
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
            {MOCK_CUSTOMERS.map((c) => (
              <div key={c.slug} className="p-4 flex items-center justify-between hover:bg-[#fdf8f1]">
                <div>
                  <div className="font-semibold">{c.name}</div>
                  <div className="text-xs text-[#8b6f4e] flex items-center gap-2 mt-0.5">
                    <code className="bg-[#fdf8f1] px-2 py-0.5 rounded">/order/{c.slug}</code>
                    <span>· {c.products.length} products</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    to="/order/$slug"
                    params={{ slug: c.slug }}
                    className="text-sm px-3 py-1.5 rounded-lg border border-[#e8dcc8] hover:bg-white"
                  >
                    Open
                  </Link>
                  <button className="text-sm px-3 py-1.5 rounded-lg bg-[#2a1810] text-white">
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Recent submissions */}
        <section>
          <h2 className="text-xl font-bold mb-4">Recent submissions</h2>
          <div className="bg-white rounded-2xl border border-[#e8dcc8] divide-y divide-[#e8dcc8] shadow-sm overflow-hidden">
            {[
              { name: "Brynston", time: "08:14", items: 53, ok: true },
              { name: "Sandton", time: "07:52", items: 28, ok: true },
              { name: "Alberton Meat", time: "07:30", items: 41, ok: true },
            ].map((s, i) => (
              <div key={i} className="p-4 flex items-center justify-between text-sm">
                <div>
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-[#8b6f4e]">Today at {s.time} · {s.items} items</div>
                </div>
                <span className="text-green-700 font-semibold">✓ Synced to sheet</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
