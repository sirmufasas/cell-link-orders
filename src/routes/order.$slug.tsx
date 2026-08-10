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

function getNextDeliveryDate(): Date {
  const d = new Date();
  const dow = d.getDay();
  const addDays = dow === 6 ? 2 : 1;
  d.setDate(d.getDate() + addDays);
  return d;
}
function tomorrowISO() {
  return getNextDeliveryDate().toISOString().slice(0, 10);
}
function tomorrowLabel() {
  return getNextDeliveryDate().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
function dateLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

type LineKey = string;
type Mode = "default" | "addon";

const KOTA_ONLY_PREFIXES = ["rolls kota", "kota"];
const RIO_MED_ONLY_PREFIXES = ["rolls rio/med", "rio/med"];
const PRODUCT_LIMIT = 20;

function isKotaOnlyProduct(name: string | undefined | null) {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  return KOTA_ONLY_PREFIXES.some((prefix) => n.startsWith(prefix));
}

function isRioMedOnlyProduct(name: string | undefined | null) {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  return RIO_MED_ONLY_PREFIXES.some((prefix) => n.startsWith(prefix)) || n.includes("rio/med");
}

function isRioMedCustomer(customerName: string) {
  const n = customerName.trim().toLowerCase();
  return n.includes("mediterranean") || n.includes("rio douro");
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type OrderSchedule = { days: number[]; deliveryDays: string };

const ORDER_SCHEDULES: Array<{ match: (name: string) => boolean; schedule: OrderSchedule }> = [
  {
    match: (n) => ["dalpark", "carnival", "lambton"].some((k) => n.includes(k)),
    schedule: { days: [0, 2, 4], deliveryDays: "Mon/Wed/Fri" },
  },
  {
    match: (n) => n.includes("braza"),
    schedule: { days: [1, 3, 5], deliveryDays: "Tue/Thu/Sat" },
  },
  {
    match: (n) => n.includes("nossa cassa"),
    schedule: { days: [3], deliveryDays: "Thu" },
  },
];

function getOrderSchedule(customerName: string): OrderSchedule | null {
  const n = customerName.trim().toLowerCase();
  for (const rule of ORDER_SCHEDULES) {
    if (rule.match(n)) return rule.schedule;
  }
  return null;
}

function nextAllowedOrderDay(days: number[], today: number): string {
  for (let i = 1; i <= 7; i++) {
    const d = (today + i) % 7;
    if (days.includes(d)) return DAY_NAMES[d];
  }
  return DAY_NAMES[days[0]];
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

  useEffect(() => {
    try {
      localStorage.setItem("pb-customer-slug", slug);
    } catch {}
  }, [slug]);

  const isKotaJoe = customer.name.trim().toLowerCase().startsWith("kota joe");
  const canSeeRioMed = useMemo(() => isRioMedCustomer(customer.name), [customer.name]);
  const regulars = useMemo(
    () =>
      regularsAll.filter((r) => {
        if (!isKotaJoe && isKotaOnlyProduct(r.product?.name)) return false;
        if (!canSeeRioMed && isRioMedOnlyProduct(r.product?.name)) return false;
        return true;
      }),
    [regularsAll, isKotaJoe, canSeeRioMed],
  );

  const [qty, setQty] = useState<Record<LineKey, number>>({});
  const [showMore, setShowMore] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [mode, setMode] = useState<Mode>("default");

  const [showMessageModal, setShowMessageModal] = useState(false);
  const [message, setMessage] = useState("");
  // Sender name — persisted across the session so they only type it once
  const [senderName, setSenderName] = useState("");
  const [messageModalSkipped, setMessageModalSkipped] = useState(false);

  const { data: allProducts } = useSuspenseQuery(allProductsQuery);

  const orderSchedule = useMemo(() => getOrderSchedule(customer.name), [customer.name]);
  const todayDow = new Date().getDay();
  const orderingBlocked = !!orderSchedule && !orderSchedule.days.includes(todayDow);

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
      if (!canSeeRioMed && isRioMedOnlyProduct(p.name)) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s);
    });
  }, [allProducts, regularProductIds, productSearch, showMore, isKotaJoe, canSeeRioMed]);

  const totalItems = Object.values(qty).reduce((a, b) => a + b, 0);

  const usedProductCount = useMemo(
    () => Object.values(qty).filter((v) => v > 0).length,
    [qty],
  );
  const remainingProductSlots = PRODUCT_LIMIT - usedProductCount;
  const atProductLimit = usedProductCount >= PRODUCT_LIMIT;

  const limitPillClass = atProductLimit
    ? "bg-red-100 text-red-700"
    : remainingProductSlots <= 5
      ? "bg-amber-100 text-amber-800"
      : "bg-[#c8362b]/10 text-[#c8362b]";

  const adjust = (k: LineKey, delta: number) =>
    setQty((s) => {
      const current = s[k] || 0;
      if (delta > 0 && current === 0) {
        const usedNow = Object.values(s).filter((v) => v > 0).length;
        if (usedNow >= PRODUCT_LIMIT) return s;
      }
      return { ...s, [k]: Math.max(0, current + delta) };
    });

  const setN = (k: LineKey, n: number) =>
    setQty((s) => {
      const current = s[k] || 0;
      const newVal = Math.max(0, n || 0);
      if (current === 0 && newVal > 0) {
        const usedNow = Object.values(s).filter((v) => v > 0).length;
        if (usedNow >= PRODUCT_LIMIT) return s;
      }
      return { ...s, [k]: newVal };
    });

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
    setSubmitting(true);
    setError(null);
    try {
      const items = buildItems();
      if (items.length > PRODUCT_LIMIT) {
        setError(`You can only order up to ${PRODUCT_LIMIT} different products at once.`);
        setSubmitting(false);
        return;
      }

      // Build the full message: "Name: comment" or just "Name" if no comment
      const fullMessage = msg.trim()
        ? `${senderName.trim()}: ${msg.trim()}`
        : senderName.trim();

      if (mode === "addon") {
        await addOnToOrder({ data: { slug, forDate: tomorrowISO(), items, message: fullMessage } });
      } else if (showChangeForm) {
        await changeOrder({ data: { slug, forDate: tomorrowISO(), items, message: fullMessage } });
      } else {
        await submitOrder({ data: { slug, forDate: tomorrowISO(), items, message: fullMessage } });
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

  function handleSendMessage() {
    setShowMessageModal(false);
    void handleSubmit(message);
  }

  function handleSkipMessage() {
    // Skip only skips the comment — name was already validated in the modal
    setShowMessageModal(false);
    setMessageModalSkipped(true);
    void handleSubmit("");
  }

  function handleSubmitClick() {
    // If they've already filled their name in and skipped once, go straight through
    if (messageModalSkipped && senderName.trim()) {
      void handleSubmit(message);
    } else {
      setShowMessageModal(true);
    }
  }

  // ===== Delivery-day blocked screen =====
  if (orderingBlocked && orderSchedule) {
    const nextDay = nextAllowedOrderDay(orderSchedule.days, todayDow);
    return (
      <div className="min-h-screen bg-[#fdf8f1] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-lg border border-[#e8dcc8] p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold mb-2">Orders aren't open today</h1>
          <p className="text-[#6b5544] mb-1">
            <strong>{customer.name}</strong> delivers on <strong>{orderSchedule.deliveryDays}</strong>.
          </p>
          <p className="text-[#6b5544] mb-4">
            Please wait until <strong>{nextDay}</strong> to place your order.
          </p>
          <div className="flex flex-col gap-2 mt-2">
            <button
              onClick={() => setShowHistory(true)}
              className="border border-[#e8dcc8] hover:bg-[#fdf8f1] font-semibold py-3 rounded-xl"
            >
              History
            </button>
          </div>
        </div>
        {showHistory && <HistoryModal history={history} onClose={() => setShowHistory(false)} />}
      </div>
    );
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
            <p className="text-xs text-[#8b6f4e] italic mb-3 border border-[#e8dcc8] rounded-xl px-3 py-2 bg-[#fdf8f1]">
              💬 {todayOrder.message}
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

  // ===== Order form =====
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
        <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold mb-3 ${limitPillClass}`}>
          {usedProductCount} of {PRODUCT_LIMIT} products used
          {atProductLimit ? " · Limit reached" : ` · ${remainingProductSlots} left`}
        </div>
      </div>

      <div className="max-w-xl mx-auto px-5 space-y-2.5">
        {regulars.map((r) => {
          const k: LineKey = `r:${r.sheet_row}`;
          const product = r.product;
          const rowQty = qty[k] ?? 0;
          const locked = atProductLimit && rowQty === 0;
          return (
            <div
              key={r.id}
              className={`bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm transition-opacity ${locked ? "opacity-50" : ""}`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-semibold leading-tight text-sm">{product?.name ?? "—"}</div>
              </div>
              <QtyControl value={rowQty} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} locked={locked} />
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
                const rowQty = qty[k] ?? 0;
                const locked = atProductLimit && rowQty === 0;
                return (
                  <div
                    key={p.id}
                    className={`bg-white rounded-2xl border border-[#e8dcc8] p-3 flex items-center gap-3 shadow-sm transition-opacity ${locked ? "opacity-50" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{p.name}</div>
                    </div>
                    <QtyControl value={rowQty} onAdjust={(d) => adjust(k, d)} onSet={(n) => setN(k, n)} locked={locked} />
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
              <div className="text-xs text-[#8b6f4e]">Products</div>
              <div className={`font-bold text-lg ${atProductLimit ? "text-red-600" : remainingProductSlots <= 5 ? "text-amber-600" : ""}`}>
                {usedProductCount} / {PRODUCT_LIMIT}
              </div>
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
              onClick={handleSubmitClick}
              disabled={submitting || totalItems === 0 || usedProductCount > PRODUCT_LIMIT}
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
          senderName={senderName}
          onSenderNameChange={setSenderName}
          onSkip={handleSkipMessage}
          onSend={handleSendMessage}
          sending={submitting}
        />
      )}
      {submitting && <SubmittingOverlay mode={mode} showChangeForm={showChangeForm} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History modal — now shows the message per order
// ---------------------------------------------------------------------------
function orderTypeTag(type?: string | null) {
  switch (type) {
    case "changed": return { label: "Changed Order", className: "bg-amber-100 text-amber-800" };
    case "added":   return { label: "Added Order",   className: "bg-blue-100 text-blue-800" };
    case "late":    return { label: "Late Order",    className: "bg-red-100 text-red-800" };
    default:        return { label: "New Order",     className: "bg-green-100 text-green-800" };
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
                      {/* ── Message now shown in history ── */}
                      {s.message && (
                        <p className="mt-2 text-xs text-[#8b6f4e] italic border-t border-[#e8dcc8] pt-2">
                          💬 {s.message}
                        </p>
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

// ---------------------------------------------------------------------------
// MessageModal — compulsory name + optional comment, Tab key blocked
// ---------------------------------------------------------------------------
function MessageModal({
  value,
  onChange,
  senderName,
  onSenderNameChange,
  onSkip,
  onSend,
  sending,
}: {
  value: string;
  onChange: (v: string) => void;
  senderName: string;
  onSenderNameChange: (v: string) => void;
  onSkip: () => void;
  onSend: () => void;
  sending: boolean;
}) {
  const nameEmpty = senderName.trim() === "";

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  return (
    // No onClick on backdrop — must explicitly choose Skip or Send
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-xl p-5">
        <h3 className="font-bold text-lg mb-1">Almost there!</h3>
        <p className="text-sm text-[#8b6f4e] mb-4">
          Please enter your name — it helps us know who placed the order.
        </p>

        {/* Compulsory name field */}
        <label className="block mb-1">
          <span className="text-xs font-bold uppercase tracking-wide text-[#2a1810]">
            Your name <span className="text-[#c8362b]">*</span>
          </span>
          <input
            autoFocus
            type="text"
            value={senderName}
            onChange={(e) => onSenderNameChange(e.target.value)}
            placeholder="e.g. John"
            className={`mt-1 w-full bg-[#fdf8f1] border rounded-xl px-4 py-3 text-sm focus:outline-none transition ${
              nameEmpty
                ? "border-[#c8362b] focus:border-[#c8362b]"
                : "border-[#e8dcc8] focus:border-[#c8362b]"
            }`}
          />
          {nameEmpty && (
            <p className="text-xs text-[#c8362b] mt-1">Name is required to send your order.</p>
          )}
        </label>

        {/* Optional comment — Tab key blocked */}
        <label className="block mt-4 mb-1">
          <span className="text-xs font-bold uppercase tracking-wide text-[#2a1810]">
            Comment <span className="text-[#8b6f4e] font-normal">(optional)</span>
          </span>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder="e.g. delivery time, special instructions…"
            rows={3}
            className="mt-1 w-full bg-[#fdf8f1] border border-[#e8dcc8] rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-[#c8362b] resize-none"
          />
        </label>

        <div className="flex gap-2 mt-4">
          <button
            onClick={onSkip}
            disabled={sending || nameEmpty}
            title={nameEmpty ? "Please enter your name first" : "Send without a comment"}
            className="flex-1 border border-[#e8dcc8] font-semibold py-3 rounded-xl hover:bg-[#fdf8f1] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Skip comment
          </button>
          <button
            onClick={onSend}
            disabled={sending || nameEmpty}
            title={nameEmpty ? "Please enter your name first" : "Send order"}
            className="flex-1 bg-[#c8362b] hover:bg-[#a82a22] disabled:bg-[#e8dcc8] disabled:text-[#8b6f4e] text-white font-bold py-3 rounded-xl disabled:cursor-not-allowed"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubmittingOverlay + QtyControl — unchanged
// ---------------------------------------------------------------------------
function SubmittingOverlay({ mode, showChangeForm }: { mode: Mode; showChangeForm: boolean }) {
  const label = mode === "addon" ? "Adding to your order" : showChangeForm ? "Saving changes" : "Sending your order";
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-xl px-8 py-7 flex flex-col items-center gap-4 max-w-xs w-full text-center">
        <svg className="animate-spin w-9 h-9 text-[#c8362b]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
  locked,
}: {
  value: number;
  onAdjust: (d: number) => void;
  onSet: (n: number) => void;
  locked?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const display = focused && value === 0 ? "" : String(value);
  return (
    <div className="flex items-center gap-1.5">
      <button
        aria-label="−"
        onClick={() => onAdjust(-1)}
        className="w-9 h-9 rounded-full bg-[#fdf8f1] border border-[#e8dcc8] flex items-center justify-center text-lg font-bold active:scale-95"
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={display}
        readOnly={!!locked}
        onFocus={(e) => { setFocused(true); e.currentTarget.select(); }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          if (locked) return;
          const raw = e.target.value.replace(/[^0-9]/g, "");
          onSet(raw === "" ? 0 : parseInt(raw, 10));
        }}
        className={`w-12 h-9 text-center font-bold border border-[#e8dcc8] rounded-lg bg-[#fdf8f1] focus:outline-none focus:border-[#c8362b] ${locked ? "opacity-60 cursor-not-allowed" : ""}`}
      />
      <button
        aria-label="+"
        onClick={() => { if (!locked) onAdjust(1); }}
        disabled={!!locked}
        className={`w-9 h-9 rounded-full flex items-center justify-center text-lg font-bold ${locked ? "bg-[#e8dcc8] text-[#8b6f4e] cursor-not-allowed" : "bg-[#c8362b] text-white active:scale-95"}`}
      >
        +
      </button>
    </div>
  );
}
