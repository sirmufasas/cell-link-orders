import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * If an external webhook (like the Google Sheets Apps Script trigger) POSTs
 * plain JSON `{"spreadsheetId":"..."}` to a TanStack Start `/_serverFn/`
 * endpoint instead of a Seroval AST envelope `{"t":...,"f":31,"m":[]}`,
 * wrap it into the Seroval envelope and ensure the `Origin` header matches
 * the request URL so TanStack Start's CSRF + Seroval checks don't reject it
 * with 403 Forbidden or 500 "Seroval Error (step: 3)".
 */
async function normalizeServerFnWebhookRequest(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith("/_serverFn/")) {
    return request;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return request;
  }

  let rawBody: string;
  try {
    rawBody = await request.clone().text();
  } catch {
    return request;
  }

  const trimmed = rawBody.trim();
  let nextBody = rawBody;

  if (trimmed && trimmed !== "null") {
    try {
      const parsed = JSON.parse(trimmed);
      // If it's a plain JSON object (e.g. { spreadsheetId: "..." }) and NOT
      // already a Seroval envelope ({ t: ..., f: ..., m: ... }), wrap it.
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        !("t" in parsed && "f" in parsed)
      ) {
        const payloadObj =
          "data" in parsed && parsed.data && typeof parsed.data === "object"
            ? (parsed.data as Record<string, unknown>)
            : (parsed as Record<string, unknown>);
        const keys = Object.keys(payloadObj);
        const vals = keys.map((k) => {
          const v = payloadObj[k];
          if (typeof v === "string") return { t: 1, s: v };
          if (typeof v === "number") return { t: 0, s: v };
          if (typeof v === "boolean") return { t: 2, s: v ? 1 : 0 };
          return { t: 2, s: 0 };
        });
        nextBody = JSON.stringify({
          t: {
            t: 10,
            i: 0,
            p: {
              k: ["data"],
              v: [
                {
                  t: 10,
                  i: 1,
                  p: { k: keys, v: vals },
                  o: 0,
                },
              ],
            },
            o: 0,
          },
          f: 31,
          m: [],
        });
      }
    } catch {
      // Leave body as-is if not valid JSON
    }
  }

  const headers = new Headers(request.headers);
  if (!headers.get("origin")) {
    headers.set("origin", url.origin);
  }
  if (!headers.get("x-tsr-serverFn")) {
    headers.set("x-tsr-serverFn", "true");
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: nextBody,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const normalizedRequest = await normalizeServerFnWebhookRequest(request);
      const handler = await getServerEntry();
      const response = await handler.fetch(normalizedRequest, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
