import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function slugify(s: string) {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "x";
}

function tomorrowISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
    .select("id, name, category, image_url, ingredients")
    .not("name", "ilike", "%insert products above%")
    .order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
});

export const getCustomerPage = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => z.object({ slug: z.string().min(1) }).parse(d))
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
      .select("id, sheet_row, sort_order, product:products(id, name, category, image_url, ingredients)")
      .eq("customer_id", customer.id)
      .order("sort_order", { ascending: true });
    if (cpErr) throw cpErr;

    // Cleanup: delete history older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin.from("order_submissions").delete().lt("created_at", sevenDaysAgo);

    const todayKey = tomorrowISO();
    const { data: todaySubs } = await supabaseAdmin
      .from("order_submissions")
      .select(
        "id, for_date, total_items, created_at, order_type, message, items:order_submission_items(product_id, product_name, quantity, sheet_row)",
      )
      .eq("customer_id", customer.id)
      .eq("for_date", todayKey)
      .order("created_at", { ascending: false })
      .limit(1);
    const todayOrder = todaySubs?.[0] ?? null;

    const { count: priorCount } = await supabaseAdmin
      .from("order_submissions")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customer.id);

    const { data: history } = await supabaseAdmin
      .from("order_submissions")
      .select(
        "id, for_date, total_items, created_at, order_type, message, items:order_submission_items(product_name, quantity)",
      )
      .eq("customer_id", customer.id)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false });

    return {
      customer,
      regulars: cps ?? [],
      todayOrder,
      hasPriorOrders: (priorCount ?? 0) > 0,
      history: history ?? [],
    };
  });

// ============================== ORDER SUBMIT ==============================

const SubmitItem = z.object({
  // sheetRow === 0 means: this product is not in customer's regulars; insert a new row in the sheet.
  sheetRow: z.number().int().min(0),
  productName: z.string().min(1),
  productId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(0),
});

const SubmitOrderInput = z.object({
  slug: z.string().min(1),
  forDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(SubmitItem),
  // Required note from the customer — written to column J ("Comments") on
  // every sheet row touched by this submission. The order will not go
  // through without this.
  message: z.string().min(1),
});

export const submitOrder = createServerFn({ method: "POST" })
  .validator((d) => SubmitOrderInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { writeOrderQuantities, insertCustomerProductRow, writeOrderComment } = await import(
      "@/lib/sheets.server"
    );

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, name")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);

    // 1) For items without a sheet row, insert a new row first (immediately below the customer's last row)
    let insertedAny = false;
    for (const item of positive) {
      if (item.sheetRow === 0) {
        const newRow = await insertCustomerProductRow({
          customerName: customer.name,
          productName: item.productName,
          quantity: item.quantity,
        });
        item.sheetRow = newRow;
        insertedAny = true;
      }
    }

    // 2) Write column C for all positive items
    await writeOrderQuantities(
      positive.map((i) => ({ row: i.sheetRow, quantity: i.quantity })),
    );

    // 2b) Write the customer's message into column J on every row touched
    await writeOrderComment(positive.map((i) => i.sheetRow), data.message);

    // 3) Persist a copy for history / analytics
    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        for_date: data.forDate,
        total_items: totalItems,
        synced_to_sheet: true,
        order_type: "new",
        message: data.message,
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

    return { ok: true, submissionId: submission.id, totalItems, insertedAny };
  });

// ============================== CHANGE ORDER ==============================
// Clears ALL of the customer's existing sheet rows (column C and any add-on
// columns F..Z) before writing in the freshly submitted quantities. This is
// different from submitOrder, which only overwrites the rows present in the
// submitted items array and leaves untouched rows with their old quantity.

export const changeOrder = createServerFn({ method: "POST" })
  .validator((d) => SubmitOrderInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      readCustomerRows,
      writeOrderQuantities,
      insertCustomerProductRow,
      clearAddOnColumns,
      writeOrderComment,
    } = await import("@/lib/sheets.server");

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, name")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    // 1) Find every row in the sheet that currently belongs to this customer
    //    (column A match), regardless of what's cached in customer_products.
    const allRows = await readCustomerRows();
    const customerRowNumbers: number[] = [];
    for (let i = 1; i < allRows.length; i++) {
      if ((allRows[i]?.[0] ?? "").trim() === customer.name) {
        customerRowNumbers.push(i + 1); // 1-based sheet row
      }
    }

    // 2) Clear column C on every one of those rows, and blank out any
    //    add-on columns (F..Z) that may have been used previously.
    if (customerRowNumbers.length) {
      await writeOrderQuantities(customerRowNumbers.map((row) => ({ row, quantity: 0 })));
      await clearAddOnColumns(customerRowNumbers);
    }

    // 3) Now write the new order, same as submitOrder: insert rows for new
    //    products, then write quantities for everything positive.
    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);

    let insertedAny = false;
    for (const item of positive) {
      if (item.sheetRow === 0) {
        const newRow = await insertCustomerProductRow({
          customerName: customer.name,
          productName: item.productName,
          quantity: item.quantity,
        });
        item.sheetRow = newRow;
        insertedAny = true;
      }
    }

    await writeOrderQuantities(positive.map((i) => ({ row: i.sheetRow, quantity: i.quantity })));

    // 3b) Write the customer's message into column J on every row touched
    await writeOrderComment(positive.map((i) => i.sheetRow), data.message);

    // 4) Persist a history record, same shape as submitOrder.
    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        for_date: data.forDate,
        total_items: totalItems,
        synced_to_sheet: true,
        order_type: "changed",
        message: data.message,
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
      const { error: iErr } = await supabaseAdmin.from("order_submission_items").insert(rows);
      if (iErr) throw iErr;
    }

    return { ok: true, submissionId: submission.id, totalItems, insertedAny };
  });

// ============================== ADD-ON ORDER ==============================

export const addOnToOrder = createServerFn({ method: "POST" })
  .validator((d) => SubmitOrderInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { addOnQuantityToRow, insertCustomerProductRow, writeOrderComment } = await import(
      "@/lib/sheets.server"
    );

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, name")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);

    for (const item of positive) {
      if (item.sheetRow === 0) {
        // New product — insert row first with quantity 0, then add-on writes to F
        const newRow = await insertCustomerProductRow({
          customerName: customer.name,
          productName: item.productName,
          quantity: 0,
        });
        item.sheetRow = newRow;
      }
      await addOnQuantityToRow(item.sheetRow, item.quantity);
    }

    // Write the customer's message into column J on every row touched
    await writeOrderComment(positive.map((i) => i.sheetRow), data.message);

    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        for_date: data.forDate,
        total_items: totalItems,
        synced_to_sheet: true,
        order_type: "added",
        message: data.message,
      })
      .select("id")
      .single();
    if (sErr) throw sErr;

    if (positive.length) {
      await supabaseAdmin.from("order_submission_items").insert(
        positive.map((i) => ({
          submission_id: submission.id,
          product_id: i.productId ?? null,
          product_name: i.productName,
          quantity: i.quantity,
          sheet_row: i.sheetRow,
        })),
      );
    }

    return { ok: true, submissionId: submission.id, totalItems };
  });

// ============================== SYNC FROM SHEET ==============================

export const syncFromSheet = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { readCustomerRows, readProductRows } = await import("@/lib/sheets.server");

  const productRows = await readProductRows();
  const customerRows = await readCustomerRows();

  const isSentinel = (s: string) => /insert products above/i.test(s);
  const productMap = new Map<string, string | null>();
  for (const r of productRows.slice(1)) {
    const name = (r?.[0] ?? "").trim();
    if (!name || isSentinel(name)) continue;
    productMap.set(name, (r?.[1] ?? "").trim() || null);
  }
  for (const r of customerRows.slice(1)) {
    const p = (r?.[1] ?? "").trim();
    if (p && !isSentinel(p) && !productMap.has(p)) productMap.set(p, null);
  }

  const { data: existingProducts } = await supabaseAdmin
    .from("products")
    .select("id, name, category, image_url");
  const existingByName = new Map((existingProducts ?? []).map((p) => [p.name, p]));

  for (const [name, category] of productMap) {
    const ex = existingByName.get(name);
    if (ex) {
      if ((ex.category ?? null) !== category) {
        await supabaseAdmin.from("products").update({ category }).eq("id", ex.id);
      }
    } else {
      const { data: ins } = await supabaseAdmin
        .from("products")
        .insert({ name, category })
        .select("id, name, category, image_url")
        .single();
      if (ins) existingByName.set(name, ins);
    }
  }

  const seen = new Map<string, { driver: string | null; order: number }>();
  let order = 0;
  for (const r of customerRows.slice(1)) {
    const name = (r?.[0] ?? "").trim();
    if (!name || seen.has(name)) continue;
    order += 1;
    seen.set(name, { driver: (r?.[3] ?? "").trim() || null, order });
  }

  const { data: existingCustomers } = await supabaseAdmin
    .from("customers")
    .select("id, name, slug, driver");
  const existingByCName = new Map((existingCustomers ?? []).map((c) => [c.name, c]));
  const slugUsed = new Set<string>((existingCustomers ?? []).map((c) => c.slug));

  let customersTouched = 0;
  for (const [name, info] of seen) {
    const ex = existingByCName.get(name);
    if (ex) {
      await supabaseAdmin
        .from("customers")
        .update({ driver: info.driver, sort_order: info.order })
        .eq("id", ex.id);
    } else {
      let s = slugify(name);
      const base = s;
      let i = 2;
      while (slugUsed.has(s)) s = `${base}-${i++}`;
      slugUsed.add(s);
      const { data: ins } = await supabaseAdmin
        .from("customers")
        .insert({ name, slug: s, driver: info.driver, sort_order: info.order })
        .select("id, name, slug, driver")
        .single();
      if (ins) existingByCName.set(name, ins);
    }
    customersTouched += 1;
  }

  const cId = new Map(Array.from(existingByCName.entries()).map(([n, c]) => [n, c.id]));
  const pId = new Map(Array.from(existingByName.entries()).map(([n, p]) => [n, p.id]));

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
      sheet_row: i + 1,
      sort_order: next,
    });
  }

  if (cpPayload.length) {
    const customerIds = Array.from(new Set(cpPayload.map((x) => x.customer_id)));
    await supabaseAdmin.from("customer_products").delete().in("customer_id", customerIds);
    const batchSize = 500;
    for (let i = 0; i < cpPayload.length; i += batchSize) {
      const { error } = await supabaseAdmin
        .from("customer_products")
        .insert(cpPayload.slice(i, i + batchSize));
      if (error) throw error;
    }
  }

  return {
    customers: customersTouched,
    products: productMap.size,
    mappings: cpPayload.length,
  };
});

export const ensureSeeded = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("customers")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) return { seeded: false };
  await syncFromSheet();
  return { seeded: true };
});

// ============================== ACTIVE SHEET INFO ==============================

export const getActiveSheetInfo = createServerFn({ method: "GET" }).handler(async () => {
  const { getActiveSheetUrl, getActiveSheetLabel } = await import("@/lib/sheets.server");
  return {
    url: getActiveSheetUrl(),
    label: getActiveSheetLabel(),
  };
});

// ============================== ADMIN ==============================

export const listSubmissions = createServerFn({ method: "GET" })
  .validator((d: { customerId?: string; limit?: number }) =>
    z.object({ customerId: z.string().uuid().optional(), limit: z.number().int().min(1).max(500).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("order_submissions")
      .select("id, for_date, total_items, created_at, order_type, customer:customers(id, name, slug)")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.customerId) q = q.eq("customer_id", data.customerId);
    const { data: rows, error } = await q;
    if (error) throw error;
    return rows ?? [];
  });

export const getSubmissionDetail = createServerFn({ method: "GET" })
  .validator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
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
      .eq("submission_id", data.id)
      .order("product_name", { ascending: true });
    if (iErr) throw iErr;
    return { ...sub, items: items ?? [] };
  });

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

export const setProductImageUrl = createServerFn({ method: "POST" })
  .validator((d: { productId: string; imageUrl: string | null }) =>
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

const NewCustomerInput = z.object({
  name: z.string().min(1),
  driver: z.string().default("Collection"),
  productIds: z.array(z.string().uuid()).min(1),
});

export const createCustomerInSheet = createServerFn({ method: "POST" })
  .validator((d) => NewCustomerInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { appendCustomerRows } = await import("@/lib/sheets.server");

    const { data: products, error: pErr } = await supabaseAdmin
      .from("products")
      .select("id, name")
      .in("id", data.productIds);
    if (pErr) throw pErr;
    if (!products?.length) throw new Error("No products selected");

    const startRow = await appendCustomerRows(
      products.map((p) => ({ customer: data.name, product: p.name, driver: data.driver })),
    );
    if (!startRow) throw new Error("Sheet did not return inserted row range");

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

// ============================== ESTIMATES ==============================
// No date dimension: each product has ONE persistent estimate quantity
// that carries forward every day until someone edits and saves it.

export const getEstimateProducts = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: products, error: pErr } = await supabaseAdmin
    .from("products")
    .select("id, name, category")
    .not("name", "ilike", "%insert products above%")
    .order("name", { ascending: true });
  if (pErr) throw pErr;

  const { data: estimates, error: eErr } = await supabaseAdmin
    .from("product_estimates")
    .select("product_id, quantity");
  if (eErr) throw eErr;

  const qtyByProduct = new Map((estimates ?? []).map((e) => [e.product_id, e.quantity]));
  return (products ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category ?? "Uncategorized",
    quantity: qtyByProduct.get(p.id) ?? 0,
  }));
});

const EstimateUpdate = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(0) });
const SaveEstimatesInput = z.object({
  updates: z.array(EstimateUpdate),
});

export const saveEstimates = createServerFn({ method: "POST" })
  .validator((d) => SaveEstimatesInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (!data.updates.length) return { ok: true, updated: 0 };

    const { data: existing, error: exErr } = await supabaseAdmin
      .from("product_estimates")
      .select("id, product_id")
      .in("product_id", data.updates.map((u) => u.productId));
    if (exErr) throw exErr;
    const existingByProduct = new Map((existing ?? []).map((r) => [r.product_id, r.id]));

    const toInsert: Array<{ product_id: string; quantity: number }> = [];
    const toUpdate: Array<{ id: string; quantity: number }> = [];
    const toDelete: string[] = [];

    for (const u of data.updates) {
      const existingId = existingByProduct.get(u.productId);
      if (u.quantity > 0) {
        if (existingId) toUpdate.push({ id: existingId, quantity: u.quantity });
        else toInsert.push({ product_id: u.productId, quantity: u.quantity });
      } else if (existingId) {
        toDelete.push(existingId);
      }
    }

    if (toInsert.length) {
      const { error } = await supabaseAdmin.from("product_estimates").insert(toInsert);
      if (error) throw error;
    }
    for (const u of toUpdate) {
      const { error } = await supabaseAdmin.from("product_estimates").update({ quantity: u.quantity }).eq("id", u.id);
      if (error) throw error;
    }
    if (toDelete.length) {
      const { error } = await supabaseAdmin.from("product_estimates").delete().in("id", toDelete);
      if (error) throw error;
    }

    return { ok: true, updated: data.updates.length };
  });

// ============================== PRODUCT STOCKS ==============================
// Two completely separate tables — freezer and production — not one table
// with a "section" column. Each persists independently.

const StockSection = z.enum(["Production", "Freezer"]);

function stockTableFor(section: "Production" | "Freezer") {
  return section === "Freezer" ? "product_stocks_freezer" : "product_stocks_production";
}

export const getProductStocks = createServerFn({ method: "GET" })
  .validator((d: { section: "Production" | "Freezer" }) =>
    z.object({ section: StockSection }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: products, error: pErr } = await supabaseAdmin
      .from("products")
      .select("id, name, category")
      .not("name", "ilike", "%insert products above%")
      .order("name", { ascending: true });
    if (pErr) throw pErr;

    const table = stockTableFor(data.section);
    const { data: stocks, error: sErr } = await supabaseAdmin
      .from(table)
      .select("product_id, quantity");
    if (sErr) throw sErr;

    const qtyByProduct = new Map((stocks ?? []).map((s: any) => [s.product_id, s.quantity]));
    return (products ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category ?? "Uncategorized",
      quantity: qtyByProduct.get(p.id) ?? 0,
    }));
  });

const StockUpdate = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(0) });
const SaveStocksInput = z.object({ section: StockSection, updates: z.array(StockUpdate) });

export const saveProductStocks = createServerFn({ method: "POST" })
  .validator((d) => SaveStocksInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (!data.updates.length) return { ok: true, updated: 0 };

    const table = stockTableFor(data.section);

    const { data: existing, error: exErr } = await supabaseAdmin
      .from(table)
      .select("id, product_id")
      .in("product_id", data.updates.map((u) => u.productId));
    if (exErr) throw exErr;
    const existingByProduct = new Map((existing ?? []).map((r: any) => [r.product_id, r.id]));

    const toInsert: Array<{ product_id: string; quantity: number }> = [];
    const toUpdate: Array<{ id: string; quantity: number }> = [];

    for (const u of data.updates) {
      const existingId = existingByProduct.get(u.productId);
      if (existingId) toUpdate.push({ id: existingId, quantity: u.quantity });
      else toInsert.push({ product_id: u.productId, quantity: u.quantity });
    }

    if (toInsert.length) {
      const { error } = await supabaseAdmin.from(table).insert(toInsert);
      if (error) throw error;
    }
    for (const u of toUpdate) {
      const { error } = await supabaseAdmin
        .from(table)
        .update({ quantity: u.quantity, updated_at: new Date().toISOString() })
        .eq("id", u.id);
      if (error) throw error;
    }

    return { ok: true, updated: data.updates.length };
  });