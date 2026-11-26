INSERT INTO customers (org_id, customer_id, name, email, city)
SELECT org_id,
       'cust-' || md5(customer_email),
       max(customer_name),
       customer_email,
       max(customer_city)
FROM staging.flat_sales
GROUP BY org_id, customer_email
ON CONFLICT DO NOTHING;

INSERT INTO categories (org_id, category_id, name)
SELECT DISTINCT org_id, 'cat-' || md5(category), category
FROM staging.flat_sales
ON CONFLICT DO NOTHING;

WITH flat_products AS (
  SELECT f.org_id,
         trim(product_name) AS product_name,
         f.category,
         f.unit_price
  FROM staging.flat_sales f
  CROSS JOIN LATERAL unnest(string_to_array(f.product_names, ',')) AS parts(product_name)
)
INSERT INTO products (org_id, product_id, name, category_id, catalog_price)
SELECT org_id,
       'prod-' || md5(product_name),
       product_name,
       'cat-' || md5(max(category)),
       max(unit_price)
FROM flat_products
GROUP BY org_id, product_name
ON CONFLICT DO NOTHING;

INSERT INTO orders (org_id, order_id, customer_id, order_date)
SELECT org_id,
       order_id,
       'cust-' || md5(max(customer_email)),
       min(order_date)
FROM staging.flat_sales
GROUP BY org_id, order_id
ON CONFLICT DO NOTHING;

INSERT INTO order_items (org_id, order_id, line_no, product_id, unit_price, quantity)
SELECT f.org_id,
       f.order_id,
       row_number() OVER (
         PARTITION BY f.org_id, f.order_id
         ORDER BY trim(product_name)
       )::integer,
       'prod-' || md5(trim(product_name)),
       f.unit_price,
       f.quantity
FROM staging.flat_sales f
CROSS JOIN LATERAL unnest(string_to_array(f.product_names, ',')) AS parts(product_name)
ON CONFLICT DO NOTHING;
