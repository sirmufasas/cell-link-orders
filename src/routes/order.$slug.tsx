import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { getCustomer, type MockCustomer } from "@/lib/mock-data";

export const Route = createFileRoute("/order/$slug")({
  head: ({ params }) => ({
    meta: [{ title: `Order — ${params.slug} · Portugal Bakery` }],
  }),
  loader: ({ params }) => {
    const customer = getCustomer(params.slug);
    if (!customer) throw notFound();
    return { customer };
  },
  notFoundComponent: () => (
    <div className="min-h-screen flex items-center justify-center bg-[#fdf8f1] p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold mb-2">Customer not found</h1>
        <p className="text-[#8b6f4e] mb-4">This order link is not active.</p>
        <Link to="/" className="text-[#c8362b] underline">Back home</Link>
      </div>
    </div>
  ),
  component: OrderPage,
});

function OrderPage() {
  const { customer } = Route.useLoaderData() as { customer: MockCustomer };
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries(customer.products.map((p) => [p.id, 0]))
  );
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const totalItems = Object.values(qty).reduce((a, b) => a + b, 0);

  function handleSubmit() {
    setSubmitting(true);
    setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
    }, 700);
  }

  function adjust(id: string, delta: number) {
    setQty((s) => ({ ...s, [id]: Math.max(0, (s[id] || 0) + delta) }));
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#fdf8f1] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-lg border border-[#e8dcc8] p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold mb-2">Order received!</h1>
          <p className="text-[#6b5544] mb-6">
            Thank you, <strong>{customer.name}</strong>. Your order has been sent to the bakery.
          </p>
          <button
            onClick={() => {
              setSubmitted(false);
              setQty(Object.fromEntries(customer.products.map((p) => [p.id, 0])));
            }}
            className="text-sm text-[#c8362b] underline"
          >
            Place another order
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fdf8f1] pb-32">
      {/* Header */}
      <header className="bg-white border-b border-[#e8dcc8] sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-5 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-sm shadow-sm">
            P
          </div>
          <div className="flex-1">
            <p className="text-[10px] uppercase tracking-widest text-[#8b6f4e] font-semibold">
              Portugal Bakery
            </p>
            <h1 className="font-bold leading-tight">{customer.name}</h1>
          </div>
        </div>
      </header>

      {/* Welcome */}
      <div className="max-w-xl mx-auto px-5 pt-6">
        <h2 className="text-2xl font-bold mb-1">Today's order</h2>
        <p className="text-sm text-[#8b6f4e] mb-6">
          Enter quantities for the items you'd like. Tap submit when done.
        </p>
      </div>

      {/* Product list */}
      <div className="max-w-xl mx-auto px-5 space-y-2.5">
        {customer.products.map((p) => (
          <div
            key={p.id}
            className="bg-white rounded-2xl border border-[#e8dcc8] p-4 flex items-center gap-3 shadow-sm"
          >
            <div className="flex-1 min-w-0">
              <div className="font-semibold leading-tight">{p.name}</div>
              <div className="text-[11px] text-[#8b6f4e] mt-0.5">Cell C{p.sheetRow}</div>
            </div>

            <div className="flex items-center gap-2">
              <button
                aria-label="Decrease"
                onClick={() => adjust(p.id, -1)}
                className="w-10 h-10 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center text-xl font-bold text-[#2a1810] active:scale-95 transition"
              >
                −
              </button>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={qty[p.id]}
                onChange={(e) =>
                  setQty((s) => ({
                    ...s,
                    [p.id]: Math.max(0, parseInt(e.target.value || "0", 10)),
                  }))
                }
                className="w-14 h-10 text-center font-bold text-lg border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
              />
              <button
                aria-label="Increase"
                onClick={() => adjust(p.id, 1)}
                className="w-10 h-10 rounded-full bg-[#c8362b] text-white flex items-center justify-center text-xl font-bold shadow-sm active:scale-95 transition"
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Sticky submit */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-[#e8dcc8] p-4 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <div className="flex-1">
            <div className="text-xs text-[#8b6f4e]">Total items</div>
            <div className="font-bold text-lg">{totalItems}</div>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting || totalItems === 0}
            className="flex-1 bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-4 rounded-xl shadow-sm transition"
          >
            {submitting ? "Sending…" : "Submit Order"}
          </button>
        </div>
      </div>
    </div>
  );
}
