import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const LockInput = z.object({
  slug: z.string().min(1),
  lockToken: z.string().uuid(),
});

const LEASE_SECONDS = 10;

function lockMigrationMissing(error: any) {
  const message = String(error?.message ?? "");
  return error?.code === "PGRST202" || error?.code === "42883" || message.includes("order_entry_lock");
}

/**
 * Acquire this customer's order-entry lock, or renew it when this browser
 * already owns it. The database function performs the operation atomically.
 */
export const acquireOrderLock = createServerFn({ method: "POST" })
  .validator((input) => LockInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await (supabaseAdmin as any).rpc(
      "acquire_order_entry_lock",
      {
        p_slug: data.slug,
        p_lock_token: data.lockToken,
        p_lease_seconds: LEASE_SECONDS,
      },
    );

    // Keep ordering available during the short deployment window before the
    // accompanying migration is applied. Once the function exists, locking
    // is enforced normally.
    if (error && lockMigrationMissing(error)) return { acquired: true, expiresAt: null };
    if (error) throw error;
    const result = Array.isArray(rows) ? rows[0] : rows;
    return {
      acquired: result?.acquired === true,
      expiresAt: (result?.expires_at as string | null | undefined) ?? null,
    };
  });

export const releaseOrderLock = createServerFn({ method: "POST" })
  .validator((input) => LockInput.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: released, error } = await (supabaseAdmin as any).rpc(
      "release_order_entry_lock",
      {
        p_slug: data.slug,
        p_lock_token: data.lockToken,
      },
    );

    if (error && lockMigrationMissing(error)) return { released: false };
    if (error) throw error;
    return { released: released === true };
  });

export async function releaseActiveOrderLock(slug: string, lockToken: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await (supabaseAdmin as any).rpc("release_order_entry_lock", {
    p_slug: slug,
    p_lock_token: lockToken,
  });
  if (error) console.error("Could not release order-entry lock:", error);
}

/** Server-side guard used immediately before writing an order. */
export async function assertActiveOrderLock(slug: string, lockToken: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Give an in-progress submission a longer lease so a slow Google Sheets
  // write cannot overlap with the next person taking the lock.
  const { data: rows, error } = await (supabaseAdmin as any).rpc(
    "acquire_order_entry_lock",
    {
      p_slug: slug,
      p_lock_token: lockToken,
      p_lease_seconds: 300,
    },
  );

  if (error && lockMigrationMissing(error)) return;
  if (error) throw error;
  const result = Array.isArray(rows) ? rows[0] : rows;
  if (result?.acquired !== true) {
    throw new Error(
      "This order link is currently being used by someone else. Please wait for the page to unlock before submitting.",
    );
  }
}
