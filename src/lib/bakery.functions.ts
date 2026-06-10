import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function slugify(s: string) {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "x";
}

// ============================== READS ==============================

export const listCustomers = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("id, slug, name, driver, sort_order")
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data ?? [];
});

export const listProducts = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, name, category, image_url")
    .order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
});

export const getCustomerPage = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => z.object({ slug: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, slug, name, driver")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) return null;

    const { data: cps, error: cpErr } = await supabaseAdmin
      .from("customer_products")
      .select("id, sheet_row, sort_order, product:products(id, name, category, image_url)")
      .eq("customer_id", customer.id)
      .order("sort_order", { ascending: true });
    if (cpErr) throw cpErr;

    return { customer, regulars: cps ?? [] };
  });

// ============================== ORDER SUBMIT ==============================

const SubmitOrderInput = z.object({
  slug: z.string().min(1),
  forDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Items keyed by customer_product.id with quantity; productId optional for ad-hoc additions.
  items: z.array(
    z.object({
      sheetRow: z.number().int().positive(),
      productName: z.string().min(1),
      productId: z.string().uuid().nullable().optional(),
      quantity: z.number().int().min(0),
    }),
  ),
});

export const submitOrder = createServerFn({ method: "POST" })
  .inputValidator((d) => SubmitOrderInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { writeOrderQuantities } = await import("./sheets.server");

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);

    // 1) Write to Google Sheet (column C of Customer Order Details)
    await writeOrderQuantities(
      positive.map((i) => ({ row: i.sheetRow, quantity: i.quantity })),
    );

    // 2) Persist a copy for history / analytics
    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        for_date: data.forDate,
        total_items: totalItems,
        synced_to_sheet: true,
      })
      .select("id")
      .single();
    if (sErr) throw sErr;

    if (positive.length) {
      const rows = positive.map((i) => ({
        submission_id: submission.id,
        product_id: i.productId ?? null,
        product_name: i.productName,
        quantity: i.quantity,
        sheet_row: i.sheetRow,
      }));
      const { error: iErr } = await supabaseAdmin
        .from("order_submission_items")
        .insert(rows);
      if (iErr) throw iErr;
    }

    return { ok: true, submissionId: submission.id, totalItems };
  });

// ============================== SYNC FROM SHEET ==============================

export const syncFromSheet = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { readCustomerRows, readProductRows } = await import("./sheets.server");

  const productRows = await readProductRows();
  const customerRows = await readCustomerRows();

  // ---- Products ----
  const productMap = new Map<string, string | null>(); // name -> category
  for (const r of productRows.slice(1)) {
    const name = (r?.[0] ?? "").trim();
    if (!name) continue;
    productMap.set(name, (r?.[1] ?? "").trim() || null);
  }
  for (const r of customerRows.slice(1)) {
    const p = (r?.[1] ?? "").trim();
    if (p && !productMap.has(p)) productMap.set(p, null);
  }
  const productPayload = Array.from(productMap.entries()).map(([name, category]) => ({
    name,
    category,
  }));
  if (productPayload.length) {
    const { error } = await supabaseAdmin
      .from("products")
      .upsert(productPayload, { onConflict: "name", ignoreDuplicates: false });
    if (error) throw error;
  }

  // ---- Customers ----
  const seen = new Map<string, { driver: string | null; order: number }>();
  let order = 0;
  for (const r of customerRows.slice(1)) {
    const name = (r?.[0] ?? "").trim();
    if (!name || seen.has(name)) continue;
    order += 1;
    seen.set(name, { driver: (r?.[3] ?? "").trim() || null, order });
  }
  const slugUsed = new Set<string>();
  const customerPayload = Array.from(seen.entries()).map(([name, info]) => {
    let s = slugify(name);
    const base = s;
    let i = 2;
    while (slugUsed.has(s)) {
      s = `${base}-${i++}`;
    }
    slugUsed.add(s);
    return { name, slug: s, driver: info.driver, sort_order: info.order };
  });
  if (customerPayload.length) {
    const { error } = await supabaseAdmin
      .from("customers")
      .upsert(customerPayload, { onConflict: "name", ignoreDuplicates: false });
    // name has no unique constraint; fall back if needed
    if (error && !String(error.message).includes("on conflict")) throw error;
    if (error) {
      // try upsert by slug instead
      const { error: e2 } = await supabaseAdmin
        .from("customers")
        .upsert(customerPayload, { onConflict: "slug", ignoreDuplicates: true });
      if (e2) throw e2;
    }
  }

  // Re-read to get IDs
  const [{ data: dbCustomers }, { data: dbProducts }] = await Promise.all([
    supabaseAdmin.from("customers").select("id, name"),
    supabaseAdmin.from("products").select("id, name"),
  ]);
  const cId = new Map((dbCustomers ?? []).map((c) => [c.name, c.id]));
  const pId = new Map((dbProducts ?? []).map((p) => [p.name, p.id]));

  // ---- Customer_products (the row-to-product map) ----
  const cpPayload: Array<{
    customer_id: string;
    product_id: string;
    sheet_row: number;
    sort_order: number;
  }> = [];
  const counters = new Map<string, number>();
  for (let i = 1; i < customerRows.length; i++) {
    const r = customerRows[i];
    const cname = (r?.[0] ?? "").trim();
    const pname = (r?.[1] ?? "").trim();
    if (!cname || !pname) continue;
    const customer_id = cId.get(cname);
    const product_id = pId.get(pname);
    if (!customer_id || !product_id) continue;
    const next = (counters.get(cname) ?? 0) + 1;
    counters.set(cname, next);
    cpPayload.push({
      customer_id,
      product_id,
      sheet_row: i + 1, // sheet rows are 1-indexed and we skipped header
      sort_order: next,
    });
  }
  // Wipe and reinsert mappings to stay perfectly in sync with the sheet
  if (cpPayload.length) {
    const customerIds = Array.from(new Set(cpPayload.map((x) => x.customer_id)));
    await supabaseAdmin.from("customer_products").delete().in("customer_id", customerIds);
    // Insert in batches to avoid payload limits
    const batchSize = 500;
    for (let i = 0; i < cpPayload.length; i += batchSize) {
      const { error } = await supabaseAdmin
        .from("customer_products")
        .insert(cpPayload.slice(i, i + batchSize));
      if (error) throw error;
    }
  }

  return {
    customers: customerPayload.length,
    products: productPayload.length,
    mappings: cpPayload.length,
  };
});

// ============================== ADMIN: ORDER HISTORY ==============================

export const listSubmissions = createServerFn({ method: "GET" })
  .inputValidator((d: { customerId?: string; limit?: number }) =>
    z.object({ customerId: z.string().uuid().optional(), limit: z.number().int().min(1).max(500).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("order_submissions")
      .select("id, for_date, total_items, created_at, customer:customers(id, name, slug)")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.customerId) q = q.eq("customer_id", data.customerId);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const getSubmissionDetail = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: sub, error } = await supabaseAdmin
      .from("order_submissions")
      .select("id, for_date, total_items, created_at, customer:customers(id, name, slug)")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!sub) return null;
    const { data: items, error: iErr } = await supabaseAdmin
      .from("order_submission_items")
      .select("product_name, quantity, sheet_row")
      .eq("submission_id", data.id);
    if (iErr) throw iErr;
    return { ...sub, items: items ?? [] };
  });

// ============================== ANALYTICS ==============================

export const analyticsOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("order_submissions")
    .select("for_date, total_items, customer:customers(name), items:order_submission_items(product_name, quantity)")
    .order("for_date", { ascending: true })
    .limit(2000);
  if (error) throw error;
  return data ?? [];
});

// ============================== PRODUCT IMAGES ==============================

export const setProductImageUrl = createServerFn({ method: "POST" })
  .inputValidator((d: { productId: string; imageUrl: string | null }) =>
    z.object({ productId: z.string().uuid(), imageUrl: z.string().url().nullable() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("products")
      .update({ image_url: data.imageUrl })
      .eq("id", data.productId);
    if (error) throw error;
    return { ok: true };
  });

// ============================== ADD NEW CUSTOMER (writes to sheet) ==============================

const NewCustomerInput = z.object({
  name: z.string().min(1),
  driver: z.string().default("Collection"),
  productIds: z.array(z.string().uuid()).min(1),
});

export const createCustomerInSheet = createServerFn({ method: "POST" })
  .inputValidator((d) => NewCustomerInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { appendCustomerRows } = await import("./sheets.server");

    const { data: products, error: pErr } = await supabaseAdmin
      .from("products")
      .select("id, name")
      .in("id", data.productIds);
    if (pErr) throw pErr;
    if (!products?.length) throw new Error("No products selected");

    // Append to sheet
    const startRow = await appendCustomerRows(
      products.map((p) => ({ customer: data.name, product: p.name, driver: data.driver })),
    );
    if (!startRow) throw new Error("Sheet did not return inserted row range");

    // Create slug and customer record
    let slug = slugify(data.name);
    const base = slug;
    let i = 2;
    while (true) {
      const { data: exists } = await supabaseAdmin
        .from("customers")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (!exists) break;
      slug = `${base}-${i++}`;
    }

    const { data: newCustomer, error: cErr } = await supabaseAdmin
      .from("customers")
      .insert({ name: data.name, slug, driver: data.driver, sort_order: 9999 })
      .select("id, slug")
      .single();
    if (cErr) throw cErr;

    const cpRows = products.map((p, idx) => ({
      customer_id: newCustomer.id,
      product_id: p.id,
      sheet_row: startRow + idx,
      sort_order: idx + 1,
    }));
    const { error: cpErr } = await supabaseAdmin.from("customer_products").insert(cpRows);
    if (cpErr) throw cpErr;

    return { ok: true, slug: newCustomer.slug, startRow, count: products.length };
  });
