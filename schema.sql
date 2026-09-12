CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  category TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  payment_provider TEXT DEFAULT 'InfinitePay',
  payment_method TEXT,
  payment_transaction_nsu TEXT,
  payment_invoice_slug TEXT,
  payment_receipt_url TEXT,
  customer_id BIGINT REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('DELIVERY','PICKUP')),
  subtotal_cents INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  address JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  customer_confirmed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  stars INTEGER CHECK (stars IS NULL OR (stars BETWEEN 1 AND 5)),
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
