import { createFileRoute, Link } from "@tanstack/react-router";
import { MOCK_CUSTOMERS } from "@/lib/mock-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Portugal Bakery — Customer Order Portal" },
      { name: "description", content: "Wholesale order portal for Portugal Bakery customers." },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="min-h-screen bg-[#fdf8f1] text-[#2a1810]">
      {/* Header */}
      <header className="border-b border-[#e8dcc8] bg-white">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-lg shadow-sm">
              P
            </div>
            <div>
              <h1 className="font-bold text-lg leading-none">Portugal Bakery</h1>
              <p className="text-xs text-[#8b6f4e]">Fresh daily since 1985</p>
            </div>
          </div>
          <Link
            to="/admin"
            className="text-sm px-4 py-2 rounded-lg border border-[#2a1810] hover:bg-[#2a1810] hover:text-white transition-colors"
          >
            Admin
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 py-16 text-center">
        <p className="text-[#c8362b] uppercase tracking-widest text-xs font-semibold mb-3">
          Wholesale Orders
        </p>
        <h2 className="text-4xl md:text-5xl font-bold mb-4 leading-tight">
          Place your daily order
          <br />
          <span className="text-[#c8362b]">in seconds.</span>
        </h2>
        <p className="text-[#6b5544] max-w-xl mx-auto mb-10">
          Each customer gets a permanent ordering link. Open it, type your quantities,
          tap submit. Your order goes straight to the bakery's master sheet.
        </p>

        {/* Customer demo links */}
        <div className="bg-white rounded-2xl shadow-sm border border-[#e8dcc8] p-6 max-w-md mx-auto">
          <p className="text-xs uppercase tracking-wider text-[#8b6f4e] mb-4 font-semibold">
            Demo customer pages
          </p>
          <div className="space-y-2">
            {MOCK_CUSTOMERS.map((c) => (
              <Link
                key={c.slug}
                to="/order/$slug"
                params={{ slug: c.slug }}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-[#fdf8f1] border border-transparent hover:border-[#e8dcc8] transition-all"
              >
                <div className="text-left">
                  <div className="font-semibold">{c.name}</div>
                  <div className="text-xs text-[#8b6f4e]">/order/{c.slug}</div>
                </div>
                <span className="text-[#c8362b]">→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#e8dcc8] py-6 text-center text-xs text-[#8b6f4e]">
        © {new Date().getFullYear()} Portugal Bakery · Bakery & Beverage Distribution
      </footer>
    </div>
  );
}
