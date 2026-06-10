
CREATE TABLE public.customers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  driver TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.customers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view customers" ON public.customers FOR SELECT USING (true);
CREATE POLICY "Authenticated can manage customers" ON public.customers FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view products" ON public.products FOR SELECT USING (true);
CREATE POLICY "Authenticated can manage products" ON public.products FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.customer_products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  sheet_row INT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, sheet_row)
);
CREATE INDEX customer_products_customer_idx ON public.customer_products(customer_id);
GRANT SELECT ON public.customer_products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_products TO authenticated;
GRANT ALL ON public.customer_products TO service_role;
ALTER TABLE public.customer_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view customer products" ON public.customer_products FOR SELECT USING (true);
CREATE POLICY "Authenticated can manage customer products" ON public.customer_products FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.order_submissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  for_date DATE NOT NULL,
  total_items INT NOT NULL DEFAULT 0,
  synced_to_sheet BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_submissions_customer_idx ON public.order_submissions(customer_id);
CREATE INDEX order_submissions_date_idx ON public.order_submissions(for_date);
GRANT SELECT, INSERT ON public.order_submissions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_submissions TO authenticated;
GRANT ALL ON public.order_submissions TO service_role;
ALTER TABLE public.order_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view submissions" ON public.order_submissions FOR SELECT USING (true);
CREATE POLICY "Public can insert submissions" ON public.order_submissions FOR INSERT WITH CHECK (true);
CREATE POLICY "Authenticated can manage submissions" ON public.order_submissions FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.order_submission_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES public.order_submissions(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INT NOT NULL,
  sheet_row INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_items_submission_idx ON public.order_submission_items(submission_id);
GRANT SELECT, INSERT ON public.order_submission_items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_submission_items TO authenticated;
GRANT ALL ON public.order_submission_items TO service_role;
ALTER TABLE public.order_submission_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can view items" ON public.order_submission_items FOR SELECT USING (true);
CREATE POLICY "Public can insert items" ON public.order_submission_items FOR INSERT WITH CHECK (true);
CREATE POLICY "Authenticated can manage items" ON public.order_submission_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
