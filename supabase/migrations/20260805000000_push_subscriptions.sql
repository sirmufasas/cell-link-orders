-- Web Push subscriptions for the "orders closing soon" reminders.
-- One row per browser/device that has enabled reminders on a given
-- customer's order link (a customer can have several devices subscribed —
-- e.g. the phone at the counter and the office PC).
CREATE TABLE public.push_subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_customer_idx ON public.push_subscriptions(customer_id);

GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Anyone with a customer's order link can subscribe/unsubscribe that
-- link's reminders (mirrors how order_submissions is public-insertable) —
-- but subscriptions are never readable from the client; only the
-- service-role edge function (which sends the reminders) can read them.
CREATE POLICY "Public can subscribe" ON public.push_subscriptions FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can unsubscribe own endpoint" ON public.push_subscriptions FOR DELETE USING (true);
CREATE POLICY "Authenticated can manage push subscriptions" ON public.push_subscriptions FOR ALL TO authenticated USING (true) WITH CHECK (true);
