-- ============================================================================
-- 2026-09-16  Sheet groups: scope sheet-dependent data per spreadsheet.
--
-- The Mon–Wed and Thu–Sat spreadsheets have different row layouts, drivers
-- and sort orders. This adds:
--   * sheet_groups                  — one row per physical spreadsheet
--   * customer_sheet_assignments    — per-sheet driver + sort_order
--   * customer_products.sheet_group_id — which sheet each row mapping came from
--   * order_submissions.sheet_group_id — which sheet an order came from (new ones only)
--
-- PURELY ADDITIVE. No existing row in customers, order_submissions or
-- order_submission_items is modified — order history is untouched.
-- Idempotent (safe to re-run).
-- ============================================================================

-- 1) One row per physical spreadsheet
create table if not exists public.sheet_groups (
  id uuid not null default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  constraint sheet_groups_pkey primary key (id)
);

insert into public.sheet_groups (slug, name)
values ('mon_tue_wed', 'Mon / Tue / Wed'),
       ('thu_fri_sat', 'Thu / Fri / Sat')
on conflict (slug) do nothing;

grant select on public.sheet_groups to anon;
grant select, insert, update, delete on public.sheet_groups to authenticated;
grant all on public.sheet_groups to service_role;
alter table public.sheet_groups enable row level security;
drop policy if exists "Public can view sheet groups" on public.sheet_groups;
create policy "Public can view sheet groups" on public.sheet_groups
  for select using (true);
drop policy if exists "Authenticated can manage sheet groups" on public.sheet_groups;
create policy "Authenticated can manage sheet groups" on public.sheet_groups
  for all to authenticated using (true) with check (true);

-- 2) Tag existing customer_products with the sheet they came from.
--    The live app state is always "the sheet active for tomorrow's
--    delivery", so tag with the group that is active at migration time.
--    (Hitting Re-sync right after this — which syncs BOTH sheets — rewrites
--    every row that still exists in a sheet, so any edge-case guess
--    self-corrects on the very next sync.)
alter table public.customer_products
  add column if not exists sheet_group_id uuid
  references public.sheet_groups(id);

update public.customer_products
set sheet_group_id = (
  select g.id
  from public.sheet_groups g
  where g.slug = case
    -- Postgres dow: 0=Sun .. 6=Sat. Tomorrow Thu/Fri/Sat → Thu–Sat sheet.
    when extract(dow from (current_date + 1)) in (4, 5, 6) then 'thu_fri_sat'
    else 'mon_tue_wed'
  end
)
where sheet_group_id is null;

alter table public.customer_products
  alter column sheet_group_id set not null;

-- The old UNIQUE(customer_id, sheet_row) would collide the moment the
-- second sheet is synced (the same customer can legitimately have the same
-- row number in both sheets). Replace it with group-scoped indexes.
alter table public.customer_products
  drop constraint if exists customer_products_customer_id_sheet_row_key;

create index if not exists customer_products_customer_group_idx
  on public.customer_products (customer_id, sheet_group_id, sheet_row);
create index if not exists customer_products_group_row_idx
  on public.customer_products (sheet_group_id, sheet_row);

-- 3) Per-sheet driver + sort_order. Replaces the single global
--    customers.driver / customers.sort_order (those columns are left in
--    place, deprecated, until a follow-up migration drops them).
create table if not exists public.customer_sheet_assignments (
  id uuid not null default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  sheet_group_id uuid not null references public.sheet_groups(id) on delete cascade,
  driver text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint customer_sheet_assignments_pkey primary key (id),
  constraint customer_sheet_assignments_unique unique (customer_id, sheet_group_id)
);

grant select on public.customer_sheet_assignments to anon;
grant select, insert, update, delete on public.customer_sheet_assignments to authenticated;
grant all on public.customer_sheet_assignments to service_role;
alter table public.customer_sheet_assignments enable row level security;
drop policy if exists "Public can view customer sheet assignments" on public.customer_sheet_assignments;
create policy "Public can view customer sheet assignments" on public.customer_sheet_assignments
  for select using (true);
drop policy if exists "Authenticated can manage customer sheet assignments" on public.customer_sheet_assignments;
create policy "Authenticated can manage customer sheet assignments" on public.customer_sheet_assignments
  for all to authenticated using (true) with check (true);

-- Seed from the current global values, for the group active right now.
insert into public.customer_sheet_assignments (customer_id, sheet_group_id, driver, sort_order)
select c.id,
       (select g.id from public.sheet_groups g
        where g.slug = case
          when extract(dow from (current_date + 1)) in (4, 5, 6) then 'thu_fri_sat'
          else 'mon_tue_wed'
        end),
       c.driver,
       c.sort_order
from public.customers c
on conflict (customer_id, sheet_group_id) do nothing;

-- 4) Tag NEW orders with the sheet they came from. Nullable on purpose —
--    existing orders are left completely alone.
alter table public.order_submissions
  add column if not exists sheet_group_id uuid
  references public.sheet_groups(id);
create index if not exists order_submissions_group_idx
  on public.order_submissions (sheet_group_id);
