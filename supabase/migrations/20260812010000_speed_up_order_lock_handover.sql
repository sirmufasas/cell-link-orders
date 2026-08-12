-- Speed up lock handover: waiting browsers poll every 500 ms in the app, and
-- an abandoned browser lease now expires after about 10 seconds rather than 60.
CREATE OR REPLACE FUNCTION public.acquire_order_entry_lock(
  p_slug TEXT,
  p_lock_token UUID,
  p_lease_seconds INTEGER DEFAULT 10
)
RETURNS TABLE(acquired BOOLEAN, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id UUID;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_lease_seconds INTEGER := greatest(5, least(p_lease_seconds, 300));
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
        -- Never shorten the five-minute submission guard when an ordinary
        -- browser heartbeat arrives while Google Sheets is still being written.
        expires_at = CASE
          WHEN current_lock.lock_token = EXCLUDED.lock_token
            THEN greatest(current_lock.expires_at, EXCLUDED.expires_at)
          ELSE EXCLUDED.expires_at
        END,
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

REVOKE ALL ON FUNCTION public.acquire_order_entry_lock(TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_order_entry_lock(TEXT, UUID, INTEGER) TO service_role;
