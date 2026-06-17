// Server-only helpers for talking to the Portugal Bakery Google Sheet
// through the Lovable connector gateway.

const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

export const PORTUGAL_BAKERY_SHEET_ID =
  "18n8m7xpZleB6d9l2ccwOqRWbc8QxLVBXftdBVlxL2tQ";

export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${PORTUGAL_BAKERY_SHEET_ID}/edit`;

const TAB_CUSTOMERS = "Customer Order Details";
const TAB_PRODUCTS = "Products List";

function authHeaders() {
  const lovable = process.env.LOVABLE_API_KEY;
  const conn = process.env.GOOGLE_SHEETS_API_KEY;
  if (!lovable || !conn) {
    throw new Error(
      "Google Sheets connector is not configured (missing LOVABLE_API_KEY or GOOGLE_SHEETS_API_KEY).",
    );
  }
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": conn,
    "Content-Type": "application/json",
  };
}

async function gw(path: string, init?: RequestInit) {
  const res = await fetch(`${GATEWAY}/spreadsheets/${PORTUGAL_BAKERY_SHEET_ID}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets gateway ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function readCustomerRows(): Promise<string[][]> {
  const data = await gw(`/values/${encodeURI(TAB_CUSTOMERS)}!A1:E2000`);
  return (data.values as string[][]) ?? [];
}

export async function readProductRows(): Promise<string[][]> {
  const data = await gw(`/values/${encodeURI(TAB_PRODUCTS)}!A1:B2000`);
  return (data.values as string[][]) ?? [];
}

export async function readRowFull(row: number): Promise<string[]> {
  const data = await gw(`/values/${encodeURI(TAB_CUSTOMERS)}!A${row}:Z${row}`);
  const vals = (data.values as string[][]) ?? [];
  return vals[0] ?? [];
}

/** Write quantity values into column C of "Customer Order Details" for the given sheet rows. */
export async function writeOrderQuantities(
  entries: Array<{ row: number; quantity: number }>,
) {
  if (!entries.length) return;
  const body = {
    valueInputOption: "USER_ENTERED",
    data: entries.map((e) => ({
      range: `${TAB_CUSTOMERS}!C${e.row}`,
      values: [[e.quantity > 0 ? String(e.quantity) : ""]],
    })),
  };
  await gw(`/values:batchUpdate`, { method: "POST", body: JSON.stringify(body) });
}

/** Write arbitrary single-cell values. */
export async function writeCells(entries: Array<{ range: string; value: string }>) {
  if (!entries.length) return;
  const body = {
    valueInputOption: "USER_ENTERED",
    data: entries.map((e) => ({ range: e.range, values: [[e.value]] })),
  };
  await gw(`/values:batchUpdate`, { method: "POST", body: JSON.stringify(body) });
}

export async function clearOrderQuantities(rows: number[]) {
  if (!rows.length) return;
  await writeOrderQuantities(rows.map((r) => ({ row: r, quantity: 0 })));
}

/** Append new customer rows. Returns the starting row number of the appended block. */
export async function appendCustomerRows(
  rows: Array<{ customer: string; product: string; driver: string }>,
): Promise<number> {
  if (!rows.length) return 0;
  const values = rows.map((r) => [r.customer, r.product, "", r.driver, "No"]);
  const data = await gw(
    `/values/${encodeURI(TAB_CUSTOMERS)}!A:E:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values }) },
  );
  const updatedRange: string = data?.updates?.updatedRange ?? "";
  const m = updatedRange.match(/!\w+(\d+):/);
  return m ? parseInt(m[1], 10) : 0;
}

let _customerSheetId: number | null = null;
export async function getCustomerSheetId(): Promise<number> {
  if (_customerSheetId !== null) return _customerSheetId;
  const data = await gw(`?fields=sheets.properties`);
  const sheets = (data.sheets as Array<{ properties: { sheetId: number; title: string } }>) ?? [];
  const s = sheets.find((x) => x.properties.title === TAB_CUSTOMERS);
  if (!s) throw new Error(`Tab "${TAB_CUSTOMERS}" not found`);
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
    return await appendCustomerRows([
      { customer: opts.customerName, product: opts.productName, driver: "Collection" },
    ]).then(async (r) => {
      if (opts.quantity > 0) await writeOrderQuantities([{ row: r, quantity: opts.quantity }]);
      return r;
    });
  }

  const sheetId = await getCustomerSheetId();
  const above = all[lastRow1 - 1] ?? [];
  const driver = (above[3] ?? "Collection").trim() || "Collection";
  const colE = (above[4] ?? "No").trim() || "No";

  // Insert blank row at lastRow1 (0-based startIndex = lastRow1)
  await gw(`:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
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
    }),
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
  // Read F..Z and current C
  const rangeReads = await gw(
    `/values:batchGet?ranges=${encodeURI(TAB_CUSTOMERS)}!C${row}&ranges=${encodeURI(TAB_CUSTOMERS)}!F${row}:Z${row}&ranges=${encodeURI(TAB_CUSTOMERS)}!C${row}?valueRenderOption=FORMULA`,
  );
  // The above batchGet collapses params; do it cleanly with two calls instead:
  const cValue = await gw(`/values/${encodeURI(TAB_CUSTOMERS)}!C${row}?valueRenderOption=FORMULA`);
  const fzValues = await gw(`/values/${encodeURI(TAB_CUSTOMERS)}!F${row}:Z${row}`);
  void rangeReads;

  const cRaw = (cValue?.values?.[0]?.[0] ?? "").toString();
  const fz = (fzValues?.values?.[0] ?? []) as string[];

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
    // Strip leading "=", reuse expression
    baseExpr = cRaw.slice(1);
    // If the existing formula already contains add-on cell refs, rebuild from scratch using the first numeric component if any
    // Safer: rebuild as (existingExpr without trailing +<col><row> refs) + new sums
    // We'll just keep it simple and append; duplicates can be cleaned by user.
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
