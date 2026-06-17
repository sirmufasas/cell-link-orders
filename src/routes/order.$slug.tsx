import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useSuspenseQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { getCustomerPage, listProducts, submitOrder, addOnToOrder } from "@/lib/bakery.functions";

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
function dateLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

type LineKey = string;
type Mode = "default" | "addon";

const KOTA_ONLY_PRODUCTS = new Set(["Rolls Kota", "Kota"]);

function OrderPage() {
  const { slug } = Route.useParams();
  const qc = useQueryClient();
  const { data: page } = useSuspenseQuery(customerPageQuery(slug));
  const customer = page!.customer;
  const regularsAll = page!.regulars;
  const todayOrder = page!.todayOrder;
  const hasPriorOrders = page!.hasPriorOrders;
  const history = page!.history;

  const isKotaJoe = customer.name.trim().toLowerCase() === "kota joe";
  const regulars = useMemo(
    () => regularsAll.filter((r) => isKotaJoe || !KOTA_ONLY_PRODUCTS.has(r.product?.name ?? "")),
    [regularsAll, isKotaJoe],
  );

  const [qty, setQty] = useState<Record<LineKey, number>>({});
  const [showMore, setShowMore] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // ordered = true means we just submitted; combined with todayOrder server-data drives the "received" screen
  const [mode, setMode] = useState<Mode>("default");

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
      if (!isKotaJoe && KOTA_ONLY_PRODUCTS.has(p.name)) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s);
    });
  }, [allProducts, regularProductIds, productSearch, showMore, isKotaJoe]);

  const totalItems = Object.values(qty).reduce((a, b) => a + b, 0);

  const adjust = (k: LineKey, delta: number) =>
    setQty((s) => ({ ...s, [k]: Math.max(0, (s[k] || 0) + delta) }));
  const setN = (k: LineKey, n: number) => setQty((s) => ({ ...s, [k]: Math.max(0, n || 0) }));

  function buildItems() {
    const items: Array<{ sheetRow: number; productName: string; productId: string | null; quantity: number }> = [];
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
    for (const [k, v] of Object.entries(qty)) {
      if (!k.startsWith("x:") || v <= 0) continue;
      const pid = k.slice(2);
      const p = allProducts?.find((x) => x.id === pid);
      if (!p) continue;
      items.push({ sheetRow: 0, productName: p.name, productId: p.id, quantity: v });
    }
    return items;
  }

  async function handleSubmit() {
    setSubmitting(true); setError(null);
    try {
      const items = buildItems();
      if (mode === "addon") {
        await addOnToOrder({ data: { slug, forDate: tomorrowISO(), items } });
      } else {
        await submitOrder({ data: { slug, forDate: tomorrowISO(), items } });
      }
      setQty({});
      setMode("default");
      await qc.invalidateQueries({ queryKey: ["customer-page", slug] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // ===== Received-today screen =====
  if (todayOrder && mode === "default") {
    return (
      <div className="min-h-screen bg-[#fdf8f1] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-lg border border-[#e8dcc8] p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold mb-2">Your order has been received!</h1>
          <p className="text-[#6b5544] mb-6">
            <strong>{customer.name}</strong> — {todayOrder.total_items} items for {tomorrowLabel()}.
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => { setMode("addon"); setQty({}); }}
              className="bg-[#c8362b] hover:bg-[#a82a22] text-white font-bold py-3 rounded-xl"
            >
              + Add onto Prev Order
            </button>
            <button
              onClick={() => setShowHistory(true)}
              className="border border-[#e8dcc8] hover:bg-[#fdf8f1] font-semibold py-3 rounded-xl"
            >
              History
            </button>
            <Link to="/" className="text-xs text-[#8b6f4e] underline mt-3">Back home</Link>
          </div>
        </div>
        {showHistory && <HistoryModal history={history} onClose={() => setShowHistory(false)} />}
      </div>
    );
  }

  // ===== Order form (default or add-on) =====
  return (
    <div className="min-h-screen bg-[#fdf8f1] pb-40">
      <header className="bg-white border-b border-[#e8dcc8] sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-5 py-4 flex items-center gap-3">
          <Link to="/" className="w-9 h-9 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-sm shadow-sm">P</Link>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-[#8b6f4e] font-semibold">Portugal Bakery</p>
            <h1 className="font-bold leading-tight truncate">{customer.name}</h1>
          </div>
          {mode === "addon" && (
            <button onClick={() => setMode("default")} className="text-xs text-[#8b6f4e] underline">Cancel</button>
          )}
        </div>
      </header>

      <div className="max-w-xl mx-auto px-5 pt-6">
        <div className="inline-flex items-center gap-2 bg-[#c8362b]/10 text-[#c8362b] px-3 py-1 rounded-full text-xs font-semibold mb-3">
          {mode === "addon" ? "ADD-ON ORDER" : "ORDER FOR TOMORROW"}
        </div>
        <h2 className="text-2xl font-bold mb-1">{tomorrowLabel()}</h2>
        <p className="text-sm text-[#8b6f4e] mb-6">
          {mode === "addon"
            ? "Add extra quantities on top of today's order."
            : "Set quantities and submit. Orders are placed the day before."}
        </p>
      </div>

      <div className="max-w-xl mx-auto px-5 space-y-2.5">
        {regulars.map((r) => {
          const k: LineKey = `r:${r.sheet_row}`;
          const product = r.product;
          return (
            <div key={r.id} className="bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm">
              <div className="flex-1 min-w-0">
                <div className="font-semibold leading-tight text-sm">{product?.name ?? "—"}</div>
                <div className="text-[10px] text-[#8b6f4e] mt-0.5">Row C{r.sheet_row}{product?.category ? ` · ${product.category}` : ""}</div>
              </div>
              <QtyControl value={qty[k] ?? 0} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} />
            </div>
          );
        })}
      </div>

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
              Showing {extraProducts.length} extra products. New products get inserted into your sheet automatically.
            </p>
            <div className="space-y-2">
              {extraProducts.map((p) => {
                const k: LineKey = `x:${p.id}`;
                return (
                  <div key={p.id} className="bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm">
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

      {/* Sticky bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-[#e8dcc8] p-4 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="max-w-xl mx-auto">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1">
              <div className="text-xs text-[#8b6f4e]">Total items</div>
              <div className="font-bold text-lg">{totalItems}</div>
            </div>
            <button
              onClick={() => setShowHistory(true)}
              className="px-3 py-2 rounded-xl border border-[#e8dcc8] text-sm font-semibold"
            >
              History
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting || totalItems === 0}
              className="flex-1 bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-3 rounded-xl transition"
            >
              {submitting
                ? "Sending…"
                : mode === "addon"
                  ? "Submit Add-On"
                  : "Submit Order"}
            </button>
            {mode === "default" && hasPriorOrders && !todayOrder && (
              <button
                onClick={handleSubmit}
                disabled={submitting || totalItems === 0}
                className="flex-1 border-2 border-[#c8362b] text-[#c8362b] font-bold py-3 rounded-xl disabled:opacity-50"
                title="Overwrite today's quantities in column C"
              >
                Change Order
              </button>
            )}
          </div>
          {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
        </div>
      </div>

      {showHistory && <HistoryModal history={history} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

function HistoryModal({
  history,
  onClose,
}: {
  history: Array<{
    id: string;
    for_date: string;
    total_items: number;
    created_at: string;
    items: Array<{ product_name: string; quantity: number }>;
  }>;
  onClose: () => void;
}) {
  // Group by created_at date (local)
  const groups = useMemo(() => {
    const m = new Map<string, typeof history>();
    for (const h of history) {
      const key = new Date(h.created_at).toISOString().slice(0, 10);
      const arr = m.get(key) ?? [];
      arr.push(h);
      m.set(key, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [history]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-md w-full max-h-[85vh] overflow-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[#e8dcc8] sticky top-0 bg-white">
          <h3 className="font-bold">Order history (last 7 days)</h3>
          <button onClick={onClose} className="text-2xl leading-none text-[#8b6f4e]">×</button>
        </div>
        <div className="p-4 space-y-5">
          {groups.length === 0 && (
            <p className="text-sm text-[#8b6f4e] text-center">No orders in the last 7 days.</p>
          )}
          {groups.map(([day, subs]) => (
            <div key={day}>
              <h4 className="font-bold text-sm text-[#2a1810] mb-2">{dateLabel(day)}</h4>
              <div className="space-y-3">
                {subs.map((s) => (
                  <div key={s.id} className="border border-[#e8dcc8] rounded-xl p-3">
                    <div className="text-xs text-[#8b6f4e] mb-2">
                      For {s.for_date} · {s.total_items} items
                    </div>
                    <ul className="text-sm space-y-1">
                      {s.items.map((it, i) => (
                        <li key={i} className="flex justify-between">
                          <span>{it.product_name}</span>
                          <span className="font-semibold">{it.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function QtyControl({
  value,
  onAdjust,
  onSet,
}: {
  value: number;
  onAdjust: (d: number) => void;
  onSet: (n: number) => void;
}) {
  const [text, setText] = useState<string>(String(value));
  // Sync when external value changes (e.g. after submit/reset)
  if (text !== String(value) && document.activeElement?.tagName !== "INPUT") {
    // only when not actively editing
  }

  return (
    <div className="flex items-center gap-1.5">
      <button aria-label="−" onClick={() => { onAdjust(-1); setText(String(Math.max(0, value - 1))); }} className="w-9 h-9 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center text-lg font-bold active:scale-95">−</button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value === 0 && text === "" ? "" : text}
        onFocus={(e) => {
          e.currentTarget.select();
          if (value === 0) setText("");
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          setText(raw);
          onSet(raw === "" ? 0 : parseInt(raw, 10));
        }}
        onBlur={() => setText(String(value))}
        className="w-12 h-9 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
      />
      <button aria-label="+" onClick={() => { onAdjust(1); setText(String(value + 1)); }} className="w-9 h-9 rounded-full bg-[#c8362b] text-white flex items-center justify-center text-lg font-bold active:scale-95">+</button>
    </div>
  );
}
