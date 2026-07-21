// Server-only helpers for talking to Portugal Bakery Google Sheets
// directly via the Google Sheets API, using a service account.
//
// Two spreadsheets are used, selected based on TOMORROW's delivery day:
//   Mon / Tue / Wed  → MON_WED_SHEET_ID
//   Thu / Fri / Sat  → THU_SAT_SHEET_ID
//   Sunday           → MON_WED_SHEET_ID  (prepares for Monday)
//
// Both spreadsheets share the same tab names, so all read/write helpers
// work against whichever sheet getActiveSheetId() resolves to.

import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ============================== SHEET IDS ==============================

/** Mon–Wed delivery sheet */
export const MON_WED_SHEET_ID = "137ZxSSgodwcOOUpItZyZplMpwn3QXL8DvdneqQowJ98";

/** Thu–Sat delivery sheet */
export const THU_SAT_SHEET_ID = "1PvpM6Be4xOCa_GqMYEg7-9M1BwcT1kfznwOxLRImEAw";

/**
 * Returns the spreadsheet ID to use for today's orders.
 * Orders entered today are always for TOMORROW's delivery run.
 *
 * Tomorrow's day → sheet:
 *   Monday    (1) → Mon-Wed
 *   Tuesday   (2) → Mon-Wed
 *   Wednesday (3) → Mon-Wed
 *   Thursday  (4) → Thu-Sat
 *   Friday    (5) → Thu-Sat
 *   Saturday  (6) → Thu-Sat
 *   Sunday    (0) → Mon-Wed  (Sunday orders deliver on Monday)
 */
export function getActiveSheetId(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // getDay(): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const tomorrowDay = tomorrow.getDay();

  if (tomorrowDay === 4 || tomorrowDay === 5 || tomorrowDay === 6) {
    return THU_SAT_SHEET_ID;
  }
  // Mon(1), Tue(2), Wed(3), Sun(0) → Mon-Wed sheet
  return MON_WED_SHEET_ID;
}

/** Human-readable label for the active sheet, useful for UI / logging. */
export function getActiveSheetLabel(): string {
  const id = getActiveSheetId();
  return id === MON_WED_SHEET_ID ? "Mon–Wed" : "Thu–Sat";
}

/** The Google Sheets URL for the currently active sheet. */
export function getActiveSheetUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${getActiveSheetId()}/edit`;
}

// ============================== TAB NAMES ==============================

const TAB_CUSTOMERS = "Customer Order Details";
const TAB_PRODUCTS = "Products List";

// Estimates (column G) and stock (column F) both live on these two tabs.
// Freezer and Production have different product lists, so the section
// picked determines both which tab is read and which products show up.
// NOTE: adjust these two strings if your actual tab names differ.
const TAB_FREEZER = "Freezer";
const TAB_PRODUCTION = "Production";

function sectionTabName(section: "Production" | "Freezer") {
  return section === "Freezer" ? TAB_FREEZER : TAB_PRODUCTION;
}

// Column E ("Customer Order Details") holds a Yes/No formula that derives
// its value from other cells in the same row (e.g. whether column C has a
// quantity in it). 0-based column index, used by copyPaste requests below.
const COL_E_INDEX = 4; // A=0, B=1, C=2, D=3, E=4

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
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_KEY_JSON is set but is not valid JSON.",
      );
    }
  }

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    throw new Error(
      "Google Sheets is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH (path to the service account JSON file) or GOOGLE_SERVICE_ACCOUNT_KEY_JSON (the JSON itself) in your environment.",
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
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return auth.getClient();
}

async function getSheetsClient() {
  const authClient = await getAuthClient();
  return google.sheets({ version: "v4", auth: authClient as any });
}

// ============================== READS ==============================

export async function readCustomerRows(): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getActiveSheetId(),
    range: `${TAB_CUSTOMERS}!A1:E2000`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function readProductRows(): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getActiveSheetId(),
    range: `${TAB_PRODUCTS}!A1:B2000`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function readRowFull(row: number): Promise<string[]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getActiveSheetId(),
    range: `${TAB_CUSTOMERS}!A${row}:Z${row}`,
  });
  const vals = (res.data.values as string[][]) ?? [];
  return vals[0] ?? [];
}

/**
 * Reads the Freezer or Production tab on the currently-active (day-based)
 * spreadsheet. Column A = product name, column F = stock quantity,
 * column G = estimate quantity. Row 1 is treated as a header row.
 */
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
    const stockRaw = (r[5] ?? "").toString().trim(); // column F
    const estimateRaw = (r[6] ?? "").toString().trim(); // column G
    const stock = stockRaw === "" ? 0 : parseInt(stockRaw, 10);
    const estimate = estimateRaw === "" ? 0 : parseInt(estimateRaw, 10);
    out.push({
      row: i + 1, // 1-based sheet row
      name,
      stock: Number.isFinite(stock) ? stock : 0,
      estimate: Number.isFinite(estimate) ? estimate : 0,
    });
  }
  return out;
}

/**
 * Reads column A (customer) and column D (driver) of "Customer Order
 * Details" on the ACTIVE (day-based) spreadsheet, grouped by customer.
 * A customer typically has many rows (one per product); this collapses
 * them down to one entry per customer plus the full list of sheet rows
 * that belong to them, so a driver change can be written to every row.
 *
 * driverOptions is the distinct, sorted list of non-empty driver values
 * currently in use on this sheet — handy for a dropdown of existing
 * drivers, while still allowing a free-text new driver name.
 */
export async function readDriverAssignments(): Promise<{
  customers: Array<{ name: string; driver: string; rows: number[] }>;
  driverOptions: string[];
}> {
  const all = await readCustomerRows();
  const byName = new Map<string, { driver: string; rows: number[] }>();
  const driverSet = new Set<string>();

  for (let i = 1; i < all.length; i++) {
    const r = all[i] ?? [];
    const name = (r[0] ?? "").trim();
    if (!name) continue;
    const driver = (r[3] ?? "").toString().trim(); // column D
    if (driver) driverSet.add(driver);

    const entry = byName.get(name);
    if (entry) {
      entry.rows.push(i + 1); // 1-based sheet row
    } else {
      byName.set(name, { driver, rows: [i + 1] });
    }
  }

  const customers = Array.from(byName.entries())
    .map(([name, v]) => ({ name, driver: v.driver, rows: v.rows }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const driverOptions = Array.from(driverSet).sort((a, b) => a.localeCompare(b));

  return { customers, driverOptions };
}

// ============================== WRITES ==============================

/** Write quantity values into column C of "Customer Order Details" for the given sheet rows. */
export async function writeOrderQuantities(
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getActiveSheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({
        range: `${TAB_CUSTOMERS}!C${e.row}`,
        values: [[e.quantity > 0 ? String(e.quantity) : ""]],
      })),
    },
  });
}

/** Clear column C for given rows (used when starting a new daily order). */
export async function clearOrderQuantities(rows: number[]) {
  if (!rows.length) return;
  await writeOrderQuantities(rows.map((r) => ({ row: r, quantity: 0 })));
}

/** Write arbitrary single-cell values. */
export async function writeCells(
  entries: Array<{ range: string; value: string }>,
) {
  if (!entries.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getActiveSheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({ range: e.range, values: [[e.value]] })),
    },
  });
}

/**
 * Write the customer's order-message into column J ("Comments") for every
 * row touched by a submission. Called right after the quantity writes in
 * submitOrder / changeOrder / addOnToOrder.
 */
export async function writeOrderComment(rows: number[], message: string) {
  const trimmed = message.trim();
  if (!rows.length || !trimmed) return;
  const uniqueRows = Array.from(new Set(rows));
  await writeCells(
    uniqueRows.map((row) => ({ range: `${TAB_CUSTOMERS}!J${row}`, value: trimmed })),
  );
}

/**
 * Write quantities into column F (stock) or G (estimate) of the Freezer /
 * Production tab on the active spreadsheet.
 */
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

/**
 * Write a new driver name into column D of "Customer Order Details" for
 * EVERY row belonging to this customer on the active (day-based) sheet.
 * Returns the number of rows updated (0 if the customer wasn't found).
 */
export async function writeCustomerDriver(
  customerName: string,
  driver: string,
): Promise<number> {
  const all = await readCustomerRows();
  const rows: number[] = [];
  for (let i = 1; i < all.length; i++) {
    if ((all[i]?.[0] ?? "").trim() === customerName) rows.push(i + 1);
  }
  if (!rows.length) return 0;

  await writeCells(
    rows.map((row) => ({ range: `${TAB_CUSTOMERS}!D${row}`, value: driver })),
  );
  return rows.length;
}

/** Append new customer rows. Returns the starting row number of the appended block. */
export async function appendCustomerRows(
  rows: Array<{ customer: string; product: string; driver: string }>,
): Promise<number> {
  if (!rows.length) return 0;
  const sheets = await getSheetsClient();
  const values = rows.map((r) => [r.customer, r.product, "", r.driver, "No"]);

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: getActiveSheetId(),
    range: `${TAB_CUSTOMERS}!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  // updatedRange looks like "'Customer Order Details'!A742:E750"
  const updatedRange: string = res.data.updates?.updatedRange ?? "";
  const m = updatedRange.match(/!\w+(\d+):/);
  return m ? parseInt(m[1], 10) : 0;
}

// Cache is keyed by sheet ID so switching sheets gets a fresh lookup.
const _customerSheetIdCache = new Map<string, number>();

export async function getCustomerSheetId(): Promise<number> {
  const sheetId = getActiveSheetId();
  if (_customerSheetIdCache.has(sheetId)) {
    return _customerSheetIdCache.get(sheetId)!;
  }

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets.properties",
  });
  const sheetList = res.data.sheets ?? [];
  const s = sheetList.find((x) => x.properties?.title === TAB_CUSTOMERS);
  if (!s || s.properties?.sheetId == null) {
    throw new Error(`Tab "${TAB_CUSTOMERS}" not found in sheet ${sheetId}`);
  }

  _customerSheetIdCache.set(sheetId, s.properties.sheetId);
  return s.properties.sheetId;
}

/**
 * Insert a new row for a customer immediately below their last existing row.
 * Copies col A (customer), D (driver) from the row above; sets B (product),
 * C (quantity). Column E (the Yes/No indicator) is copied as a FORMULA —
 * not a static value — from the row above via a Sheets copyPaste request,
 * so the Sheets API shifts its relative references (e.g. C245 → C246) the
 * same way dragging the formula down in the UI would. This keeps the new
 * row's Yes/No live and reactive instead of frozen at whatever the row
 * above happened to show at insert time.
 *
 * Returns the inserted row number (1-based).
 */
export async function insertCustomerProductRow(opts: {
  customerName: string;
  productName: string;
  quantity: number;
}): Promise<number> {
  const all = await readCustomerRows();
  let lastRow1 = -1; // 1-based
  for (let i = 1; i < all.length; i++) {
    if ((all[i]?.[0] ?? "").trim() === opts.customerName) lastRow1 = i + 1;
  }
  if (lastRow1 < 0) {
    // Customer doesn't exist yet — append at bottom
    const r = await appendCustomerRows([
      {
        customer: opts.customerName,
        product: opts.productName,
        driver: "Collection",
      },
    ]);
    if (opts.quantity > 0)
      await writeOrderQuantities([{ row: r, quantity: opts.quantity }]);
    return r;
  }

  const sheetId = await getCustomerSheetId();
  const above = all[lastRow1 - 1] ?? [];
  const driver = (above[3] ?? "Collection").trim() || "Collection";

  const sheets = await getSheetsClient();
  const newRow = lastRow1 + 1;

  // Insert the blank row, then copy column E's FORMULA (not its computed
  // value) from the row above down into the new row, in the same
  // batchUpdate call. inheritFromBefore only copies cell formatting — it
  // does not copy formulas — so the copyPaste request is what actually
  // makes the Yes/No cell live again on the new row.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getActiveSheetId(),
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: lastRow1,
              endIndex: lastRow1 + 1,
            },
            inheritFromBefore: true,
          },
        },
        {
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: lastRow1 - 1, // 0-based row above (unaffected by the insert)
              endRowIndex: lastRow1,
              startColumnIndex: COL_E_INDEX,
              endColumnIndex: COL_E_INDEX + 1,
            },
            destination: {
              sheetId,
              startRowIndex: newRow - 1, // 0-based new row
              endRowIndex: newRow,
              startColumnIndex: COL_E_INDEX,
              endColumnIndex: COL_E_INDEX + 1,
            },
            pasteType: "PASTE_FORMULA",
          },
        },
      ],
    },
  });

  await writeCells([
    { range: `${TAB_CUSTOMERS}!A${newRow}`, value: opts.customerName },
    { range: `${TAB_CUSTOMERS}!B${newRow}`, value: opts.productName },
    {
      range: `${TAB_CUSTOMERS}!C${newRow}`,
      value: opts.quantity > 0 ? String(opts.quantity) : "",
    },
    { range: `${TAB_CUSTOMERS}!D${newRow}`, value: driver },
    // Column E intentionally NOT written here — its formula was just
    // copied down above and will recalculate from this row's own C value.
  ]);
  return newRow;
}

/**
 * Add-on write: for a given product row, find the next empty column starting
 * at F, write the add-on quantity there, and update column C so it sums the
 * original value plus all filled add-on columns.
 */
export async function addOnQuantityToRow(
  row: number,
  quantity: number,
): Promise<string> {
  if (quantity <= 0) return "";
  const sheets = await getSheetsClient();

  // Read current C (as formula) and F..Z values
  const [cValueRes, fzValuesRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: getActiveSheetId(),
      range: `${TAB_CUSTOMERS}!C${row}`,
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: getActiveSheetId(),
      range: `${TAB_CUSTOMERS}!F${row}:Z${row}`,
    }),
  ]);

  const cRaw = (cValueRes.data.values?.[0]?.[0] ?? "").toString();
  const fz = (fzValuesRes.data.values?.[0] ?? []) as string[];

  // Find next empty column index (0 = F, 1 = G, ...)
  let idx = 0;
  while (idx < fz.length && (fz[idx] ?? "").toString().trim() !== "") idx++;
  if (idx > 19) throw new Error("No empty add-on column available (F..Z full)");
  const colLetter = String.fromCharCode("F".charCodeAt(0) + idx);

  // Build new C formula: original + every filled add-on column (F..colLetter)
  const filledLetters: string[] = [];
  for (let i = 0; i < idx; i++)
    filledLetters.push(String.fromCharCode("F".charCodeAt(0) + i));
  filledLetters.push(colLetter);

  let baseExpr: string;
  if (cRaw.startsWith("=")) {
    baseExpr = cRaw.slice(1);
    // Detect existing add-on tokens "+F<row>"..."+Z<row>" and drop them, then re-add fresh.
    const tokenRe = new RegExp(`\\+\\s*[F-Z]${row}\\b`, "g");
    baseExpr = baseExpr.replace(tokenRe, "").trim();
  } else {
    const numeric = cRaw.trim();
    baseExpr = numeric === "" ? "0" : numeric;
  }
  const newFormula =
    `=${baseExpr}+` + filledLetters.map((L) => `${L}${row}`).join("+");

  await writeCells([
    { range: `${TAB_CUSTOMERS}!${colLetter}${row}`, value: String(quantity) },
    { range: `${TAB_CUSTOMERS}!C${row}`, value: newFormula },
  ]);
  return colLetter;
}

/**
 * Blank out every add-on column (F..Z) for the given rows. Used by
 * changeOrder to fully reset a customer's prior order — including any
 * add-on quantities written via addOnQuantityToRow — before writing the
 * new quantities in.
 */
export async function clearAddOnColumns(rows: number[]) {
  if (!rows.length) return;
  const entries: Array<{ range: string; value: string }> = [];
  for (const row of rows) {
    for (let i = 0; i < 21; i++) {
      // F..Z inclusive
      const col = String.fromCharCode("F".charCodeAt(0) + i);
      entries.push({ range: `${TAB_CUSTOMERS}!${col}${row}`, value: "" });
    }
  }
  await writeCells(entries);
}
