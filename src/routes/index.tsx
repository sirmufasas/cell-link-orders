import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { listCustomers } from "@/lib/bakery.functions";

const customersQuery = queryOptions({
  queryKey: ["customers"],
  queryFn: () => listCustomers(),
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Portugal Bakery — Customer Order Portal" },
      { name: "description", content: "Wholesale order portal for Portugal Bakery customers." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(customersQuery),
  component: Home,
  errorComponent: ({ error }) => (
    <div className="p-6 text-center text-red-700">Failed to load: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function Home() {
  const { data: customers } = useSuspenseQuery(customersQuery);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(s));
  }, [q, customers]);

  return (
    <div className="min-h-screen bg-[#fdf8f1] text-[#2a1810]">
      <header className="border-b border-[#e8dcc8] bg-white">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-lg shadow-sm">P</div>
            <div>
              <h1 className="font-bold text-lg leading-none">Portugal Bakery</h1>
              <p className="text-xs text-[#8b6f4e]">Wholesale orders</p>
            </div>
          </div>
          <Link to="/admin" className="text-sm px-4 py-2 rounded-lg border border-[#2a1810] hover:bg-[#2a1810] hover:text-white transition-colors">Admin</Link>
        </div>
      </header>

      <section className="max-w-3xl mx-auto px-6 py-10">
        <h2 className="text-3xl md:text-4xl font-bold mb-3 text-center">Find your order page</h2>
        <p className="text-[#6b5544] text-center mb-6">Each customer has a permanent ordering link.</p>

        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search customers…"
          className="w-full bg-white border border-[#e8dcc8] rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#c8362b] shadow-sm"
        />

        <div className="mt-4 bg-white rounded-2xl border border-[#e8dcc8] shadow-sm divide-y divide-[#e8dcc8] max-h-[60vh] overflow-auto">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-[#8b6f4e]">
              No customers yet. Open Admin → Sync from Sheet to import them.
            </div>
          ) : (
            filtered.map((c) => (
              <Link
                key={c.id}
                to="/order/$slug"
                params={{ slug: c.slug }}
                className="flex items-center justify-between p-4 hover:bg-[#fdf8f1]"
              >
                <div>
                  <div className="font-semibold">{c.name}</div>
                  <div className="text-xs text-[#8b6f4e]">/order/{c.slug}{c.driver ? ` · ${c.driver}` : ""}</div>
                </div>
                <span className="text-[#c8362b]">→</span>
              </Link>
            ))
          )}
        </div>
      </section>

      <footer className="border-t border-[#e8dcc8] py-6 text-center text-xs text-[#8b6f4e]">
        © {new Date().getFullYear()} Portugal Bakery
      </footer>
    </div>
  );
}
