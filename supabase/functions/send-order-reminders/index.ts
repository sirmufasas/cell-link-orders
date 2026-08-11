// Sends the "orders closing soon" push reminder to every subscribed
// device. Invoked three times a day (7:00, 7:30, 7:45 PM) by a schedule —
// see supabase/functions/send-order-reminders/README.md for how to wire
// that up, since it has to be set up against your actual Supabase project
// (this repo's local config isn't connected to a live project here).
//
// POST body: { "minutesBeforeClose": 90 }   // 90, 60, or 15
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_CONTACT_EMAIL = Deno.env.get("VAPID_CONTACT_EMAIL") ?? "mailto:admin@example.com";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://example.com";

webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function messageFor(minutesBeforeClose: number): { title: string; body: string } {
  if (minutesBeforeClose >= 75) {
    return { title: "Orders closing soon", body: "Heads up — orders close at 8:30 PM tonight." };
  }
  if (minutesBeforeClose >= 45) {
    return { title: "Orders closing soon", body: "30 minutes left — orders close at 8:30 PM." };
  }
  return { title: "Last call — orders closing", body: "15 minutes left! Orders close at 8:30 PM." };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let minutesBeforeClose = 90;
  try {
    const body = await req.json();
    if (typeof body?.minutesBeforeClose === "number") minutesBeforeClose = body.minutesBeforeClose;
  } catch {
    // no body / not JSON — fall back to default above
  }

  const { title, body: message } = messageFor(minutesBeforeClose);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, customer_id, customers(slug)");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let sent = 0;
  let removed = 0;
  const failures: string[] = [];

  await Promise.all(
    (subs ?? []).map(async (row: any) => {
      const slug = row.customers?.slug;
      const payload = JSON.stringify({
        title,
        body: message,
        url: slug ? `${SITE_URL}/order/${slug}` : SITE_URL,
      });

      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          payload,
        );
        sent++;
        await supabase
          .from("push_subscriptions")
          .update({ last_sent_at: new Date().toISOString() })
          .eq("id", row.id);
      } catch (err: any) {
        // 404/410 = the browser/device unsubscribed or the subscription
        // expired on its own — clean it up so we stop trying it forever.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", row.id);
          removed++;
        } else {
          failures.push(String(err?.message ?? err));
        }
      }
    }),
  );

  return new Response(JSON.stringify({ sent, removed, failed: failures.length, failures }), {
    headers: { "Content-Type": "application/json" },
  });
});
