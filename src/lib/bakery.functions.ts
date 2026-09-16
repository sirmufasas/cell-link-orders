import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { tomorrowISOInBakeryTimezone, bakeryMinutesNow } from "@/lib/sheets.server";

function slugify(s: string) {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "x";
}

function tomorrowISO(): string {
  return tomorrowISOInBakeryTimezone();
}

const LATE_CUTOFF_HOUR = 19;
const LATE_CUTOFF_MINUTE = 0;

function isLateOrder(): boolean {
  const cutoff = LATE_CUTOFF_HOUR * 60 + LATE_CUTOFF_MINUTE;
  return bakeryMinutesNow() >= cutoff;
}

/**
 * Returns the id of a sheet group row, or null if the sheet-groups
 * migration hasn't been applied to the DB yet. Every code path that uses
 * the new tables/columns checks this and degrades to the old behavior when
 * it's null — so this code can be deployed before OR after the migration,
 * in either order, without breaking.
 */
async function groupIdBySlug(slug: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("sheet_groups")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (error) return null;
    return data?.id ?? null;
  } catch {
    return null;
  }
}

const AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
let lastAutoSyncAt = 0;
let autoSyncInFlight: Promise<void> | null = null;

async function maybeAutoSync(): Promise<void> {
  const now = Date.now();
  if (now - lastAutoSyncAt < AUTO_SYNC_INTERVAL_MS) return;

  if (autoSyncInFlight) {
    await autoSyncInFlight;
    return;
  }

  lastAutoSyncAt = now;
  const { getActiveSheetId } = await import("@/lib/sheets.server");
  autoSyncInFlight = runSheetSync(getActiveSheetId())
    .then(() => undefined)
    .catch((err) => {
      lastAutoSyncAt = 0;
      console.error("Auto-sync from sheet failed:", err);
    })
    .finally(() => {
      autoSyncInFlight = null;
    });

  await autoSyncInFlight;
}

// ============================== READS ==============================

export const listCustomers = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { activeSheetGroupSlug } = await import("@/lib/sheets.server");
  const activeGroupId = await groupIdBySlug(activeSheetGroupSlug());

  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("id, slug, name, driver, sort_order, assignments:customer_sheet_assignments(sheet_group_id, driver)")
    .order("sort_order", { ascending: true });
  if (error) throw error;
  if (!activeGroupId) return data ?? [];

  // Show each customer's driver FOR THE ACTIVE SHEET (drivers are
  // per-sheet now; the global customers.driver column is a deprecated
  // fallback for any customer without an assignment yet).
  return (data ?? []).map((c: any) => {
    const active = (c.assignments ?? []).find((a: any) => a.sheet_group_id === activeGroupId);
    return { ...c, driver: active?.driver ?? c.driver };
  });
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
    await maybeAutoSync();

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, slug, name, driver")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) return null;

    // Scope the regulars to the sheet active for TOMORROW's delivery —
    // otherwise a customer would see products from BOTH sheets (with the
    // other sheet's row numbers) and order quantities could get written to
    // the wrong physical rows.
    const { activeSheetGroupSlug } = await import("@/lib/sheets.server");
    const activeGroupId = await groupIdBySlug(activeSheetGroupSlug());
    let cpQuery = supabaseAdmin
      .from("customer_products")
      .select("id, sheet_row, sort_order, product:products(id, name, category, image_url, ingredients)")
      .eq("customer_id", customer.id);
    if (activeGroupId) cpQuery = cpQuery.eq("sheet_group_id", activeGroupId);
    const { data: cps, error: cpErr } = await cpQuery.order("sort_order", { ascending: true });
    if (cpErr) throw cpErr;

    const historyCutoffDate = new Date();
    historyCutoffDate.setMonth(historyCutoffDate.getMonth() - 4);
    const historyCutoff = historyCutoffDate.toISOString();
    await supabaseAdmin.from("order_submissions").delete().lt("created_at", historyCutoff);

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

    // ── message is now included in history ──
    const { data: history } = await supabaseAdmin
      .from("order_submissions")
      .select(
        "id, for_date, total_items, created_at, order_type, message, items:order_submission_items(product_name, quantity)",
      )
      .eq("customer_id", customer.id)
      .gte("created_at", historyCutoff)
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
  sheetRow: z.number().int().min(0),
  productName: z.string().min(1),
  productId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(0),
});

const SubmitOrderInput = z.object({
  slug: z.string().min(1),
  forDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(SubmitItem),
  // Comments must always come through as a single line — strip any
  // newlines/tabs (e.g. from a paste) and collapse the resulting
  // whitespace so nothing can indent or wrap in the sheet/admin view.
  message: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim()),
});

export const submitOrder = createServerFn({ method: "POST" })
  .validator((d) => SubmitOrderInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      writeOrderQuantities,
      writeLateOrderQuantities,
      writeLateOrderQuantitiesToColumnC,
      insertCustomerProductRow,
      writeOrderComment,
    } = await import("@/lib/sheets.server");

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, name")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);
    const message = data.message.trim();
    const late = isLateOrder();

    let insertedAny = false;
    for (const item of positive) {
      if (item.sheetRow === 0) {
        const newRow = await insertCustomerProductRow({
          customerName: customer.name,
          productName: item.productName,
          quantity: late ? 0 : item.quantity,
        });
        item.sheetRow = newRow;
        insertedAny = true;
      }
    }

    if (late) {
      // K keeps the separate late-order tracking the LATE tab reads from;
      // C now also gets the same quantity (highlighted red) so the
      // kitchen's main total reflects it without checking a second tab.
      await writeLateOrderQuantities(
        positive.map((i) => ({ row: i.sheetRow, quantity: i.quantity })),
      );
      await writeLateOrderQuantitiesToColumnC(
        positive.map((i) => ({ row: i.sheetRow, quantity: i.quantity })),
      );
    } else {
      await writeOrderQuantities(
        positive.map((i) => ({ row: i.sheetRow, quantity: i.quantity })),
      );
    }

    if (message.length > 0) {
      await writeOrderComment(positive.map((i) => i.sheetRow), message);
    }

    // ── message now saved to Supabase ──
    // Tag the order with the sheet it came from (null until the
    // sheet-groups migration is applied — history stays untouched either way).
    const { activeSheetGroupSlug: activeSlug } = await import("@/lib/sheets.server");
    const activeGroupId = await groupIdBySlug(activeSlug());
    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        ...(activeGroupId ? { sheet_group_id: activeGroupId } : {}),
        // Always the server's own "tomorrow" (bakery-timezone), never the
        // client-supplied data.forDate. The client's own notion of
        // "tomorrow" can drift from this — its clock/timezone isn't
        // guaranteed to match the bakery's, and its UI-facing delivery
        // label logic skips Sunday (Sat -> shows "Monday") for display
        // purposes only. If the client's value were trusted here, an
        // order could get saved under a different date than the one
        // getCustomerPage looks it up with above, and the "you've already
        // ordered" screen would silently never show up. Keeping one
        // source of truth for this date on the server fixes that for
        // good, regardless of what the client sends.
        for_date: tomorrowISO(),
        total_items: totalItems,
        synced_to_sheet: true,
        order_type: late ? "late" : "new",
        message,
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

    const allRows = await readCustomerRows();
    const customerRowNumbers: number[] = [];
    for (let i = 1; i < allRows.length; i++) {
      if ((allRows[i]?.[0] ?? "").trim() === customer.name) {
        customerRowNumbers.push(i + 1);
      }
    }

    if (customerRowNumbers.length) {
      await writeOrderQuantities(customerRowNumbers.map((row) => ({ row, quantity: 0 })));
      await clearAddOnColumns(customerRowNumbers);
    }

    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);
    const message = data.message.trim();

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

    if (message.length > 0) {
      await writeOrderComment(positive.map((i) => i.sheetRow), message);
    }

    // ── message now saved to Supabase ──
    const { activeSheetGroupSlug: activeSlug } = await import("@/lib/sheets.server");
    const activeGroupId = await groupIdBySlug(activeSlug());
    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        ...(activeGroupId ? { sheet_group_id: activeGroupId } : {}),
        // Server-computed, not client-supplied — see submitOrder above.
        for_date: tomorrowISO(),
        total_items: totalItems,
        synced_to_sheet: true,
        order_type: "changed",
        message,
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

// ============================== ADD-ON ORDER ==============================

export const addOnToOrder = createServerFn({ method: "POST" })
  .validator((d) => SubmitOrderInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      addOnQuantityToRow,
      addLateOrderQuantityToRow,
      addLateQuantityToColumnC,
      insertCustomerProductRow,
      writeOrderComment,
    } = await import("@/lib/sheets.server");

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id, name")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    const positive = data.items.filter((i) => i.quantity > 0);
    const totalItems = positive.reduce((a, b) => a + b.quantity, 0);
    const message = data.message.trim();
    const late = isLateOrder();

    for (const item of positive) {
      if (item.sheetRow === 0) {
        const newRow = await insertCustomerProductRow({
          customerName: customer.name,
          productName: item.productName,
          quantity: 0,
        });
        item.sheetRow = newRow;
      }
      if (late) {
        // Same split as the new-order path: K keeps the running late
        // total for the LATE tab, C also gets it added (via the same
        // F..Z add-on-column mechanism as a normal add-on, so it doesn't
        // clobber any existing quantity), highlighted red.
        await addLateOrderQuantityToRow(item.sheetRow, item.quantity);
        await addLateQuantityToColumnC(item.sheetRow, item.quantity);
      } else {
        await addOnQuantityToRow(item.sheetRow, item.quantity);
      }
    }

    if (message.length > 0) {
      await writeOrderComment(positive.map((i) => i.sheetRow), message);
    }

    // ── message now saved to Supabase ──
    const { activeSheetGroupSlug: activeSlug } = await import("@/lib/sheets.server");
    const activeGroupId = await groupIdBySlug(activeSlug());
    const { data: submission, error: sErr } = await supabaseAdmin
      .from("order_submissions")
      .insert({
        customer_id: customer.id,
        ...(activeGroupId ? { sheet_group_id: activeGroupId } : {}),
        // Server-computed, not client-supplied — see submitOrder above.
        for_date: tomorrowISO(),
        total_items: totalItems,
        synced_to_sheet: true,
        order_type: late ? "late" : "added",
        message,
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

export const syncFromSheet = createServerFn({ method: "POST" })
  .validator((d) => {
    // The Apps Script trigger now sends { spreadsheetId } — the sheet that
    // was ACTUALLY edited. Older triggers sent 'null' (or nothing). Accept
    // all of it and let resolveSyncSheet decide.
    let parsed: unknown = d;
    if (typeof d === "string") {
      try { parsed = JSON.parse(d); } catch { parsed = null; }
    }
    return z
      .object({ spreadsheetId: z.string().min(1).optional() })
      .parse(parsed && typeof parsed === "object" ? parsed : {});
  })
  .handler(async ({ data }) => {
    const { resolveSyncSheet } = await import("@/lib/sheets.server");
    const { sheetId } = resolveSyncSheet(data.spreadsheetId);
    return runSheetSync(sheetId);
  });

/**
 * Manual "Re-sync" (admin dashboard): syncs BOTH spreadsheets. The button
 * isn't tied to an edit on a specific sheet, and each sync only touches its
 * own sheet's data, so the two can't clash.
 */
export const syncAllSheets = createServerFn({ method: "POST" }).handler(async () => {
  const { MON_WED_SHEET_ID, THU_SAT_SHEET_ID } = await import("@/lib/sheets.server");
  const monWed = await runSheetSync(MON_WED_SHEET_ID);
  const thuSat = await runSheetSync(THU_SAT_SHEET_ID);
  return { monWed, thuSat };
});

/**
 * The actual sync, shared by syncFromSheet (Apps Script trigger / explicit
 * sheet) and syncAllSheets (admin button).
 *
 * Reads `sheetId` (one of the two physical spreadsheets). driver +
 * sort_order are written to customer_sheet_assignments scoped to that
 * sheet's group, and customer_products rows are delete+reinserted scoped to
 * that group — so a sync from one sheet can never touch the other sheet's
 * data for shared customers.
 */
export async function runSheetSync(sheetId: string): Promise<{
  customers: number;
  products: number;
  mappings: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { readCustomerRows, readProductRows, sheetGroupSlugFor } = await import("@/lib/sheets.server");

  const groupSlug = sheetGroupSlugFor(sheetId) ?? "mon_tue_wed"; // only known IDs reach here
  const groupId = await groupIdBySlug(groupSlug); // null until the migration is applied

  const productRows = await readProductRows(sheetId);
  const customerRows = await readCustomerRows(sheetId);

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
    .select("id, name, slug");
  const existingByCName = new Map((existingCustomers ?? []).map((c) => [c.name, c]));
  const slugUsed = new Set<string>((existingCustomers ?? []).map((c) => c.slug));

  // Existing per-sheet assignments for THIS group (customer name → row id).
  let assignmentByCName = new Map<string, string>();
  if (groupId) {
    const { data: existingAssignments } = await supabaseAdmin
      .from("customer_sheet_assignments")
      .select("id, customer:customers(name)")
      .eq("sheet_group_id", groupId);
    for (const a of existingAssignments ?? []) {
      const n = (a as { customer?: { name?: string } }).customer?.name;
      if (n) assignmentByCName.set(n, (a as { id: string }).id);
    }
  }

  let customersTouched = 0;
  for (const [name, info] of seen) {
    let customerId: string;
    const ex = existingByCName.get(name);
    if (ex) {
      customerId = ex.id;
    } else {
      let s = slugify(name);
      const base = s;
      let i = 2;
      while (slugUsed.has(s)) s = `${base}-${i++}`;
      slugUsed.add(s);
      const { data: ins } = await supabaseAdmin
        .from("customers")
        .insert({ name, slug: s })
        .select("id, name, slug")
        .single();
      if (!ins) continue;
      existingByCName.set(name, ins);
      customerId = ins.id;
    }

    if (groupId) {
      // Per-sheet driver + sort_order, for THIS sheet's group only.
      // (The global customers.driver / customers.sort_order columns are
      // deprecated — no longer written — but left in place for now.)
      const assignId = assignmentByCName.get(name);
      if (assignId) {
        await supabaseAdmin
          .from("customer_sheet_assignments")
          .update({ driver: info.driver, sort_order: info.order })
          .eq("id", assignId);
      } else {
        const { error: aErr } = await supabaseAdmin
          .from("customer_sheet_assignments")
          .insert({
            customer_id: customerId,
            sheet_group_id: groupId,
            driver: info.driver,
            sort_order: info.order,
          });
        if (aErr) console.error("customer_sheet_assignments insert failed:", aErr.message);
      }
    } else {
      // Migration not applied yet — keep the old behavior (global columns)
      // so nothing regresses before the SQL is run.
      await supabaseAdmin
        .from("customers")
        .update({ driver: info.driver, sort_order: info.order })
        .eq("id", customerId);
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
    let del = supabaseAdmin
      .from("customer_products")
      .delete()
      .in("customer_id", customerIds);
    // Scope the wipe to THIS sheet's group, so the other sheet's row
    // mappings for shared customers stay intact.
    if (groupId) del = del.eq("sheet_group_id", groupId);
    await del;

    const rows = groupId
      ? cpPayload.map((x) => ({ ...x, sheet_group_id: groupId }))
      : cpPayload;
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const { error } = await supabaseAdmin
        .from("customer_products")
        .insert(rows.slice(i, i + batchSize));
      if (error) throw error;
    }
  }

  return {
    customers: customersTouched,
    products: productMap.size,
    mappings: cpPayload.length,
  };
}

export const ensureSeeded = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("customers")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) return { seeded: false };
  // Seed from BOTH spreadsheets — customers that only order on one side of
  // the week exist on only one of the sheets.
  const { MON_WED_SHEET_ID, THU_SAT_SHEET_ID } = await import("@/lib/sheets.server");
  await runSheetSync(MON_WED_SHEET_ID);
  await runSheetSync(THU_SAT_SHEET_ID);
  return { seeded: true };
});

export const autoSyncIfStale = createServerFn({ method: "GET" }).handler(async () => {
  await maybeAutoSync();
  return { ok: true };
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
      .select("id, for_date, total_items, created_at, order_type, message, customer:customers(id, name, slug)")
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
      .select("id, for_date, total_items, created_at, message, customer:customers(id, name, slug)")
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

// ============================== EXPORT ORDERS ==============================

const ExportOrdersInput = z.object({
  forDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type ExportOrderRow = {
  customer: string;
  product: string;
  quantity: number;
  driver: string;
  message: string;
};

const EXPORT_BAND_COLORS = ["FFFDF6E3", "FFEAF4FB", "FFFBEAF0", "FFEFF7EA"];

function buildFlatDetailSheet(workbook: import("exceljs").Workbook, rows: ExportOrderRow[]) {
  const sheet = workbook.addWorksheet("Customer Order Details", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Customers", key: "customer", width: 28 },
    { header: "Product", key: "product", width: 32 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Driver", key: "driver", width: 16 },
    // ── Comments column now populated from Supabase ──
    { header: "Comments", key: "comments", width: 40 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8362B" } };
  headerRow.alignment = { vertical: "middle" };

  let bandIndex = -1;
  let lastCustomer: string | null = null;

  for (const r of rows) {
    if (r.customer !== lastCustomer) {
      bandIndex = (bandIndex + 1) % EXPORT_BAND_COLORS.length;
      lastCustomer = r.customer;
    }
    const row = sheet.addRow({
      customer: r.customer,
      product: r.product,
      quantity: r.quantity,
      driver: r.driver,
      // Only write the message on the first product row per submission to
      // avoid repeating it on every single product line.
      comments: r.message,
    });
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXPORT_BAND_COLORS[bandIndex] } };
    row.eachCell((cell) => {
      cell.border = { bottom: { style: "thin", color: { argb: "FFE8DCC8" } } };
    });
  }

  sheet.getColumn(3).alignment = { horizontal: "center" };
}

function buildProductTotalsSheet(
  workbook: import("exceljs").Workbook,
  sheetName: string,
  productHeaderLabel: string,
  rows: ExportOrderRow[],
) {
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: productHeaderLabel, key: "product", width: 36 },
    { header: "Quantity", key: "quantity", width: 14 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8362B" } };
  headerRow.alignment = { vertical: "middle" };

  if (!rows.length) {
    const emptyRow = sheet.addRow({ product: "No orders in this category for this date", quantity: "" });
    emptyRow.font = { italic: true, color: { argb: "FF8B6F4E" } };
    return;
  }

  const totals = new Map<string, number>();
  for (const r of rows) {
    const qty = Number.isFinite(r.quantity) ? r.quantity : 0;
    totals.set(r.product, (totals.get(r.product) ?? 0) + qty);
  }

  const productNames = Array.from(totals.keys()).sort((a, b) => a.localeCompare(b));
  for (const pName of productNames) {
    sheet.addRow({ product: pName, quantity: totals.get(pName) });
  }

  sheet.getColumn(2).alignment = { horizontal: "center" };
}

async function buildProductCategoryMap(): Promise<Map<string, string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("products").select("name, category");
  if (error) throw error;

  const map = new Map<string, string>();
  for (const p of data ?? []) {
    const key = (p.name ?? "").trim().toLowerCase();
    if (!key) continue;
    const category = (p.category ?? "").trim().toUpperCase();
    if (!map.has(key) || (!map.get(key) && category)) {
      map.set(key, category);
    }
  }
  return map;
}

async function buildOrdersWorkbookBase64(rows: ExportOrderRow[]): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Portugal Bakery Admin";
  workbook.created = new Date();

  buildFlatDetailSheet(workbook, rows);

  const categoryMap = await buildProductCategoryMap();
  const freezerRows: ExportOrderRow[] = [];
  const productionRows: ExportOrderRow[] = [];
  const uncategorizedRows: ExportOrderRow[] = [];

  for (const r of rows) {
    const category = categoryMap.get(r.product.trim().toLowerCase());
    if (category === "FREEZER") freezerRows.push(r);
    else if (category === "PRODUCTION") productionRows.push(r);
    else uncategorizedRows.push(r);
  }

  buildProductTotalsSheet(workbook, "Freezer", "PRODUCT NAME FOR FREEZER", freezerRows);
  buildProductTotalsSheet(workbook, "Production", "PRODUCT NAME FOR PRODUCTION", productionRows);
  if (uncategorizedRows.length) {
    buildProductTotalsSheet(workbook, "Uncategorized", "PRODUCT NAME (UNCATEGORIZED)", uncategorizedRows);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
}

export const exportOrdersForDate = createServerFn({ method: "GET" })
  .validator((d) => ExportOrdersInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // ── message is now selected so it appears in the export ──
    const { data: subs, error } = await supabaseAdmin
      .from("order_submissions")
      .select(
        "id, created_at, message, customer:customers(name, driver), items:order_submission_items(product_name, quantity)",
      )
      .eq("for_date", data.forDate)
      .order("created_at", { ascending: true });
    if (error) throw error;

    // Which sheet does this DELIVERY day belong to? Same rule as
    // getActiveSheetId: delivery on Thu/Fri/Sat → Thu–Sat sheet.
    const dow = new Date(`${data.forDate}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    const groupSlug = dow === 4 || dow === 5 || dow === 6 ? "thu_fri_sat" : "mon_tue_wed";
    const groupId = await groupIdBySlug(groupSlug);

    // Driver for each customer ON THAT SHEET (drivers are per-sheet now;
    // falls back to the deprecated global customers.driver when there's no
    // per-sheet assignment for the customer).
    const driverByCustomer = new Map<string, string>();
    if (groupId) {
      const { data: assigns } = await supabaseAdmin
        .from("customer_sheet_assignments")
        .select("driver, customer:customers(id, name)")
        .eq("sheet_group_id", groupId);
      for (const a of assigns ?? []) {
        const n = (a as any).customer?.name;
        if (n) driverByCustomer.set(n, (a as any).driver ?? "");
      }
    }

    const rows: ExportOrderRow[] = [];
    for (const s of subs ?? []) {
      const customerName = s.customer?.name ?? "—";
      const driver = driverByCustomer.has(customerName)
        ? driverByCustomer.get(customerName)!
        : s.customer?.driver ?? "";
      const message = s.message ?? "";
      const itemList = s.items ?? [];

      // Write the message only on the first product row so it doesn't
      // repeat on every line — just like a "notes" field per order.
      itemList.forEach((it, idx) => {
        rows.push({
          customer: customerName,
          product: it.product_name,
          quantity: it.quantity,
          driver,
          message: idx === 0 ? message : "",
        });
      });
    }
    rows.sort((a, b) => a.customer.localeCompare(b.customer) || a.product.localeCompare(b.product));

    if (!rows.length) {
      return { forDate: data.forDate, rows, fileBase64: null };
    }

    const fileBase64 = await buildOrdersWorkbookBase64(rows);
    return { forDate: data.forDate, rows, fileBase64 };
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

    // The rows were appended to the ACTIVE sheet — tag the mapping with
    // that sheet's group and record the per-sheet driver assignment.
    const { activeSheetGroupSlug } = await import("@/lib/sheets.server");
    const activeGroupId = await groupIdBySlug(activeSheetGroupSlug());
    if (activeGroupId) {
      await supabaseAdmin
        .from("customer_sheet_assignments")
        .insert({
          customer_id: newCustomer.id,
          sheet_group_id: activeGroupId,
          driver: data.driver,
          sort_order: 9999,
        });
    }

    const cpRows = products.map((p, idx) => ({
      customer_id: newCustomer.id,
      product_id: p.id,
      sheet_row: startRow + idx,
      sort_order: idx + 1,
      ...(activeGroupId ? { sheet_group_id: activeGroupId } : {}),
    }));
    const { error: cpErr } = await supabaseAdmin.from("customer_products").insert(cpRows);
    if (cpErr) throw cpErr;

    return { ok: true, slug: newCustomer.slug, startRow, count: products.length };
  });

// ============================== DRIVERS ==============================

export const getDriverAssignments = createServerFn({ method: "GET" }).handler(async () => {
  const { readDriverAssignments, getActiveSheetLabel } = await import("@/lib/sheets.server");
  const { customers, driverOptions } = await readDriverAssignments();
  return {
    customers: customers.map((c) => ({ name: c.name, driver: c.driver })),
    driverOptions,
    sheetLabel: getActiveSheetLabel(),
  };
});

const SaveDriverInput = z.object({
  customerName: z.string().min(1),
  driver: z.string().min(1),
});

export const saveCustomerDriver = createServerFn({ method: "POST" })
  .validator((d) => SaveDriverInput.parse(d))
  .handler(async ({ data }) => {
    const { writeCustomerDriver, activeSheetGroupSlug } = await import("@/lib/sheets.server");
    const rowsUpdated = await writeCustomerDriver(data.customerName, data.driver);
    if (rowsUpdated === 0) {
      throw new Error(`No sheet rows found for customer "${data.customerName}"`);
    }

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("customers")
        .update({ driver: data.driver })
        .eq("name", data.customerName);

      // Also update the per-sheet assignment for the ACTIVE sheet (the
      // sheet writeCustomerDriver just wrote to).
      const groupId = await groupIdBySlug(activeSheetGroupSlug());
      if (groupId) {
        const { data: cRow } = await supabaseAdmin
          .from("customers")
          .select("id")
          .eq("name", data.customerName)
          .maybeSingle();
        if (cRow) {
          const { data: existing } = await supabaseAdmin
            .from("customer_sheet_assignments")
            .select("id")
            .eq("customer_id", cRow.id)
            .eq("sheet_group_id", groupId)
            .maybeSingle();
          if (existing) {
            await supabaseAdmin
              .from("customer_sheet_assignments")
              .update({ driver: data.driver })
              .eq("id", existing.id);
          } else {
            await supabaseAdmin
              .from("customer_sheet_assignments")
              .insert({ customer_id: cRow.id, sheet_group_id: groupId, driver: data.driver });
          }
        }
      }
    } catch {
      // non-fatal
    }

    return { ok: true, rowsUpdated };
  });

// ============================== ESTIMATES ==============================

const SECTION_SENTINEL_RE = /insert products above/i;
const StockSection = z.enum(["Production", "Freezer"]);

export const getEstimateProducts = createServerFn({ method: "GET" })
  .validator((d: { section: "Production" | "Freezer" }) =>
    z.object({ section: StockSection }).parse(d),
  )
  .handler(async ({ data }) => {
    const { readSectionRows } = await import("@/lib/sheets.server");
    const rows = await readSectionRows(data.section);
    return rows
      .filter((r) => !SECTION_SENTINEL_RE.test(r.name))
      .map((r) => ({
        id: r.row,
        name: r.name,
        quantity: r.estimate,
      }));
  });

const EstimateUpdate = z.object({ row: z.number().int().min(1), quantity: z.number().int().min(0) });
const SaveEstimatesInput = z.object({
  section: StockSection,
  updates: z.array(EstimateUpdate),
});

export const saveEstimates = createServerFn({ method: "POST" })
  .validator((d) => SaveEstimatesInput.parse(d))
  .handler(async ({ data }) => {
    if (!data.updates.length) return { ok: true, updated: 0 };
    const { writeSectionColumn } = await import("@/lib/sheets.server");
    await writeSectionColumn(
      data.section,
      "G",
      data.updates.map((u) => ({ row: u.row, quantity: u.quantity })),
    );
    return { ok: true, updated: data.updates.length };
  });

// ============================== PRODUCT STOCKS ==============================

export const getProductStocks = createServerFn({ method: "GET" })
  .validator((d: { section: "Production" | "Freezer" }) =>
    z.object({ section: StockSection }).parse(d),
  )
  .handler(async ({ data }) => {
    const { readSectionRows } = await import("@/lib/sheets.server");
    const rows = await readSectionRows(data.section);
    return rows
      .filter((r) => !SECTION_SENTINEL_RE.test(r.name))
      .map((r) => ({
        id: r.row,
        name: r.name,
        quantity: r.stock,
      }));
  });

const StockUpdate = z.object({ row: z.number().int().min(1), quantity: z.number().int().min(0) });
const SaveStocksInput = z.object({ section: StockSection, updates: z.array(StockUpdate) });

export const saveProductStocks = createServerFn({ method: "POST" })
  .validator((d) => SaveStocksInput.parse(d))
  .handler(async ({ data }) => {
    if (!data.updates.length) return { ok: true, updated: 0 };
    const { writeSectionColumn } = await import("@/lib/sheets.server");
    await writeSectionColumn(
      data.section,
      "F",
      data.updates.map((u) => ({ row: u.row, quantity: u.quantity })),
    );
    return { ok: true, updated: data.updates.length };
  });
