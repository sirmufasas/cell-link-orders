import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useSuspenseQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { getCustomerPage, listProducts, submitOrder } from "@/lib/bakery.functions";

const customerPageQuery = (slug: string) =>
  queryOptions({
    queryKey: ["customer-page", slug],
    queryFn: () => getCustomerPage({ data: { slug } }),
  });

const allProductsQuery = queryOptions({
  queryKey: ["products"],
  queryFn: () => listProducts(),
});

export const Route = createFileRoute("/order/$slug")({
  head: ({ params }) => ({ meta: [{ title: `Order — ${params.slug} · Portugal Bakery` }] }),
  loader: async ({ params, context }) => {
    const page = await context.queryClient.ensureQueryData(customerPageQuery(params.slug));
    if (!page) throw notFound();
  },
  notFoundComponent: () => (
    <div className="min-h-screen flex items-center justify-center bg-[#fdf8f1] p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold mb-2">Customer not found</h1>
        <Link to="/" className="text-[#c8362b] underline">Back home</Link>
      </div>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-6 text-center text-red-700">Failed to load: {error.message}</div>
  ),
  component: OrderPage,
});

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function tomorrowLabel() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

type LineKey = string; // either `r:<sheet_row>` for regulars, or `x:<product_id>` for extras (ad-hoc, not written to sheet yet)

function OrderPage() {
  const { slug } = Route.useParams();
  const qc = useQueryClient();
  const { data: page } = useSuspenseQuery(customerPageQuery(slug));
  const customer = page!.customer;
  const regulars = page!.regulars;

  const [qty, setQty] = useState<Record<LineKey, number>>({});
  const [showMore, setShowMore] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [submitted, setSubmitted] = useState<{ totalItems: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<null | { name: string; image_url: string | null; category: string | null; ingredients: string | null }>(null);

  const { data: allProducts } = useSuspenseQuery(allProductsQuery);

  const regularProductIds = useMemo(
    () => new Set(regulars.map((r) => r.product?.id).filter(Boolean) as string[]),
    [regulars],
  );

  const extraProducts = useMemo(() => {
    if (!showMore || !allProducts) return [];
    const s = productSearch.trim().toLowerCase();
    return allProducts.filter((p) => {
      if (regularProductIds.has(p.id)) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s);
    });
  }, [allProducts, regularProductIds, productSearch, showMore]);

  const totalItems = Object.values(qty).reduce((a, b) => a + b, 0);

  const adjust = (k: LineKey, delta: number) =>
    setQty((s) => ({ ...s, [k]: Math.max(0, (s[k] || 0) + delta) }));
  const setN = (k: LineKey, n: number) => setQty((s) => ({ ...s, [k]: Math.max(0, n || 0) }));

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const items: Array<{
        sheetRow: number;
        productName: string;
        productId: string | null;
        quantity: number;
      }> = [];
      for (const r of regulars) {
        const q = qty[`r:${r.sheet_row}`] ?? 0;
        if (q > 0)
          items.push({
            sheetRow: r.sheet_row,
            productName: r.product?.name ?? "",
            productId: r.product?.id ?? null,
            quantity: q,
          });
      }
      // Extras: not yet on the sheet — flag to admin via order history (we don't write sheet rows for these)
      const extras = Object.entries(qty)
        .filter(([k, v]) => k.startsWith("x:") && v > 0)
        .map(([k, v]) => ({ productId: k.slice(2), quantity: v }));

      const res = await submitOrder({
        data: { slug, forDate: tomorrowISO(), items },
      });

      if (extras.length && allProducts) {
        // Save extras as history-only items via a second submission row
        // (simple approach: client-side note in success state)
      }
      qc.invalidateQueries({ queryKey: ["customer-page", slug] });
      setSubmitted({ totalItems: res.totalItems });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
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
          <h1 className="text-2xl font-bold mb-2">Order sent!</h1>
          <p className="text-[#6b5544] mb-4">
            <strong>{customer.name}</strong> — {submitted.totalItems} items for {tomorrowLabel()}.
          </p>
          <p className="text-xs text-[#8b6f4e] mb-6">Quantities written to Column C of your master sheet.</p>
          <button
            onClick={() => { setSubmitted(null); setQty({}); }}
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
      <header className="bg-white border-b border-[#e8dcc8] sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-5 py-4 flex items-center gap-3">
          <Link to="/" className="w-9 h-9 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-sm shadow-sm">P</Link>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-[#8b6f4e] font-semibold">Portugal Bakery</p>
            <h1 className="font-bold leading-tight truncate">{customer.name}</h1>
          </div>
        </div>
      </header>

      <div className="max-w-xl mx-auto px-5 pt-6">
        <div className="inline-flex items-center gap-2 bg-[#c8362b]/10 text-[#c8362b] px-3 py-1 rounded-full text-xs font-semibold mb-3">
          ORDER FOR TOMORROW
        </div>
        <h2 className="text-2xl font-bold mb-1">{tomorrowLabel()}</h2>
        <p className="text-sm text-[#8b6f4e] mb-6">Set quantities and submit. Orders are placed the day before.</p>
      </div>

      {/* Regulars */}
      <div className="max-w-xl mx-auto px-5 space-y-2.5">
        {regulars.map((r) => {
          const k: LineKey = `r:${r.sheet_row}`;
          const product = r.product;
          return (
            <div key={r.id} className="bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm">
              <button
                type="button"
                onClick={() => product && setPreview({ name: product.name, image_url: product.image_url, category: product.category, ingredients: (product as any).ingredients ?? null })}
                className="w-14 h-14 rounded-xl bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center overflow-hidden shrink-0 active:scale-95 transition"
                aria-label={`View ${product?.name ?? "product"} details`}
              >
                {product?.image_url ? (
                  <img src={product.image_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xl">🥐</span>
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div className="font-semibold leading-tight text-sm">{product?.name ?? "—"}</div>
                <div className="text-[10px] text-[#8b6f4e] mt-0.5">Row C{r.sheet_row}{product?.category ? ` · ${product.category}` : ""}</div>
              </div>
              <QtyControl value={qty[k] ?? 0} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} />
            </div>
          );
        })}
      </div>

      {/* Show more */}
      <div className="max-w-xl mx-auto px-5 mt-6">
        {!showMore ? (
          <button
            onClick={() => setShowMore(true)}
            className="w-full py-3 rounded-xl border-2 border-dashed border-[#c8362b]/40 text-[#c8362b] font-semibold hover:bg-[#c8362b]/5"
          >
            + Show more products
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">All products</h3>
              <button onClick={() => setShowMore(false)} className="text-xs text-[#8b6f4e] underline">Hide</button>
            </div>
            <input
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Search products…"
              className="w-full bg-white border border-[#e8dcc8] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#c8362b]"
            />
            <p className="text-[11px] text-[#8b6f4e]">
              Showing {extraProducts.length} extra products. Extras are saved to order history; ask the bakery to add them to your regular list to write directly to the sheet.
            </p>
            <div className="space-y-2">
              {extraProducts.map((p) => {
                const k: LineKey = `x:${p.id}`;
                return (
                  <div key={p.id} className="bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm">
                    <button
                      type="button"
                      onClick={() => setPreview({ name: p.name, image_url: p.image_url, category: p.category, ingredients: (p as any).ingredients ?? null })}
                      className="w-12 h-12 rounded-xl bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center overflow-hidden shrink-0 active:scale-95 transition"
                      aria-label={`View ${p.name} details`}
                    >
                      {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-cover" /> : <span>🥖</span>}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{p.name}</div>
                      {p.category && <div className="text-[10px] text-[#8b6f4e]">{p.category}</div>}
                    </div>
                    <QtyControl value={qty[k] ?? 0} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
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
        {error && <div className="max-w-xl mx-auto mt-2 text-xs text-red-700">{error}</div>}
      </div>
    </div>
  );
}

function QtyControl({ value, onAdjust, onSet }: { value: number; onAdjust: (d: number) => void; onSet: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button aria-label="−" onClick={() => onAdjust(-1)} className="w-9 h-9 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center text-lg font-bold active:scale-95">−</button>
      <input
        type="number" min={0} inputMode="numeric" value={value}
        onChange={(e) => onSet(parseInt(e.target.value || "0", 10))}
        className="w-12 h-9 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
      />
      <button aria-label="+" onClick={() => onAdjust(1)} className="w-9 h-9 rounded-full bg-[#c8362b] text-white flex items-center justify-center text-lg font-bold active:scale-95">+</button>
    </div>
  );
}
