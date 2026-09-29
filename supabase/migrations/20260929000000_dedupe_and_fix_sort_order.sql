-- ============================================================================
-- Deduplicate customers and align Admin customer list order with Google Sheets
-- Safe to run in Supabase SQL Editor (preserves 100% of order_submissions).
-- ============================================================================

begin;

-- 1) Merge "MICHELLE CHURCH" (/order/michelle-church-2) into "Michelle Church" (/order/michelle-church)
--    and "RAPIDO NOSSA CASSA" (/order/rapido-nossa-cassa-2) into "Rapido Nossa Cassa" (/order/rapido-nossa-cassa)
do $$
declare
  v_keep uuid;
  v_drop uuid;
  r record;
begin
  for r in
    select * from (values
      ('michelle-church',     'michelle-church-2'),
      ('rapido-nossa-cassa',  'rapido-nossa-cassa-2'),
      ('chip-world',          'chip-world-2'),
      ('excel',               'excel-2'),
      ('excel',               'excel-2-2'),
      ('function-hub',        'function-hub-2'),
      ('foodmania',           'food-mania'),
      ('holy-family',         'holy-family-2')
    ) as pairs(keep_slug, drop_slug)
  loop
    select id into v_keep from public.customers where slug = r.keep_slug;
    select id into v_drop from public.customers where slug = r.drop_slug;

    if v_keep is not null and v_drop is not null then
      -- Move any past orders to the canonical customer
      update public.order_submissions
      set customer_id = v_keep
      where customer_id = v_drop;

      -- Move any sheet assignments that the canonical customer doesn't already have
      insert into public.customer_sheet_assignments (customer_id, sheet_group_id, driver, sort_order)
      select v_keep, a.sheet_group_id, a.driver, a.sort_order
      from public.customer_sheet_assignments a
      where a.customer_id = v_drop
      on conflict (customer_id, sheet_group_id) do update
        set driver = coalesce(public.customer_sheet_assignments.driver, excluded.driver),
            sort_order = case
              when public.customer_sheet_assignments.sort_order = 0 then excluded.sort_order
              else public.customer_sheet_assignments.sort_order
            end;

      -- If the canonical customer has no products in a sheet group where the duplicate has fresh products,
      -- move those customer_products over (e.g. Thu-Sat rows for MICHELLE CHURCH / RAPIDO NOSSA CASSA).
      update public.customer_products cp
      set customer_id = v_keep
      where cp.customer_id = v_drop
        and not exists (
          select 1
          from public.customer_products existing
          where existing.customer_id = v_keep
            and existing.sheet_group_id = cp.sheet_group_id
        );

      -- Delete the duplicate customer (cascades remaining stale customer_products / assignments)
      delete from public.customers where id = v_drop;
    end if;
  end loop;
end $$;

-- 2) Remove stale Sep 15 customer_products rows left on Thu-Sat for Mon-Wed-only customers
delete from public.customer_products
where created_at < '2026-09-29T00:00:00Z';

-- 3) Fix customers.sort_order and customers.driver from customer_sheet_assignments
--    so JOE, PAUL 2, MICHELLE CHURCH, THEMBI, ALBA MALL, CIDALIA no longer sit at
--    sort_order = 0 above Alberton Meat on the Admin Dashboard.
with ranked_assignments as (
  select
    c.id as customer_id,
    coalesce(mon.driver, thu.driver, c.driver) as resolved_driver,
    coalesce(mon.sort_order, thu.sort_order, nullif(c.sort_order, 0), 9999) as resolved_sort_order
  from public.customers c
  left join public.sheet_groups g_mon on g_mon.slug = 'mon_tue_wed'
  left join public.sheet_groups g_thu on g_thu.slug = 'thu_fri_sat'
  left join public.customer_sheet_assignments mon
    on mon.customer_id = c.id and mon.sheet_group_id = g_mon.id
  left join public.customer_sheet_assignments thu
    on thu.customer_id = c.id and thu.sheet_group_id = g_thu.id
)
update public.customers c
set
  driver = ra.resolved_driver,
  sort_order = ra.resolved_sort_order
from ranked_assignments ra
where c.id = ra.customer_id;

commit;
