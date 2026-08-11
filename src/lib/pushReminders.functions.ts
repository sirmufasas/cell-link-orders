import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Customer-facing "orders closing soon" push reminders.
//
// Storage only — the actual sending happens in the
// supabase/functions/send-order-reminders edge function, invoked on a
// schedule (see supabase/functions/send-order-reminders/README.md).

const SubscribeInput = z.object({
  slug: z.string().min(1),
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

export const subscribeToOrderReminders = createServerFn({ method: "POST" })
  .validator((d) => SubscribeInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: customer, error: cErr } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("slug", data.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!customer) throw new Error("Unknown customer");

    const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
      {
        customer_id: customer.id,
        endpoint: data.endpoint,
        p256dh: data.p256dh,
        auth: data.auth,
      },
      { onConflict: "endpoint" },
    );
    if (error) throw error;
    return { ok: true as const };
  });

const UnsubscribeInput = z.object({
  endpoint: z.string().url(),
});

export const unsubscribeFromOrderReminders = createServerFn({ method: "POST" })
  .validator((d) => UnsubscribeInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", data.endpoint);
    if (error) throw error;
    return { ok: true as const };
  });
