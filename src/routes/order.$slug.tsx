import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState, useMemo, useEffect } from "react";
import { useSuspenseQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { getCustomerPage, listProducts, submitOrder, addOnToOrder, changeOrder } from "@/lib/bakery.functions";

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

const MAX_ITEMS = 20;

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

const KOTA_ONLY_PREFIXES = ["rolls kota", "kota"];

function isKotaOnlyProduct(name: string | undefined | null) {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  return KOTA_ONLY_PREFIXES.some((prefix) => n.startsWith(prefix));
}

function OrderPage() {
  const { slug } = Route.useParams();
  const qc = useQueryClient();
  const { data: page } = useSuspenseQuery(customerPageQuery(slug));
  const customer = page!.customer;
  const regularsAll = page!.regulars;
  const todayOrder = page!.todayOrder;
  const hasPriorOrders = page!.hasPriorOrders;
  const history = page!.history;

  // Save this customer's slug so the homepage can redirect them back here
  useEffect(() => {
    try {
      localStorage.setItem("pb-customer-slug", slug);
    } catch {}
  }, [slug]);

  const isKotaJoe = customer.name.trim().toLowerCase().startsWith("kota joe");
  const regulars = useMemo(
    () => regularsAll.filter((r) => isKotaJoe || !isKotaOnlyProduct(r.product?.name)),
    [regularsAll, isKotaJoe],
  );

  const [qty, setQty] = useState<Record<LineKey, number>>({});
  const [showMore, setShowMore] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [mode, setMode] = useState<Mode>("default");

  // Message modal state — once cancelled, skip the modal on future submits
  const [showMessageModal, setShowMessageModal] = useState(false);
  const [message, setMessage] = useState("");
  const [messageModalSkipped, setMessageModalSkipped] = useState(false);

  const { data: allProducts } = useSuspenseQuery(allProductsQuery);

  const regularProductIds = useMemo(
    () => new Set(regulars.map((r) => r.product?.id).filter(Boolean) as string[]),
    [regulars],
  );

  const regularSheetRows = useMemo(
    () => new Set(regulars.map((r) => r.sheet_row)),
    [regulars],
  );

  function buildPrefillFromTodayOrder(): Record<LineKey, number> {
    const next: Record<LineKey, number> = {};
    for (const item of todayOrder?.items ?? []) {
      if (item.sheet_row && regularSheetRows.has(item.sheet_row)) {
        next[`r:${item.sheet_row}`] = item.quantity;
      } else if (item.product_id) {
        next[`x:${item.product_id}`] = item.quantity;
      }
    }
    return next;
  }

  const extraProducts = useMemo(() => {
    if (!showMore || !allProducts) return [];
    const s = productSearch.trim().toLowerCase();
    return allProducts.filter((p) => {
      if (regularProductIds.has(p.id)) return false;
      if (!isKotaJoe && isKotaOnlyProduct(p.name)) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s);
    });
  }, [allProducts, regularProductIds, productSearch, showMore, isKotaJoe]);

  // Count distinct products (lines with qty > 0), not total quantity
  const totalProducts = Object.values(qty).filter((v) => v > 0).length;
  const remaining = MAX_ITEMS - totalProducts;
  const atLimit = remaining <= 0;

  const adjust = (k: LineKey, delta: number) => {
    if (delta > 0) {
      // Only allow adding a new product line if under the limit
      const currentQty = qty[k] ?? 0;
      const isNewLine = currentQty === 0;
      if (isNewLine && atLimit) return;
    }
    setQty((s) => ({ ...s, [k]: Math.max(0, (s[k] || 0) + delta) }));
  };
  const setN = (k: LineKey, n: number) => {
    const currentQty = qty[k] ?? 0;
    const isNewLine = currentQty === 0 && n > 0;
    if (isNewLine && atLimit) return;
    setQty((s) => ({ ...s, [k]: Math.max(0, n || 0) }));
  };

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

  async function handleSubmit(msg: string) {
    setSubmitting(true); setError(null);
    try {
      const items = buildItems();
      const safeMsg = msg.trim() || " ";
      if (mode === "addon") {
        await addOnToOrder({ data: { slug, forDate: tomorrowISO(), items, message: safeMsg } });
      } else if (showChangeForm) {
        await changeOrder({ data: { slug, forDate: tomorrowISO(), items, message: safeMsg } });
      } else {
        await submitOrder({ data: { slug, forDate: tomorrowISO(), items, message: safeMsg } });
      }
      setQty({});
      setMessage("");
      setMode("default");
      setShowChangeForm(false);
      setMessageModalSkipped(false);
      await qc.invalidateQueries({ queryKey: ["customer-page", slug] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitPress() {
    if (totalProducts === 0) return;
    // If they've already dismissed the modal once, skip it and submit directly
    if (messageModalSkipped) {
      void handleSubmit(message);
    } else {
      setShowMessageModal(true);
    }
  }

  function handleSendMessage() {
    if (!message.trim() && !messageModalSkipped) {
      // They clicked Send with no message — treat as skipped
    }
    setShowMessageModal(false);
    void handleSubmit(message);
  }

  function handleCancelMessage() {
    setShowMessageModal(false);
    setMessageModalSkipped(true);
    // Don't submit — just close and let them submit directly next time
  }

  // ===== Received-today screen =====
  if (todayOrder && mode === "default" && !showChangeForm) {
    return (
      <div className="min-h-screen bg-[#fdf8f1] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-lg border border-[#e8dcc8] p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold mb-2">Your order has been received!</h1>
          <h3 className="text-sm font-semibold text-[#8b6f4e] mb-2">New orders can only be submitted tomorrow</h3>
          <p className="text-[#6b5544] mb-2">
            <strong>{customer.name}</strong> — {todayOrder.total_items} items for {tomorrowLabel()}.
          </p>
          {todayOrder.message && (
            <p className="text-xs text-[#8b6f4e] bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl px-3 py-2 mb-4 text-left">
              <span className="font-semibold">Your note: </span>{todayOrder.message}
            </p>
          )}
          <div className="flex flex-col gap-2 mt-2">
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
          </div>
        </div>
        {showHistory && <HistoryModal history={history} onClose={() => setShowHistory(false)} />}
        {submitting && <SubmittingOverlay mode={mode} showChangeForm={showChangeForm} />}
      </div>
    );
  }

  // ===== Order form (default or add-on) =====
  return (
    <div className="min-h-screen bg-[#fdf8f1] pb-40">
      <header className="bg-white border-b border-[#e8dcc8] sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-5 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#c8362b] to-[#8b1e1e] flex items-center justify-center text-white font-bold text-sm shadow-sm">P</div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-[#8b6f4e] font-semibold">Portugal Bakery</p>
            <h1 className="font-bold leading-tight truncate">{customer.name}</h1>
          </div>
          {(mode === "addon" || showChangeForm) && (
            <button
              onClick={() => { setMode("default"); setShowChangeForm(false); }}
              className="px-3 py-1.5 rounded-lg border-2 border-[#c8362b] text-[#c8362b] text-xs font-bold hover:bg-[#c8362b] hover:text-white transition shrink-0"
            >
              Cancel
            </button>
          )}
        </div>
      </header>

      <div className="max-w-xl mx-auto px-5 pt-6">
        <div className="inline-flex items-center gap-2 bg-[#c8362b]/10 text-[#c8362b] px-3 py-1 rounded-full text-xs font-semibold mb-3">
          {mode === "addon" ? "ADD-ON ORDER" : showChangeForm ? "CHANGE ORDER" : "ORDER FOR TOMORROW"}
        </div>
        <h2 className="text-2xl font-bold mb-1">{tomorrowLabel()}</h2>
        <p className="text-sm text-[#8b6f4e] mb-3">
          {mode === "addon"
            ? "Add extra quantities on top of today's order."
            : showChangeForm
              ? "Update your quantities. This will overwrite today's order."
              : "Set quantities and submit. Orders are placed the day before."}
        </p>

        {/* Item limit indicator */}
        <div className={`flex items-center justify-between text-xs font-semibold px-3 py-2 rounded-xl mb-4 ${
          atLimit
            ? "bg-red-50 text-red-700 border border-red-200"
            : remaining <= 5
              ? "bg-amber-50 text-amber-700 border border-amber-200"
              : "bg-[#f5f0e8] text-[#8b6f4e] border border-[#e8dcc8]"
        }`}>
          <span>
            {atLimit
              ? "Product limit reached — max 20 different products per order"
              : `${totalProducts} of ${MAX_ITEMS} products used`}
          </span>
          <span className={`font-bold ${atLimit ? "text-red-700" : remaining <= 5 ? "text-amber-700" : "text-[#6b5544]"}`}>
            {remaining > 0 ? `${remaining} left` : "0 left"}
          </span>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-5 space-y-2.5">
        {regulars.map((r) => {
          const k: LineKey = `r:${r.sheet_row}`;
          const product = r.product;
          const currentQty = qty[k] ?? 0;
          const isLocked = atLimit && currentQty === 0;
          return (
            <div key={r.id} className={`bg-white rounded-2xl border p-3 flex items-center gap-3 shadow-sm ${isLocked ? "border-[#e8dcc8] opacity-50" : "border-[#e8dcc8]"}`}>
              <div className="flex-1 min-w-0">
                <div className="font-semibold leading-tight text-sm">{product?.name ?? "—"}</div>
              </div>
              <QtyControl value={currentQty} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} disablePlus={isLocked} />
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
              <button
                onClick={() => setShowMore(false)}
                className="px-3 py-1.5 rounded-lg border-2 border-[#c8362b] text-[#c8362b] text-xs font-bold hover:bg-[#c8362b] hover:text-white transition shrink-0"
              >
                Hide
              </button>
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
                const currentQty = qty[k] ?? 0;
                const isLocked = atLimit && currentQty === 0;
                return (
                  <div key={p.id} className={`bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm ${isLocked ? "opacity-50" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{p.name}</div>
                    </div>
                    <QtyControl value={currentQty} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} disablePlus={isLocked} />
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
              <div className="text-xs text-[#8b6f4e]">Products selected</div>
              <div className="font-bold text-lg">{totalProducts} <span className="text-sm font-normal text-[#8b6f4e]">/ {MAX_ITEMS}</span></div>
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
              onClick={handleSubmitPress}
              disabled={submitting || totalProducts === 0}
              className="flex-1 bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-3 rounded-xl transition"
            >
              {submitting
                ? "Sending…"
                : mode === "addon"
                  ? "Submit Add-On"
                  : showChangeForm
                    ? "Save Changes"
                    : "Submit Order"}
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-red-700">{error}</div>}
        </div>
      </div>

      {showHistory && <HistoryModal history={history} onClose={() => setShowHistory(false)} />}
      {showMessageModal && (
        <MessageModal
          value={message}
          onChange={setMessage}
          onCancel={handleCancelMessage}
          onSend={handleSendMessage}
          sending={submitting}
        />
      )}
      {submitting && <SubmittingOverlay mode={mode} showChangeForm={showChangeForm} />}
    </div>
  );
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

function HistoryModal({
  history,
  onClose,
}: {
  history: Array<{
    id: string;
    for_date: string;
    total_items: number;
    created_at: string;
    order_type?: string | null;
    message?: string | null;
    items: Array<{ product_name: string; quantity: number }>;
  }>;
  onClose: () => void;
}) {
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
                {subs.map((s) => {
                  const tag = orderTypeTag(s.order_type);
                  return (
                    <div key={s.id} className="border border-[#e8dcc8] rounded-xl p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs text-[#8b6f4e]">
                          For {s.for_date} · {s.total_items} items
                        </div>
                        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${tag.className}`}>
                          {tag.label}
                        </span>
                      </div>
                      <ul className="text-sm space-y-1">
                        {s.items.map((it, i) => (
                          <li key={i} className="flex justify-between">
                            <span>{it.product_name}</span>
                            <span className="font-semibold">{it.quantity}</span>
                          </li>
                        ))}
                      </ul>
                      {s.message && (
                        <div className="mt-2 pt-2 border-t border-[#e8dcc8] text-xs text-[#6b5544]">
                          <span className="font-semibold">Note: </span>{s.message}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageModal({
  value,
  onChange,
  onCancel,
  onSend,
  sending,
}: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSend: () => void;
  sending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-2xl max-w-md w-full shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg mb-1">Add a message <span className="text-sm font-normal text-[#8b6f4e]">(optional)</span></h3>
        <p className="text-sm text-[#8b6f4e] mb-3">
          Add a quick note with your order (e.g. delivery time, special instructions).
        </p>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your message…"
          rows={4}
          className="w-full bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#c8362b] resize-none"
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            disabled={sending}
            className="flex-1 border border-[#e8dcc8] font-semibold py-3 rounded-xl hover:bg-[#fdf8f1] disabled:opacity-50"
          >
            Skip
          </button>
          <button
            onClick={onSend}
            disabled={sending}
            className="flex-1 bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-3 rounded-xl"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SubmittingOverlay({ mode, showChangeForm }: { mode: Mode; showChangeForm: boolean }) {
  const label = mode === "addon" ? "Adding to your order" : showChangeForm ? "Saving changes" : "Sending your order";
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
          <p className="font-bold text-[#2a1810]">{label}…</p>
          <p className="text-xs text-[#8b6f4e] mt-1">Just a moment, please don't close this page.</p>
        </div>
      </div>
    </div>
  );
}

function QtyControl({
  value,
  onAdjust,
  onSet,
  disablePlus,
}: {
  value: number;
  onAdjust: (d: number) => void;
  onSet: (n: number) => void;
  disablePlus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const display = focused && value === 0 ? "" : String(value);
  return (
    <div className="flex items-center gap-1.5">
      <button aria-label="−" onClick={() => onAdjust(-1)} className="w-9 h-9 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center text-lg font-bold active:scale-95">−</button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={display}
        onFocus={(e) => { setFocused(true); e.currentTarget.select(); }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          onSet(raw === "" ? 0 : parseInt(raw, 10));
        }}
        className="w-12 h-9 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b]"
      />
      <button
        aria-label="+"
        onClick={() => onAdjust(1)}
        disabled={disablePlus}
        className="w-9 h-9 rounded-full bg-[#c8362b] text-white flex items-center justify-center text-lg font-bold active:scale-95 disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e]"
      >+</button>
    </div>
  );
}