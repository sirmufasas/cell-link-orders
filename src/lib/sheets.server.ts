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

/** Clear column C for given rows (used when starting a new daily order). */
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
  // updatedRange looks like "'Customer Order Details'!A742:E750"
  const updatedRange: string = data?.updates?.updatedRange ?? "";
  const m = updatedRange.match(/!\w+(\d+):/);
  return m ? parseInt(m[1], 10) : 0;
}
