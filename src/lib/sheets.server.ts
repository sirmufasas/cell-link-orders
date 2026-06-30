// Server-only helpers for talking to Portugal Bakery Google Sheets
// directly via the Google Sheets API, using a service account.
//
// Two spreadsheets are used:
//   Mon–Wed sheet  → MON_WED_SHEET_ID
//   Thu–Sat sheet  → THU_SAT_SHEET_ID
//
// Each sheet has three delivery-day columns:
//   Mon–Wed: C = Monday (quantity), K = Tuesday, L = Wednesday
//   Thu–Sat: C = Thursday (quantity), K = Friday, L = Saturday
//
// Write logic (based on day order is placed):
//   Saturday  → Mon–Wed sheet, col C  (straight to Monday quantity)
//   Sunday    → Mon–Wed sheet, col C  (straight to Monday quantity)
//   Monday    → Mon–Wed sheet, col K  (Tuesday pre-order)
//   Tuesday   → Mon–Wed sheet, col L  (Wednesday pre-order)
//   Wednesday → Thu–Sat sheet, col C  (straight to Thursday quantity)
//   Thursday  → Thu–Sat sheet, col K  (Friday pre-order)
//   Friday    → Thu–Sat sheet, col L  (Saturday pre-order)
//
// At 11am each day a promote is run:
//   Tuesday  11am → copy K → C, clear K  (on Mon–Wed sheet)
//   Wednesday 11am → copy L → C, clear L  (on Mon–Wed sheet)
//   Friday   11am → copy K → C, clear K  (on Thu–Sat sheet)
//   Saturday 11am → copy L → C, clear L  (on Thu–Sat sheet)

import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ============================== SHEET IDS ==============================

export const MON_WED_SHEET_ID = "137ZxSSgodwcOOUpItZyZplMpwn3QXL8DvdneqQowJ98";
export const THU_SAT_SHEET_ID = "1PvpM6Be4xOCa_GqMYEg7-9M1BwcT1kfznwOxLRImEAw";

// ============================== DAY ROUTING ==============================

/**
 * Which sheet + which column to write to, based on the day the order is placed.
 *
 * getDay(): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
 */
export type WriteTarget = {
  sheetId: string;
  /** "C" = straight into the main Quantity column; "K" or "L" = pre-order day column */
  column: "C" | "K" | "L";
  /** Human-readable delivery day label */
  deliveryDay: string;
};

export function getWriteTarget(): WriteTarget {
  switch (new Date().getDay()) {
    case 6: // Saturday → Mon–Wed sheet, col C (Monday)
    case 0: // Sunday   → Mon–Wed sheet, col C (Monday)
      return { sheetId: MON_WED_SHEET_ID, column: "C", deliveryDay: "Monday" };
    case 1: // Monday   → Mon–Wed sheet, col K (Tuesday)
      return { sheetId: MON_WED_SHEET_ID, column: "K", deliveryDay: "Tuesday" };
    case 2: // Tuesday  → Mon–Wed sheet, col L (Wednesday)
      return { sheetId: MON_WED_SHEET_ID, column: "L", deliveryDay: "Wednesday" };
    case 3: // Wednesday → Thu–Sat sheet, col C (Thursday)
      return { sheetId: THU_SAT_SHEET_ID, column: "C", deliveryDay: "Thursday" };
    case 4: // Thursday → Thu–Sat sheet, col K (Friday)
      return { sheetId: THU_SAT_SHEET_ID, column: "K", deliveryDay: "Friday" };
    case 5: // Friday   → Thu–Sat sheet, col L (Saturday)
    default:
      return { sheetId: THU_SAT_SHEET_ID, column: "L", deliveryDay: "Saturday" };
  }
}

/** The active sheet ID for reads (syncing customers/products). Always the Mon–Wed sheet by default; callers can pass a specific sheetId. */
export function getActiveSheetId(): string {
  return getWriteTarget().sheetId;
}

export function getActiveSheetLabel(): string {
  return getWriteTarget().deliveryDay;
}

export function getActiveSheetUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${getActiveSheetId()}/edit`;
}

// ============================== TAB NAMES ==============================

const TAB_CUSTOMERS = "Customer Order Details";
const TAB_PRODUCTS = "Products List";
const TAB_FREEZER = "Freezer";
const TAB_PRODUCTION = "Production";

function sectionTabName(section: "Production" | "Freezer") {
  return section === "Freezer" ? TAB_FREEZER : TAB_PRODUCTION;
}

// ============================== AUTH ==============================

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

function loadServiceAccountKey(): ServiceAccountKey {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson) as ServiceAccountKey;
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_JSON is set but is not valid JSON.");
    }
  }

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    throw new Error(
      "Google Sheets is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH or GOOGLE_SERVICE_ACCOUNT_KEY_JSON in your environment.",
    );
  }

  try {
    const raw = readFileSync(resolve(keyPath), "utf-8");
    return JSON.parse(raw) as ServiceAccountKey;
  } catch (err) {
    throw new Error(
      `Failed to read Google service account key at "${keyPath}": ${(err as Error).message}`,
    );
  }
}

function getAuthClient() {
  const key = loadServiceAccountKey();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: key.private_key },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

async function getSheetsClient() {
  const authClient = await getAuthClient();
  return google.sheets({ version: "v4", auth: authClient as any });
}

// ============================== READS ==============================

export async function readCustomerRows(sheetId?: string): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId ?? getActiveSheetId(),
    range: `${TAB_CUSTOMERS}!A1:L2000`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function readProductRows(sheetId?: string): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId ?? getActiveSheetId(),
    range: `${TAB_PRODUCTS}!A1:B2000`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function readRowFull(row: number, sheetId?: string): Promise<string[]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId ?? getActiveSheetId(),
    range: `${TAB_CUSTOMERS}!A${row}:Z${row}`,
  });
  const vals = (res.data.values as string[][]) ?? [];
  return vals[0] ?? [];
}

export async function readSectionRows(
  section: "Production" | "Freezer",
): Promise<Array<{ row: number; name: string; stock: number; estimate: number }>> {
  const sheets = await getSheetsClient();
  const tab = sectionTabName(section);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getActiveSheetId(),
    range: `${tab}!A1:G2000`,
  });
  const rows = (res.data.values as string[][]) ?? [];

  const out: Array<{ row: number; name: string; stock: number; estimate: number }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const name = (r[0] ?? "").trim();
    if (!name) continue;
    const stockRaw = (r[5] ?? "").toString().trim();
    const estimateRaw = (r[6] ?? "").toString().trim();
    const stock = stockRaw === "" ? 0 : parseInt(stockRaw, 10);
    const estimate = estimateRaw === "" ? 0 : parseInt(estimateRaw, 10);
    out.push({
      row: i + 1,
      name,
      stock: Number.isFinite(stock) ? stock : 0,
      estimate: Number.isFinite(estimate) ? estimate : 0,
    });
  }
  return out;
}

// ============================== WRITES ==============================

/**
 * Write order quantities into the correct day column (C, K, or L) based on
 * today's write target. This replaces the old writeOrderQuantities which
 * always wrote to column C.
 */
export async function writeOrderQuantities(
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  const { sheetId, column } = getWriteTarget();
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({
        range: `${TAB_CUSTOMERS}!${column}${e.row}`,
        values: [[e.quantity > 0 ? String(e.quantity) : ""]],
      })),
    },
  });
}

/**
 * Clear the active day column for given rows.
 */
export async function clearOrderQuantities(rows: number[]) {
  if (!rows.length) return;
  await writeOrderQuantities(rows.map((r) => ({ row: r, quantity: 0 })));
}

/**
 * Write arbitrary single-cell values to a specific sheet.
 * sheetId defaults to the active write-target sheet.
 */
export async function writeCells(
  entries: Array<{ range: string; value: string }>,
  sheetId?: string,
) {
  if (!entries.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId ?? getWriteTarget().sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({ range: e.range, values: [[e.value]] })),
    },
  });
}

/**
 * Write the customer's message into column J for every row touched.
 */
export async function writeOrderComment(rows: number[], message: string) {
  const trimmed = message.trim();
  if (!rows.length || !trimmed) return;
  const uniqueRows = Array.from(new Set(rows));
  const { sheetId } = getWriteTarget();
  await writeCells(
    uniqueRows.map((row) => ({ range: `${TAB_CUSTOMERS}!J${row}`, value: trimmed })),
    sheetId,
  );
}

export async function writeSectionColumn(
  section: "Production" | "Freezer",
  column: "F" | "G",
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  const tab = sectionTabName(section);
  await writeCells(
    entries.map((e) => ({
      range: `${tab}!${column}${e.row}`,
      value: e.quantity > 0 ? String(e.quantity) : "",
    })),
  );
}

/** Append new customer rows. Returns the starting row number of the appended block. */
export async function appendCustomerRows(
  rows: Array<{ customer: string; product: string; driver: string }>,
): Promise<number> {
  if (!rows.length) return 0;
  const { sheetId } = getWriteTarget();
  const sheets = await getSheetsClient();
  const values = rows.map((r) => [r.customer, r.product, "", r.driver, "No"]);

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${TAB_CUSTOMERS}!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  const updatedRange: string = res.data.updates?.updatedRange ?? "";
  const m = updatedRange.match(/!\w+(\d+):/);
  return m ? parseInt(m[1], 10) : 0;
}

// Cache is keyed by sheet ID so switching sheets gets a fresh lookup.
const _customerSheetIdCache = new Map<string, number>();

export async function getCustomerSheetId(sheetId?: string): Promise<number> {
  const sid = sheetId ?? getWriteTarget().sheetId;
  if (_customerSheetIdCache.has(sid)) return _customerSheetIdCache.get(sid)!;

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: "sheets.properties" });
  const sheetList = res.data.sheets ?? [];
  const s = sheetList.find((x) => x.properties?.title === TAB_CUSTOMERS);
  if (!s || s.properties?.sheetId == null) {
    throw new Error(`Tab "${TAB_CUSTOMERS}" not found in sheet ${sid}`);
  }

  _customerSheetIdCache.set(sid, s.properties.sheetId);
  return s.properties.sheetId;
}

/**
 * Insert a new row for a customer immediately below their last existing row.
 * Returns the inserted row number (1-based).
 */
export async function insertCustomerProductRow(opts: {
  customerName: string;
  productName: string;
  quantity: number;
}): Promise<number> {
  const { sheetId, column } = getWriteTarget();
  const all = await readCustomerRows(sheetId);
  let lastRow1 = -1;
  for (let i = 1; i < all.length; i++) {
    if ((all[i]?.[0] ?? "").trim() === opts.customerName) lastRow1 = i + 1;
  }
  if (lastRow1 < 0) {
    const r = await appendCustomerRows([
      { customer: opts.customerName, product: opts.productName, driver: "Collection" },
    ]);
    if (opts.quantity > 0)
      await writeCells(
        [{ range: `${TAB_CUSTOMERS}!${column}${r}`, value: String(opts.quantity) }],
        sheetId,
      );
    return r;
  }

  const tabSheetId = await getCustomerSheetId(sheetId);
  const above = all[lastRow1 - 1] ?? [];
  const driver = (above[3] ?? "Collection").trim() || "Collection";
  const colE = (above[4] ?? "No").trim() || "No";

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: { sheetId: tabSheetId, dimension: "ROWS", startIndex: lastRow1, endIndex: lastRow1 + 1 },
            inheritFromBefore: true,
          },
        },
      ],
    },
  });

  const newRow = lastRow1 + 1;
  await writeCells(
    [
      { range: `${TAB_CUSTOMERS}!A${newRow}`, value: opts.customerName },
      { range: `${TAB_CUSTOMERS}!B${newRow}`, value: opts.productName },
      { range: `${TAB_CUSTOMERS}!${column}${newRow}`, value: opts.quantity > 0 ? String(opts.quantity) : "" },
      { range: `${TAB_CUSTOMERS}!D${newRow}`, value: driver },
      { range: `${TAB_CUSTOMERS}!E${newRow}`, value: colE },
    ],
    sheetId,
  );
  return newRow;
}

/**
 * Add-on write: finds the next empty add-on column (F..J range, skipping J which is Comments)
 * and updates column C to sum all add-on columns.
 *
 * Note: add-ons always go to the "added" columns (F,G,H,I) — never K or L —
 * because those are the day-specific pre-order columns.
 */
export async function addOnQuantityToRow(
  row: number,
  quantity: number,
): Promise<string> {
  if (quantity <= 0) return "";
  const { sheetId, column } = getWriteTarget();
  const sheets = await getSheetsClient();

  // For add-ons, we always read/write from the day column (C, K, or L) as base,
  // and put the add-on into F, G, H, or I (the "added" columns).
  const [cValueRes, fzValuesRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${TAB_CUSTOMERS}!${column}${row}`,
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      // F, G, H, I are the "added" columns (J is Comments, skip it)
      range: `${TAB_CUSTOMERS}!F${row}:I${row}`,
    }),
  ]);

  const cRaw = (cValueRes.data.values?.[0]?.[0] ?? "").toString();
  const fz = (fzValuesRes.data.values?.[0] ?? []) as string[];

  // Find next empty add-on slot in F..I
  let idx = 0;
  while (idx < fz.length && (fz[idx] ?? "").toString().trim() !== "") idx++;
  if (idx > 3) throw new Error("No empty add-on column available (F..I full)");
  const colLetter = String.fromCharCode("F".charCodeAt(0) + idx);

  const filledLetters: string[] = [];
  for (let i = 0; i < idx; i++)
    filledLetters.push(String.fromCharCode("F".charCodeAt(0) + i));
  filledLetters.push(colLetter);

  let baseExpr: string;
  if (cRaw.startsWith("=")) {
    baseExpr = cRaw.slice(1);
    const tokenRe = new RegExp(`\\+\\s*[F-I]${row}\\b`, "g");
    baseExpr = baseExpr.replace(tokenRe, "").trim();
  } else {
    const numeric = cRaw.trim();
    baseExpr = numeric === "" ? "0" : numeric;
  }
  const newFormula = `=${baseExpr}+` + filledLetters.map((L) => `${L}${row}`).join("+");

  await writeCells(
    [
      { range: `${TAB_CUSTOMERS}!${colLetter}${row}`, value: String(quantity) },
      { range: `${TAB_CUSTOMERS}!${column}${row}`, value: newFormula },
    ],
    sheetId,
  );
  return colLetter;
}

/**
 * Clear add-on columns F..I for the given rows.
 */
export async function clearAddOnColumns(rows: number[]) {
  if (!rows.length) return;
  const { sheetId } = getWriteTarget();
  const entries: Array<{ range: string; value: string }> = [];
  for (const row of rows) {
    for (const col of ["F", "G", "H", "I"]) {
      entries.push({ range: `${TAB_CUSTOMERS}!${col}${row}`, value: "" });
    }
  }
  await writeCells(entries, sheetId);
}

// ============================== DAY COLUMN PROMOTION ==============================

/**
 * Called at 11am each day. Copies the named day column (K or L) into column C,
 * then clears the named day column.
 *
 * Schedule:
 *   Tuesday  11am → promote K on Mon–Wed sheet  (Tuesday orders → Monday quantity col)
 *   Wednesday 11am → promote L on Mon–Wed sheet
 *   Friday   11am → promote K on Thu–Sat sheet
 *   Saturday 11am → promote L on Thu–Sat sheet
 *
 * On days that don't need a promotion (Mon, Wed, Thu, Sun) this is a no-op.
 */
export async function promotePreOrderColumn(): Promise<{ promoted: boolean; day: string; column: string | null }> {
  const today = new Date().getDay();
  // getDay(): 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat

  let sheetId: string;
  let sourceColumn: "K" | "L";
  let dayName: string;

  if (today === 2) {
    // Tuesday: promote K (tuesday orders) → C on Mon–Wed sheet
    sheetId = MON_WED_SHEET_ID;
    sourceColumn = "K";
    dayName = "Tuesday";
  } else if (today === 3) {
    // Wednesday: promote L (wednesday orders) → C on Mon–Wed sheet
    sheetId = MON_WED_SHEET_ID;
    sourceColumn = "L";
    dayName = "Wednesday";
  } else if (today === 5) {
    // Friday: promote K (friday orders) → C on Thu–Sat sheet
    sheetId = THU_SAT_SHEET_ID;
    sourceColumn = "K";
    dayName = "Friday";
  } else if (today === 6) {
    // Saturday: promote L (saturday orders) → C on Thu–Sat sheet
    sheetId = THU_SAT_SHEET_ID;
    sourceColumn = "L";
    dayName = "Saturday";
  } else {
    return { promoted: false, day: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][today], column: null };
  }

  const sheets = await getSheetsClient();

  // Read the full source column (K or L), rows 2 onwards
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${TAB_CUSTOMERS}!${sourceColumn}2:${sourceColumn}2000`,
  });
  const sourceValues = (readRes.data.values as string[][]) ?? [];

  if (!sourceValues.length) {
    return { promoted: true, day: dayName, column: sourceColumn };
  }

  // Build batch writes: copy source → C, blank out source
  const copyData = sourceValues.map((row, i) => ({
    range: `${TAB_CUSTOMERS}!C${i + 2}`,
    values: [[row[0] ?? ""]],
  }));
  const clearData = sourceValues.map((_, i) => ({
    range: `${TAB_CUSTOMERS}!${sourceColumn}${i + 2}`,
    values: [[""]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [...copyData, ...clearData],
    },
  });

  return { promoted: true, day: dayName, column: sourceColumn };
}