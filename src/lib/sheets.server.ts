// Server-only helpers for talking to the Portugal Bakery Google Sheet
// directly via the Google Sheets API, using a service account.

import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PORTUGAL_BAKERY_SHEET_ID =
  "18n8m7xpZleB6d9l2ccwOqRWbc8QxLVBXftdBVlxL2tQ";

export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${PORTUGAL_BAKERY_SHEET_ID}/edit`;

const TAB_CUSTOMERS = "Customer Order Details";
const TAB_PRODUCTS = "Products List";

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
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
    range: `${TAB_CUSTOMERS}!A1:E2000`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function readProductRows(): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
    range: `${TAB_PRODUCTS}!A1:B2000`,
  });
  return (res.data.values as string[][]) ?? [];
}

export async function readRowFull(row: number): Promise<string[]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
    range: `${TAB_CUSTOMERS}!A${row}:Z${row}`,
  });
  const vals = (res.data.values as string[][]) ?? [];
  return vals[0] ?? [];
}

// ============================== WRITES ==============================

/** Write quantity values into column C of "Customer Order Details" for the given sheet rows. */
export async function writeOrderQuantities(
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
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
export async function writeCells(entries: Array<{ range: string; value: string }>) {
  if (!entries.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: entries.map((e) => ({ range: e.range, values: [[e.value]] })),
    },
  });
}

/** Append new customer rows. Returns the starting row number of the appended block. */
export async function appendCustomerRows(
  rows: Array<{ customer: string; product: string; driver: string }>,
): Promise<number> {
  if (!rows.length) return 0;
  const sheets = await getSheetsClient();
  const values = rows.map((r) => [r.customer, r.product, "", r.driver, "No"]);

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
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

let _customerSheetId: number | null = null;
export async function getCustomerSheetId(): Promise<number> {
  if (_customerSheetId !== null) return _customerSheetId;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
    fields: "sheets.properties",
  });
  const sheetList = res.data.sheets ?? [];
  const s = sheetList.find((x) => x.properties?.title === TAB_CUSTOMERS);
  if (!s || s.properties?.sheetId == null) {
    throw new Error(`Tab "${TAB_CUSTOMERS}" not found`);
  }
  _customerSheetId = s.properties.sheetId;
  return _customerSheetId;
}

/**
 * Insert a new row for a customer immediately below their last existing row.
 * Copies col A (customer), D (driver), E from row above; sets B (product), C (quantity).
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
      { customer: opts.customerName, product: opts.productName, driver: "Collection" },
    ]);
    if (opts.quantity > 0) await writeOrderQuantities([{ row: r, quantity: opts.quantity }]);
    return r;
  }

  const sheetId = await getCustomerSheetId();
  const above = all[lastRow1 - 1] ?? [];
  const driver = (above[3] ?? "Collection").trim() || "Collection";
  const colE = (above[4] ?? "No").trim() || "No";

  const sheets = await getSheetsClient();
  // Insert blank row at lastRow1 (0-based startIndex = lastRow1)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
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
      ],
    },
  });

  const newRow = lastRow1 + 1;
  await writeCells([
    { range: `${TAB_CUSTOMERS}!A${newRow}`, value: opts.customerName },
    { range: `${TAB_CUSTOMERS}!B${newRow}`, value: opts.productName },
    { range: `${TAB_CUSTOMERS}!C${newRow}`, value: opts.quantity > 0 ? String(opts.quantity) : "" },
    { range: `${TAB_CUSTOMERS}!D${newRow}`, value: driver },
    { range: `${TAB_CUSTOMERS}!E${newRow}`, value: colE },
  ]);
  return newRow;
}

/**
 * Add-on write: for a given product row, find the next empty column starting
 * at F, write the add-on quantity there, and update column C so it sums the
 * original value plus all filled add-on columns.
 */
export async function addOnQuantityToRow(row: number, quantity: number): Promise<string> {
  if (quantity <= 0) return "";
  const sheets = await getSheetsClient();

  // Read current C (as formula) and F..Z values
  const [cValueRes, fzValuesRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
      range: `${TAB_CUSTOMERS}!C${row}`,
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: PORTUGAL_BAKERY_SHEET_ID,
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
  for (let i = 0; i < idx; i++) filledLetters.push(String.fromCharCode("F".charCodeAt(0) + i));
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
  const newFormula = `=${baseExpr}+` + filledLetters.map((L) => `${L}${row}`).join("+");

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