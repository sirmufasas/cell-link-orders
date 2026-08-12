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

// ============================== TIMEZONE ==============================
// The bakery operates in Africa/Johannesburg (SAST, UTC+2), but this code
// runs as Netlify serverless functions, which default to UTC and have no
// TZ env var set. Using `new Date().getDay()` / `getHours()` directly (as
// this file used to) reads the SERVER's clock, not the bakery's — a ~2hr
// gap that caused two bugs:
//   1. The late-order cutoff effectively fired 2 hours later than
//      intended in real local time.
//   2. Right after local midnight (00:00–01:59 SAST, which is still
//      22:00–23:59 the PREVIOUS day in UTC), "tomorrow" was computed a
//      full day behind reality. At the Wed/Thu and Sat/Sun sheet-group
//      boundaries this routed orders to the WRONG spreadsheet entirely
//      (e.g. very-late-Friday-night orders meant for the Mon–Wed sheet
//      silently landing in the Thu–Sat sheet instead), which is why late
//      orders sometimes never showed up under Mon–Wed.
//
// Fix: derive "now" from the Africa/Johannesburg wall-clock explicitly,
// regardless of what timezone the server process itself is running in.
const BAKERY_TIMEZONE = "Africa/Johannesburg";

/** Returns {year, month, day, hour, minute, weekday} for "now" in the bakery's timezone. */
function nowInBakeryTimezone(): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BAKERY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour") === "24" ? "0" : get("hour"), 10),
    minute: parseInt(get("minute"), 10),
  };
}

/**
 * Day of week (0=Sun..6=Sat) for a given Y/M/D, computed via UTC-anchored
 * Date math so it isn't re-interpreted through the server's own timezone.
 */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Minutes since local midnight, right now, in the bakery's timezone. */
export function bakeryMinutesNow(): number {
  const { hour, minute } = nowInBakeryTimezone();
  return hour * 60 + minute;
}

/** Tomorrow's weekday (0=Sun..6=Sat), computed from the bakery's local "today". */
function tomorrowWeekdayInBakeryTimezone(): number {
  const { year, month, day } = nowInBakeryTimezone();
  // Add one calendar day via UTC-anchored math, then re-derive the weekday —
  // this avoids DST/rollover edge cases from hand-rolling day-of-month math.
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return weekdayOf(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate());
}

/** Tomorrow's date (bakery-local) as YYYY-MM-DD. */
export function tomorrowISOInBakeryTimezone(): string {
  const { year, month, day } = nowInBakeryTimezone();
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return tomorrow.toISOString().slice(0, 10);
}

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
  // getDay()-style: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const tomorrowDay = tomorrowWeekdayInBakeryTimezone();

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
 * Reads the Data Validation rule attached to column D ("Driver") of
 * "Customer Order Details" on the currently-active spreadsheet, and
 * returns its dropdown list of allowed values (if the column uses a
 * "list of items" validation rule, which is how the sheet's driver
 * dropdown is normally configured).
 *
 * This exists so a driver added to the sheet's dropdown shows up in the
 * app immediately — even before any customer has actually been assigned
 * to that driver yet. Scanning column D's *values* (see below) can only
 * ever surface drivers that are already in use somewhere, which silently
 * hides brand-new options until the chicken-and-egg problem is solved by
 * hand. Different rows can technically carry different validation rules
 * (e.g. if the dropdown was extended partway down the sheet), so this
 * checks every row's rule and unions all the values found, rather than
 * assuming row 2's rule speaks for the whole column.
 *
 * Returns an empty array (never throws) if there's no validation rule to
 * read, or if the API call fails for any reason — callers should treat
 * this as a best-effort enhancement on top of the values actually in use.
 */
async function readDriverDropdownOptions(): Promise<string[]> {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.get({
      spreadsheetId: getActiveSheetId(),
      ranges: [`${TAB_CUSTOMERS}!D2:D2000`],
      fields: "sheets.data.rowData.values.dataValidation",
    });
    const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const found = new Set<string>();
    for (const row of rowData) {
      const condition = row.values?.[0]?.dataValidation?.condition;
      if (condition?.type !== "ONE_OF_LIST") continue;
      for (const v of condition.values ?? []) {
        const val = (v.userEnteredValue ?? "").trim();
        if (val) found.add(val);
      }
    }
    return Array.from(found);
  } catch {
    // Non-fatal — e.g. insufficient API scope, or no validation rule set.
    // Callers fall back to whatever driver names are actually in use.
    return [];
  }
}

/**
 * Reads column A (customer) and column D (driver) of "Customer Order
 * Details" on the ACTIVE (day-based) spreadsheet, grouped by customer.
 * A customer typically has many rows (one per product); this collapses
 * them down to one entry per customer plus the full list of sheet rows
 * that belong to them, so a driver change can be written to every row.
 *
 * driverOptions is the distinct, sorted list of driver names available to
 * pick from: every value currently in use in column D, UNIONED with the
 * sheet's own dropdown list (from column D's Data Validation rule, see
 * readDriverDropdownOptions). Using values-in-use alone would hide any
 * driver added to the sheet's dropdown until someone has already been
 * assigned to them — this makes sure newly added drivers show up in the
 * app right away, matching what's actually selectable in the sheet.
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

  // Union in the sheet's own dropdown list so newly-added drivers show up
  // even before anyone has been assigned to them.
  const dropdownOptions = await readDriverDropdownOptions();
  for (const d of dropdownOptions) driverSet.add(d);

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

/**
 * Write quantity values into column K ("Late Orders") of "Customer Order
 * Details" for the given sheet rows. Used for new orders submitted at/after
 * the late cutoff — kept separate from column C on purpose so the main
 * order total isn't affected by late submissions. The "LATE" tab reads this
 * column live via SUMIF formulas, so no extra write is needed to keep
 * per-product totals current.
 */
export async function writeLateOrderQuantities(
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getActiveSheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({
        range: `${TAB_CUSTOMERS}!K${e.row}`,
        values: [[e.quantity > 0 ? String(e.quantity) : ""]],
      })),
    },
  });
}

/**
 * Add a late add-on quantity into column K for a single row, ACCUMULATING on
 * top of whatever is already there rather than overwriting it — a customer
 * can place more than one late add-on in an evening, and each one should add
 * to the running late total for that row instead of clobbering the last one.
 */
export async function addLateOrderQuantityToRow(
  row: number,
  quantity: number,
): Promise<void> {
  if (quantity <= 0) return;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getActiveSheetId(),
    range: `${TAB_CUSTOMERS}!K${row}`,
  });
  const currentRaw = (res.data.values?.[0]?.[0] ?? "").toString().trim();
  const current = currentRaw === "" ? 0 : parseInt(currentRaw, 10);
  const newTotal = (Number.isFinite(current) ? current : 0) + quantity;
  await writeCells([
    { range: `${TAB_CUSTOMERS}!K${row}`, value: String(newTotal) },
  ]);
}

// A clearly-red, still-legible-with-black-text fill (close to Material Red
// 500 / #F44336) used to flag column C cells that include a late quantity.
const LATE_ORDER_RED = { red: 0.96, green: 0.26, blue: 0.21 };

/**
 * Sets (or clears, passing color: null) the background fill on a batch of
 * individual cells in one request. Only touches formatting — the `fields`
 * mask is scoped to backgroundColor alone, so this never overwrites a
 * cell's value or formula (important for column C, which is often a live
 * SUM formula, not a plain number).
 */
async function setCellBackgroundColors(
  cells: Array<{ row: number; col: string }>,
  color: { red: number; green: number; blue: number } | null,
) {
  if (!cells.length) return;
  const sheetId = await getCustomerSheetId();
  const sheets = await getSheetsClient();
  const requests = cells.map(({ row, col }) => {
    const colIndex = col.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: row - 1,
          endRowIndex: row,
          startColumnIndex: colIndex,
          endColumnIndex: colIndex + 1,
        },
        rows: [{ values: [{ userEnteredFormat: { backgroundColor: color ?? { red: 1, green: 1, blue: 1 } } }] }],
        fields: "userEnteredFormat.backgroundColor",
      },
    };
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getActiveSheetId(),
    requestBody: { requests },
  });
}

/**
 * Late orders now also land in column C (the main quantity total), in
 * addition to column K — so the kitchen sees the real total to prepare
 * without needing to separately check the LATE tab — but the C cell is
 * highlighted red so it's still obvious at a glance which totals include
 * a late addition. Used for brand-new late orders (submitOrder), where C
 * hasn't been written yet today, so this is a plain overwrite exactly
 * like writeOrderQuantities.
 */
export async function writeLateOrderQuantitiesToColumnC(
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  await writeOrderQuantities(entries);
  await setCellBackgroundColors(
    entries.filter((e) => e.quantity > 0).map((e) => ({ row: e.row, col: "C" })),
    LATE_ORDER_RED,
  );
}

/**
 * Late ADD-ON quantity into column C: reuses the same F..Z add-on-column
 * mechanism as addOnQuantityToRow (so it correctly adds on top of
 * whatever's already in C via formula, rather than clobbering an existing
 * on-time order or an earlier add-on that day), then highlights the C cell
 * red the same way writeLateOrderQuantitiesToColumnC does.
 */
export async function addLateQuantityToColumnC(
  row: number,
  quantity: number,
): Promise<void> {
  if (quantity <= 0) return;
  await addOnQuantityToRow(row, quantity);
  await setCellBackgroundColors([{ row, col: "C" }], LATE_ORDER_RED);
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
