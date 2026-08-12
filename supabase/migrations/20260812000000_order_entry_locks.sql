-- Prevent two people using the same customer link from editing/submitting at
-- the same time. Locks are short leases: the active browser renews its lease,
-- and an abandoned lock expires automatically.
CREATE TABLE public.order_entry_locks (
  customer_id UUID PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  lock_token UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_entry_locks_expires_idx ON public.order_entry_locks(expires_at);

ALTER TABLE public.order_entry_locks ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.order_entry_locks TO service_role;
REVOKE ALL ON public.order_entry_locks FROM anon, authenticated;

-- Atomically acquire a free/expired lock or renew a lock already owned by the
-- same browser. Keeping this operation in Postgres removes the race between
-- checking a lock and creating it.
CREATE OR REPLACE FUNCTION public.acquire_order_entry_lock(
  p_slug TEXT,
  p_lock_token UUID,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE(acquired BOOLEAN, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id UUID;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_lease_seconds INTEGER := greatest(15, least(p_lease_seconds, 300));
BEGIN
  SELECT id INTO v_customer_id
  FROM public.customers
  WHERE slug = p_slug;

  IF v_customer_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO public.order_entry_locks AS current_lock (
    customer_id,
    lock_token,
    expires_at,
    updated_at
  )
  VALUES (
    v_customer_id,
    p_lock_token,
    v_now + make_interval(secs => v_lease_seconds),
    v_now
  )
  ON CONFLICT (customer_id) DO UPDATE
    SET lock_token = EXCLUDED.lock_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at
    WHERE current_lock.lock_token = EXCLUDED.lock_token
       OR current_lock.expires_at <= v_now;

  RETURN QUERY
  SELECT
    l.lock_token = p_lock_token AND l.expires_at > v_now,
    l.expires_at
  FROM public.order_entry_locks l
  WHERE l.customer_id = v_customer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_order_entry_lock(
  p_slug TEXT,
  p_lock_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.order_entry_locks l
  USING public.customers c
  WHERE l.customer_id = c.id
    AND c.slug = p_slug
    AND l.lock_token = p_lock_token;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_order_entry_lock(TEXT, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_order_entry_lock(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_order_entry_lock(TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_entry_lock(TEXT, UUID) TO service_role;
