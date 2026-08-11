# "Orders closing soon" push reminders — setup

This adds real push notifications sent at **6:00, 6:30 and 6:45 PM**
reminding customers that orders close at **7:00 PM**, using the same siren +
shouted-voice alert as the admin "new order" sound (shared code in
`src/lib/alertSound.ts`).

**Important limitation of web push (not specific to this app):** browsers
only allow custom audio (the siren + speech) to play from an actual open
tab. If someone has the order page open — even in the background — the
service worker wakes it and plays the real alert. If they don't have any
tab open at all, they instead get a normal system notification with the
OS's default sound. There's no way around this; it's a browser/OS
restriction on background pages, not a limitation of this implementation.

## What's already done (in this repo)

- `src/lib/alertSound.ts` — the shared siren+voice sound (used by both
  admin.tsx and the reminder flow).
- `public/sw.js` — service worker that receives pushes and either wakes an
  open tab (real siren) or shows a system notification (fallback).
- `src/lib/push.ts` + the "🔔 Get closing-time reminders" button on each
  customer's order page — lets a customer opt in/out per device.
- `src/lib/pushReminders.functions.ts` — stores/removes subscriptions.
- `supabase/migrations/20260805000000_push_subscriptions.sql` — the table.
- `supabase/functions/send-order-reminders/index.ts` — the function that
  actually sends the pushes to everyone subscribed, when invoked.

## What you still need to do

I don't have deploy access to your actual Supabase/Netlify project (the
Supabase account connected to this session is a different, unrelated
project), so these steps have to be run from your side:

### 1. Apply the migration
```
supabase db push
```
(or run the SQL in `supabase/migrations/20260805000000_push_subscriptions.sql`
directly in the Supabase SQL editor). Then regenerate types so the app
type-checks against the new table:
```
supabase gen types typescript --project-id <your-project-id> > src/integrations/supabase/types.ts
```

### 2. VAPID keys (already generated for you)
Web push requires a VAPID keypair to sign notifications. I generated a real
one so you don't have to:

```
PUBLIC:  BGyX6kmJyA6mI0xSFAjLGAfIWizsEASXW4JZSWxMLW5-FSNiG-1s4qZ42Cacg5C0qLXgJmydG2qBaG-MJ9l53PY
PRIVATE: 844mUvcPjUzfXtPW86maZyZuqV202zP4_nGyO_-IHJk
```
(You can generate your own instead with `npx web-push generate-vapid-keys`
if you'd rather not use a key you didn't generate yourself.)

Set these:
- **Netlify** (site env vars): `VITE_VAPID_PUBLIC_KEY` = the public key above.
- **Supabase Edge Function secrets**:
  ```
  supabase secrets set VAPID_PUBLIC_KEY=BGyX6kmJyA6mI0xSFAjLGAfIWizsEASXW4JZSWxMLW5-FSNiG-1s4qZ42Cacg5C0qLXgJmydG2qBaG-MJ9l53PY
  supabase secrets set VAPID_PRIVATE_KEY=844mUvcPjUzfXtPW86maZyZuqV202zP4_nGyO_-IHJk
  supabase secrets set VAPID_CONTACT_EMAIL=mailto:you@yourdomain.com
  supabase secrets set SITE_URL=https://your-live-site-url.com
  ```
  (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are already available to
  every Edge Function automatically — no need to set those yourself.)

### 3. Deploy the edge function
```
supabase functions deploy send-order-reminders
```

### 4. Schedule it for 7:00 / 7:30 / 7:45 PM
Easiest: **Supabase Dashboard → Edge Functions → send-order-reminders →
Cron**, and add three schedules. Assuming the bakery runs on South Africa
time (UTC+2, no DST) — adjust if that's wrong:

| Local time | Cron (UTC)     | Body                          |
|-----------|-----------------|--------------------------------|
| 6:00 PM   | `0 16 * * *`    | `{"minutesBeforeClose": 60}`  |
| 6:30 PM   | `30 16 * * *`   | `{"minutesBeforeClose": 30}`  |
| 6:45 PM   | `45 16 * * *`   | `{"minutesBeforeClose": 15}`  |

Or, via SQL (`pg_cron` + `pg_net` extensions), if you'd rather manage it in
the database — replace `<project-ref>` and `<service-role-key>`:

```sql
select cron.schedule('order-reminder-600pm', '0 16 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/send-order-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>', 'Content-Type', 'application/json'),
    body := '{"minutesBeforeClose": 60}'::jsonb
  );
$$);
-- repeat for '30 17 * * *' (60 min) and '45 17 * * *' (15 min)
```

That's it — once deployed and scheduled, anyone who taps "🔔 Get
closing-time reminders" on their order link will get the alert at those
three times.
