import { Pool, PoolConfig } from "pg";
import dotenv from "dotenv";
import { CURRENCIES } from "./models/currency.model";

dotenv.config();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Remote providers (Render, Neon, Supabase, etc.) require SSL. */
function resolveSsl(): PoolConfig["ssl"] | undefined {
  const flag = (process.env.PGSSLMODE || process.env.DATABASE_SSL || "").toLowerCase();
  if (flag === "disable" || flag === "false") return undefined;
  if (flag === "require" || flag === "true") {
    return { rejectUnauthorized: false };
  }

  const host = process.env.PGHOST || "";
  const url = process.env.DATABASE_URL || "";
  const isLocalHost = LOCAL_HOSTS.has(host);
  const isRemoteUrl = /\.render\.com|neon\.tech|supabase\.co|amazonaws\.com/i.test(url);

  if ((!isLocalHost && host) || isRemoteUrl) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function buildPoolConfig(): PoolConfig {
  const ssl = resolveSsl();

  /**
   * Performance/stability tuning notes:
   * - keepAlive: sends TCP keep-alive probes so NAT / managed providers
   *   (Render free tier, Heroku, etc.) don't silently drop idle sockets.
   * - keepAliveInitialDelayMillis: start probing well before the typical
   *   ~5-minute idle kill window on Render.
   * - idleTimeoutMillis: recycle pool clients ourselves *before* the
   *   server kills them, so we don't hand out half-dead sockets.
   * - connectionTimeoutMillis: bound how long a single connect attempt
   *   can hang on a slow / unreachable remote DB. Kept generous (30s) because
   *   managed free tiers (Render, etc.) spin the DB down when idle and a cold
   *   start over a high-latency link can take well past 10s.
   * - statement_timeout: prevent a single runaway query from holding a
   *   client forever.
   */
  const shared: Partial<PoolConfig> = {
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 15_000,
  };

  if (process.env.DATABASE_URL) {
    return { ...shared, connectionString: process.env.DATABASE_URL, ssl };
  }
  return {
    ...shared,
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "multi_driver_h3",
    ssl,
  };
}

export const pool = new Pool(buildPoolConfig());

/**
 * pg emits a pool-level `error` event when an *idle* client throws (typical
 * symptom on Render free tier: `Connection terminated unexpectedly`). If we
 * don't attach a listener the process can crash. Logging it lets the pool
 * silently evict the dead client and create a fresh one on the next acquire.
 */
pool.on("error", (err) => {
  console.error("[pg] idle client error (dropping client):", err.message);
});

/**
 * Idempotent schema bootstrap.
 *
 * Supports three primary roles: driver, sender, receiver (plus admin).
 * Drivers create zones (H3 cells / geofences) with per-zone cost and
 * settings. Senders create orders that target a receiver and travel
 * through driver zones.
 */
export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        full_name       TEXT        NOT NULL,
        company_name    TEXT        NOT NULL DEFAULT '',
        email           TEXT        NOT NULL UNIQUE,
        hashed_password TEXT        NOT NULL,
        role            TEXT        NOT NULL DEFAULT 'sender',
        phone           TEXT        NOT NULL DEFAULT '',
        address         TEXT        NOT NULL DEFAULT '',
        lat             DOUBLE PRECISION,
        lng             DOUBLE PRECISION,
        trustworthiness INTEGER     NOT NULL DEFAULT 0,
        is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Backfill columns on existing installs.
    await client.query(`ALTER TABLE users ALTER COLUMN company_name DROP NOT NULL;`).catch(() => undefined);
    await client.query(`ALTER TABLE users ALTER COLUMN company_name SET DEFAULT '';`);
    await client.query(`UPDATE users SET company_name = '' WHERE company_name IS NULL;`);
    await client.query(`ALTER TABLE users ALTER COLUMN company_name SET NOT NULL;`);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trustworthiness INTEGER NOT NULL DEFAULT 0;`);

    // Refresh the role check constraint to cover the new roles.
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
    await client.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'driver', 'sender', 'receiver', 'user'));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (LOWER(email));
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_zones (
        id                       SERIAL PRIMARY KEY,
        owner_user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
        driver_name              TEXT        NOT NULL,
        zone_name                TEXT        NOT NULL,
        resolution               INTEGER     NOT NULL CHECK (resolution BETWEEN 0 AND 15),
        h3_cells                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
        transport_modes          TEXT[]      NOT NULL DEFAULT '{}',
        transport_mode           TEXT,
        boundary                 JSONB,
        rate_cost                NUMERIC(12, 2) NOT NULL DEFAULT 0,
        currency                 TEXT        NOT NULL DEFAULT 'USD',
        available                BOOLEAN     NOT NULL DEFAULT TRUE,
        trust_payment_forwarder  BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS transport_modes TEXT[] NOT NULL DEFAULT '{}';`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS transport_mode TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS boundary JSONB;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS rate_cost NUMERIC(12, 2) NOT NULL DEFAULT 0;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';`);
    // Milestone 5 (revised) — detailed per-zone pricing rules. The transporter
    // defines these when creating/editing a zone; route cost calculation reads
    // them directly from the zone. All nullable so a zone with no pricing set
    // is treated as "missing cost" (manual entry required). `base_fee` is
    // backfilled from the old flat `rate_cost` so existing zones keep their value.
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS base_fee NUMERIC(12, 2);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS cost_per_h3_cell NUMERIC(12, 4);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS cost_per_km NUMERIC(12, 4);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS cost_per_kg NUMERIC(12, 4);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS cost_per_volume_unit NUMERIC(12, 6);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS time_of_day_factor NUMERIC(8, 4);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS minimum_fee NUMERIC(12, 2);`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS cost_per_hour NUMERIC(12, 4);`);
    await client.query(
      `UPDATE driver_zones SET base_fee = rate_cost
       WHERE base_fee IS NULL AND rate_cost IS NOT NULL AND rate_cost > 0;`
    );
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS trust_payment_forwarder BOOLEAN NOT NULL DEFAULT FALSE;`);
    // Persist the zone creation method explicitly (previously inferred from
    // the presence of a boundary). "geofence" when a polygon boundary was
    // drawn, otherwise "h3". Backfilled from `boundary` for existing rows.
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS zone_type TEXT NOT NULL DEFAULT 'h3';`);
    await client.query(
      `UPDATE driver_zones SET zone_type = CASE WHEN boundary IS NOT NULL THEN 'geofence' ELSE 'h3' END
       WHERE zone_type IS NULL OR zone_type = '';`
    );
    await client.query(`ALTER TABLE driver_zones DROP CONSTRAINT IF EXISTS driver_zones_zone_type_check;`);
    await client.query(
      `ALTER TABLE driver_zones ADD CONSTRAINT driver_zones_zone_type_check CHECK (zone_type IN ('h3', 'geofence'));`
    );
    // Drop and rebuild the currency CHECK each boot so adding a code to
    // `CURRENCIES` automatically widens the allowed set without a manual
    // migration. The IN list is derived from the same constant the API uses.
    await client.query(`ALTER TABLE driver_zones DROP CONSTRAINT IF EXISTS driver_zones_currency_check;`);
    const currencyList = CURRENCIES.map((c) => `'${c}'`).join(", ");
    await client.query(
      `ALTER TABLE driver_zones
         ADD CONSTRAINT driver_zones_currency_check CHECK (currency IN (${currencyList}));`
    );
    // Backfill transport_mode from the existing array, defaulting to 'land'.
    await client.query(`UPDATE driver_zones SET transport_mode = COALESCE(transport_mode, transport_modes[1], 'land') WHERE transport_mode IS NULL OR transport_mode = '';`);

    // Air/sea routes: explicit departure + arrival hub terminals (point-based,
    // not area coverage). Land zones leave these NULL.
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS departure_hub_name TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS departure_hub_lat DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS departure_hub_lng DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS arrival_hub_name TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS arrival_hub_lat DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS arrival_hub_lng DOUBLE PRECISION;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS departure_time TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS arrival_time TEXT;`);
    // Per-zone operation schedule — date + daily hours (land) or flight times (air/sea).
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS operation_date DATE;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS operating_start_time TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS operating_end_time TEXT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS operation_start_date DATE;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS operation_end_date DATE;`);
    await client.query(
      `ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS schedule_pattern TEXT NOT NULL DEFAULT 'daily';`
    );
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS weekday_start SMALLINT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS weekday_end SMALLINT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS month_day_start SMALLINT;`);
    await client.query(`ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS month_day_end SMALLINT;`);
    await client.query(
      `UPDATE driver_zones
         SET operation_start_date = COALESCE(operation_start_date, operation_date),
             operation_end_date = COALESCE(operation_end_date, operation_date)
       WHERE operation_date IS NOT NULL
         AND (operation_start_date IS NULL OR operation_end_date IS NULL);`
    );
    await client.query(`ALTER TABLE driver_zones DROP CONSTRAINT IF EXISTS driver_zones_schedule_pattern_check;`);
    await client.query(
      `ALTER TABLE driver_zones
         ADD CONSTRAINT driver_zones_schedule_pattern_check
         CHECK (schedule_pattern IN ('daily', 'weekly', 'monthly'));`
    );

    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_owner_user_id ON driver_zones (owner_user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_h3_cells ON driver_zones USING GIN (h3_cells);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_resolution ON driver_zones (resolution);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_zones_available ON driver_zones (available);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT        NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        revoked_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens (user_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT        NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens (user_id);`);

    // Followers (sender / receiver follow drivers; each follow bumps trustworthiness).
    await client.query(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_user_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        driver_user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (follower_user_id, driver_user_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_follows_driver_user_id ON follows (driver_user_id);`);

    // Orders (sender -> receiver, optionally fulfilled by a driver).
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                  SERIAL PRIMARY KEY,
        sender_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        driver_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sender_address      TEXT    NOT NULL DEFAULT '',
        sender_lat          DOUBLE PRECISION,
        sender_lng          DOUBLE PRECISION,
        destination_address TEXT    NOT NULL DEFAULT '',
        destination_lat     DOUBLE PRECISION,
        destination_lng     DOUBLE PRECISION,
        receiver_phone      TEXT    NOT NULL DEFAULT '',
        notes               TEXT    NOT NULL DEFAULT '',
        status              TEXT    NOT NULL DEFAULT 'submitted',
        submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivering_at       TIMESTAMPTZ,
        received_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT orders_status_check CHECK (status IN ('submitted', 'delivering', 'received'))
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_sender_user_id ON orders (sender_user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_receiver_user_id ON orders (receiver_user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_driver_user_id ON orders (driver_user_id);`);

    // ----------------------------------------------------------------------
    // Milestone 1 (updated scope): orders carry the H3 indexes of their
    // pickup and delivery coordinates, plus the basic package/shipping
    // metadata the signed-off order form collects. All additive so existing
    // installs keep working — older rows simply get NULL until recreated
    // (we backfill H3 from existing coordinates a few lines down).
    // ----------------------------------------------------------------------
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_h3 TEXT;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_h3 TEXT;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS h3_resolution INTEGER;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_name TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_contact TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_description TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(12, 3);`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dimensions TEXT NOT NULL DEFAULT '';`);
    // Milestone 5 — structured package dimensions for cost calculation.
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_weight_unit TEXT NOT NULL DEFAULT 'kg';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_length NUMERIC(12, 3);`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_width NUMERIC(12, 3);`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_height NUMERIC(12, 3);`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_dimension_unit TEXT NOT NULL DEFAULT 'cm';`);
    // Pricing engine — package classification + enforced unit defaults.
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_type TEXT;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_factor NUMERIC(10, 6);`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS packages JSONB;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_lbs NUMERIC(12, 3);`);
    // Backfill canonical lbs column from legacy weight_kg (values were already migrated to lb).
    await client.query(
      `UPDATE orders
         SET weight_lbs = CASE
           WHEN package_weight_unit = 'kg' AND weight_kg IS NOT NULL
             THEN ROUND(weight_kg * 2.20462, 3)
           ELSE weight_kg
         END
       WHERE weight_lbs IS NULL AND weight_kg IS NOT NULL;`
    );
    await client.query(
      `UPDATE orders SET weight_kg = weight_lbs WHERE weight_lbs IS NOT NULL AND (weight_kg IS NULL OR weight_kg <> weight_lbs);`
    );
    await client.query(
      `UPDATE orders SET package_type = 'medium', package_factor = 0.05
       WHERE package_type IS NULL;`
    );
    await client.query(
      `UPDATE orders
         SET packages = jsonb_build_array(
           jsonb_build_object(
             'package_type', package_type,
             'weight_lbs', COALESCE(weight_lbs, 1),
             'package_length', COALESCE(package_length, 1),
             'package_width', COALESCE(package_width, 1),
             'package_height', COALESCE(package_height, 1)
           )
         )
       WHERE packages IS NULL AND package_type IS NOT NULL;`
    );
    await client.query(
      `UPDATE orders
         SET packages = '[{"package_type":"medium","weight_lbs":1,"package_length":1,"package_width":1,"package_height":1}]'::jsonb
       WHERE packages IS NULL;`
    );
    await client.query(
      `UPDATE orders o
         SET packages = (
           SELECT jsonb_agg(
             pkg || jsonb_build_object(
               'weight_lbs', COALESCE((pkg->>'weight_lbs')::numeric, o.weight_lbs, 1),
               'package_length', COALESCE((pkg->>'package_length')::numeric, o.package_length, 1),
               'package_width', COALESCE((pkg->>'package_width')::numeric, o.package_width, 1),
               'package_height', COALESCE((pkg->>'package_height')::numeric, o.package_height, 1)
             )
           )
           FROM jsonb_array_elements(o.packages) AS pkg
         )
       WHERE EXISTS (
         SELECT 1
         FROM jsonb_array_elements(o.packages) AS pkg
         WHERE pkg->>'weight_lbs' IS NULL
            OR pkg->>'package_length' IS NULL
            OR pkg->>'package_width' IS NULL
            OR pkg->>'package_height' IS NULL
       );`
    );
    await client.query(
      `UPDATE orders SET package_weight_unit = 'lb' WHERE package_weight_unit IS NULL OR package_weight_unit = 'kg';`
    );
    await client.query(
      `UPDATE orders SET package_dimension_unit = 'in' WHERE package_dimension_unit IS NULL OR package_dimension_unit IN ('cm', 'm');`
    );
    await client.query(`ALTER TABLE orders ALTER COLUMN package_weight_unit SET DEFAULT 'lb';`);
    await client.query(`ALTER TABLE orders ALTER COLUMN package_dimension_unit SET DEFAULT 'in';`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_pickup_h3 ON orders (pickup_h3);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_delivery_h3 ON orders (delivery_h3);`);
    // Billing addresses are separate from pickup/delivery routing coordinates.
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_billing_address TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_billing_address TEXT NOT NULL DEFAULT '';`);

    // ----------------------------------------------------------------------
    // Milestone 2: zone overlap / adjacency graph.
    //
    // Each row represents one undirected connection between two driver zones
    // (zone_a_id < zone_b_id by convention to prevent A-B/B-A duplicates).
    // `connection_type` is "overlap" when the zones share H3 cells,
    // "adjacent" when they don't share cells but at least one cell pair
    // are direct neighbours. transfer_cells holds the shared H3 cells for
    // overlaps (or representative cells for adjacency).
    // adjacent_cell_pairs is the full list of touching boundary pairs.
    // ----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS zone_connections (
        id                   SERIAL PRIMARY KEY,
        zone_a_id            INTEGER NOT NULL REFERENCES driver_zones(id) ON DELETE CASCADE,
        zone_b_id            INTEGER NOT NULL REFERENCES driver_zones(id) ON DELETE CASCADE,
        transport_a_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        transport_b_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_type      TEXT    NOT NULL,
        transfer_cells       JSONB   NOT NULL DEFAULT '[]'::jsonb,
        adjacent_cell_pairs  JSONB,
        transport_method_a   TEXT,
        transport_method_b   TEXT,
        is_active            BOOLEAN NOT NULL DEFAULT TRUE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT zone_connections_no_self CHECK (zone_a_id <> zone_b_id),
        CONSTRAINT zone_connections_type_check CHECK (connection_type IN ('overlap', 'adjacent', 'hub')),
        CONSTRAINT zone_connections_unique UNIQUE (zone_a_id, zone_b_id)
      );
    `);
    // Air/sea handoffs are point-based: a land zone connects to an air/sea
    // zone at its departure or arrival hub. `hub_role_a` / `hub_role_b` record
    // which hub of that side anchors the connection (NULL for land zones).
    await client.query(`ALTER TABLE zone_connections ADD COLUMN IF NOT EXISTS hub_role_a TEXT;`);
    await client.query(`ALTER TABLE zone_connections ADD COLUMN IF NOT EXISTS hub_role_b TEXT;`);
    // Existing DBs were created with the 2-value check; widen it to allow 'hub'.
    await client.query(`ALTER TABLE zone_connections DROP CONSTRAINT IF EXISTS zone_connections_type_check;`);
    await client.query(
      `ALTER TABLE zone_connections ADD CONSTRAINT zone_connections_type_check CHECK (connection_type IN ('overlap', 'adjacent', 'hub'));`
    );
    // Milestone 2 (updated scope): one recommended transfer cell per
    // connection. Chosen from `transfer_cells` (overlap) or the adjacent
    // pairs (adjacency) using the midpoint-of-centroids rule in
    // zoneConnection.service.ts. Additive + nullable for existing rows;
    // the next recalculation fills it in.
    await client.query(`ALTER TABLE zone_connections ADD COLUMN IF NOT EXISTS recommended_transfer_cell TEXT;`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_zone_a ON zone_connections (zone_a_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_zone_b ON zone_connections (zone_b_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_transport_a ON zone_connections (transport_a_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_transport_b ON zone_connections (transport_b_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_is_active ON zone_connections (is_active);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_zc_type ON zone_connections (connection_type);`);

    // ----------------------------------------------------------------------
    // Milestone 5 — persisted order routes (from M4 chain enumeration) + cost.
    // ----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_routes (
        id               SERIAL PRIMARY KEY,
        order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        route_label      TEXT    NOT NULL,
        route_index      INTEGER NOT NULL,
        zone_ids         JSONB   NOT NULL DEFAULT '[]'::jsonb,
        connection_ids   JSONB   NOT NULL DEFAULT '[]'::jsonb,
        transporter_ids  JSONB   NOT NULL DEFAULT '[]'::jsonb,
        is_complete      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT order_routes_unique UNIQUE (order_id, route_index)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_routes_order_id ON order_routes (order_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transporter_rate_tables (
        id                    SERIAL PRIMARY KEY,
        transporter_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        transport_method      TEXT    NOT NULL,
        currency              TEXT    NOT NULL DEFAULT 'CAD',
        base_fee              NUMERIC(12, 2) NOT NULL DEFAULT 0,
        cost_per_h3_cell      NUMERIC(12, 4),
        cost_per_km           NUMERIC(12, 4),
        cost_per_kg           NUMERIC(12, 4),
        cost_per_volume_unit  NUMERIC(12, 6),
        time_of_day_factor    NUMERIC(8, 4),
        minimum_fee           NUMERIC(12, 2),
        is_active             BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT transporter_rate_tables_method_check
          CHECK (transport_method IN ('land', 'air', 'sea'))
      );
    `);
    await client.query(`ALTER TABLE transporter_rate_tables DROP CONSTRAINT IF EXISTS transporter_rate_tables_currency_check;`);
    await client.query(
      `ALTER TABLE transporter_rate_tables
         ADD CONSTRAINT transporter_rate_tables_currency_check CHECK (currency IN (${currencyList}));`
    );
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rate_tables_transporter ON transporter_rate_tables (transporter_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rate_tables_active ON transporter_rate_tables (is_active);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS route_segment_costs (
        id                    SERIAL PRIMARY KEY,
        route_id              INTEGER NOT NULL REFERENCES order_routes(id) ON DELETE CASCADE,
        segment_index         INTEGER NOT NULL DEFAULT 0,
        transporter_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        from_node_id          TEXT    NOT NULL,
        to_node_id            TEXT    NOT NULL,
        transport_method      TEXT    NOT NULL,
        package_weight        NUMERIC(12, 3),
        package_volume        NUMERIC(16, 3),
        distance_h3_cells     INTEGER,
        distance_km           NUMERIC(12, 3),
        base_fee              NUMERIC(12, 2),
        weight_cost           NUMERIC(12, 2),
        volume_cost           NUMERIC(12, 2),
        distance_cost         NUMERIC(12, 2),
        time_factor_amount    NUMERIC(12, 2),
        calculated_cost       NUMERIC(12, 2),
        manual_cost           NUMERIC(12, 2),
        final_cost            NUMERIC(12, 2),
        cost_status           TEXT    NOT NULL DEFAULT 'missing',
        currency              TEXT    NOT NULL DEFAULT 'CAD',
        calculation_breakdown JSONB,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT route_segment_costs_status_check
          CHECK (cost_status IN ('calculated', 'manual', 'missing', 'requested')),
        CONSTRAINT route_segment_costs_unique UNIQUE (route_id, segment_index)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_segment_costs_route ON route_segment_costs (route_id);`);
    await client.query(`ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS waiting_cost NUMERIC(12, 2);`);
    await client.query(`ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS booking_fee NUMERIC(12, 2);`);
    await client.query(`ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS package_factor NUMERIC(10, 6);`);
    await client.query(`ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS time_hours NUMERIC(10, 4);`);
    await client.query(`ALTER TABLE route_segment_costs DROP CONSTRAINT IF EXISTS route_segment_costs_status_check;`);
    await client.query(
      `ALTER TABLE route_segment_costs ADD CONSTRAINT route_segment_costs_status_check
         CHECK (cost_status IN ('calculated', 'manual', 'missing', 'requested'));`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS route_cost_summaries (
        id                    SERIAL PRIMARY KEY,
        route_id              INTEGER NOT NULL REFERENCES order_routes(id) ON DELETE CASCADE,
        order_id              INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        total_calculated_cost NUMERIC(12, 2),
        total_manual_cost     NUMERIC(12, 2),
        total_final_cost      NUMERIC(12, 2),
        missing_segment_count INTEGER NOT NULL DEFAULT 0,
        currency              TEXT    NOT NULL DEFAULT 'CAD',
        status                TEXT    NOT NULL DEFAULT 'missing',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT route_cost_summaries_status_check
          CHECK (status IN ('complete', 'partial', 'missing')),
        CONSTRAINT route_cost_summaries_unique UNIQUE (route_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_cost_summaries_order ON route_cost_summaries (order_id);`);

    // Pricing engine — system-wide settings (booking fee, etc.).
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(
      `INSERT INTO system_settings (key, value)
       VALUES ('booking_fee_rate', '0.02')
       ON CONFLICT (key) DO NOTHING;`
    );
    await client.query(
      `INSERT INTO system_settings (key, value)
       VALUES ('land_speed_kmh', '50')
       ON CONFLICT (key) DO NOTHING;`
    );
    await client.query(
      `INSERT INTO system_settings (key, value)
       VALUES ('pff_factor', '0')
       ON CONFLICT (key) DO NOTHING;`
    );

    await client.query(`ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS cost_source TEXT;`);
    await client.query(`ALTER TABLE route_cost_summaries ADD COLUMN IF NOT EXISTS requested_segment_count INTEGER NOT NULL DEFAULT 0;`);

    // Regional pricing defaults — admin-managed rates (e.g. minimum wage per region).
    await client.query(`
      CREATE TABLE IF NOT EXISTS pricing_regions (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        base_fee        NUMERIC(12, 2),
        cost_per_km     NUMERIC(12, 4),
        cost_per_hour   NUMERIC(12, 4),
        currency        TEXT NOT NULL DEFAULT 'CAD',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE pricing_regions DROP CONSTRAINT IF EXISTS pricing_regions_currency_check;`);
    await client.query(
      `ALTER TABLE pricing_regions
         ADD CONSTRAINT pricing_regions_currency_check CHECK (currency IN (${currencyList}));`
    );

    await client.query(
      `ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'system';`
    );
    await client.query(
      `ALTER TABLE driver_zones ADD COLUMN IF NOT EXISTS pricing_region_id INTEGER REFERENCES pricing_regions(id) ON DELETE SET NULL;`
    );
    await client.query(`ALTER TABLE driver_zones DROP CONSTRAINT IF EXISTS driver_zones_pricing_mode_check;`);
    await client.query(
      `ALTER TABLE driver_zones
         ADD CONSTRAINT driver_zones_pricing_mode_check CHECK (pricing_mode IN ('system', 'manual'));`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_driver_zones_pricing_region ON driver_zones (pricing_region_id);`
    );

    await client.query(
      `INSERT INTO pricing_regions (name, base_fee, cost_per_km, cost_per_hour, currency)
       VALUES
         ('Ontario', 15, 1.25, 22, 'CAD'),
         ('British Columbia', 15, 1.35, 24, 'CAD'),
         ('Alberta', 15, 1.20, 21, 'CAD'),
         ('Quebec', 15, 1.30, 21.5, 'CAD')
       ON CONFLICT (name) DO NOTHING;`
    );

    // ----------------------------------------------------------------------
    // Milestone 6 — route selection & segment confirmation.
    // ----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS route_selections (
        id                  SERIAL PRIMARY KEY,
        order_id            INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        selected_route_id   INTEGER NOT NULL REFERENCES order_routes(id) ON DELETE CASCADE,
        selected_by_user_id INTEGER NOT NULL REFERENCES users(id),
        status              TEXT    NOT NULL DEFAULT 'pending',
        payment_status      TEXT    NOT NULL DEFAULT 'pending',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT route_selections_order_unique UNIQUE (order_id),
        CONSTRAINT route_selections_status_check
          CHECK (status IN ('pending', 'confirmed', 'rejected', 'partially_confirmed')),
        CONSTRAINT route_selections_payment_status_check
          CHECK (payment_status IN ('pending', 'ready', 'not_required'))
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_selections_order ON route_selections (order_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_selections_route ON route_selections (selected_route_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS segment_confirmations (
        id               SERIAL PRIMARY KEY,
        route_id         INTEGER NOT NULL REFERENCES order_routes(id) ON DELETE CASCADE,
        segment_id       INTEGER NOT NULL REFERENCES route_segment_costs(id) ON DELETE CASCADE,
        transporter_id   INTEGER NOT NULL REFERENCES users(id),
        status           TEXT    NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        confirmed_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT segment_confirmations_segment_unique UNIQUE (segment_id),
        CONSTRAINT segment_confirmations_status_check
          CHECK (status IN ('pending', 'accepted', 'rejected'))
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_segment_confirmations_route ON segment_confirmations (route_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_segment_confirmations_transporter ON segment_confirmations (transporter_id);`);
    await client.query(
      `ALTER TABLE segment_confirmations ADD COLUMN IF NOT EXISTS leg_status TEXT NOT NULL DEFAULT 'not_started';`
    );
    await client.query(
      `ALTER TABLE segment_confirmations DROP CONSTRAINT IF EXISTS segment_confirmations_leg_status_check;`
    );
    await client.query(
      `ALTER TABLE segment_confirmations ADD CONSTRAINT segment_confirmations_leg_status_check
         CHECK (leg_status IN ('not_started', 'picked_up', 'in_transit'));`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS route_confirmation_requests (
        id             SERIAL PRIMARY KEY,
        route_id       INTEGER NOT NULL REFERENCES order_routes(id) ON DELETE CASCADE,
        transporter_id INTEGER NOT NULL REFERENCES users(id),
        segment_id     INTEGER NOT NULL REFERENCES route_segment_costs(id) ON DELETE CASCADE,
        status         TEXT    NOT NULL DEFAULT 'sent',
        sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        responded_at   TIMESTAMPTZ,
        CONSTRAINT route_confirmation_requests_segment_unique UNIQUE (segment_id),
        CONSTRAINT route_confirmation_requests_status_check
          CHECK (status IN ('sent', 'accepted', 'rejected', 'expired'))
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_confirmation_requests_route ON route_confirmation_requests (route_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_confirmation_requests_transporter ON route_confirmation_requests (transporter_id);`);

    // ----------------------------------------------------------------------
    // Milestone 7 — order tracking status + history.
    // ----------------------------------------------------------------------
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'CONFIRMED';`);
    await client.query(`ALTER TABLE orders ALTER COLUMN tracking_status SET DEFAULT 'CONFIRMED';`);
    await client.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_tracking_status_check;`);
    await client.query(
      `ALTER TABLE orders ADD CONSTRAINT orders_tracking_status_check
         CHECK (tracking_status IN (
           'AWAITING_CONNECT', 'REJECTED', 'CONFIRMED', 'PICKUP_AVAILABLE',
           'PICKED_UP', 'IN_TRANSIT', 'PAYMENT_DELIVERED', 'DELIVERED'
         ));`
    );
    await client.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_schedule_at TIMESTAMPTZ;`
    );
    // Reset rows that inherited the old PICKUP_AVAILABLE default before pick ready / delivery.
    await client.query(
      `UPDATE orders
       SET tracking_status = 'CONFIRMED'
       WHERE pickup_ready_at IS NULL
         AND tracking_status NOT IN ('CONFIRMED', 'DELIVERED')`
    );
    await client.query(
      `UPDATE orders
       SET status = 'received',
           received_at = COALESCE(received_at, updated_at, NOW())
       WHERE tracking_status = 'DELIVERED' AND status <> 'received'`
    );
    await client.query(
      `UPDATE orders
       SET status = 'delivering',
           delivering_at = COALESCE(delivering_at, updated_at, NOW())
       WHERE tracking_status IN ('PICKUP_AVAILABLE', 'PICKED_UP', 'IN_TRANSIT', 'PAYMENT_DELIVERED')
         AND status = 'submitted'`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_status_history (
        id         SERIAL PRIMARY KEY,
        order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status     TEXT    NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history (order_id);`);
    await client.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_ready_at TIMESTAMPTZ;`
    );
    await client.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS goods_ready_at TIMESTAMPTZ;`
    );
    await client.query(
      `ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS leg_phase TEXT;`
    );
    await client.query(
      `ALTER TABLE route_segment_costs DROP CONSTRAINT IF EXISTS route_segment_costs_leg_phase_check;`
    );
    await client.query(
      `ALTER TABLE route_segment_costs ADD CONSTRAINT route_segment_costs_leg_phase_check
         CHECK (leg_phase IS NULL OR leg_phase IN ('payment', 'goods'));`
    );
    await client.query(
      `ALTER TABLE route_segment_costs ADD COLUMN IF NOT EXISTS handoff_role TEXT;`
    );
    await client.query(
      `ALTER TABLE route_segment_costs DROP CONSTRAINT IF EXISTS route_segment_costs_handoff_role_check;`
    );
    await client.query(
      `ALTER TABLE route_segment_costs ADD CONSTRAINT route_segment_costs_handoff_role_check
         CHECK (handoff_role IS NULL OR handoff_role IN ('payment_delivery', 'goods_pickup'));`
    );
    await client.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_packages JSONB NOT NULL DEFAULT '[]'::jsonb;`
    );
    await client.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_pickup_notified_at TIMESTAMPTZ;`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        order_id   INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        read_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
       ON user_notifications (user_id, created_at DESC);`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
       ON user_notifications (user_id) WHERE read_at IS NULL;`
    );

    console.log("[db] schema ready");
  } finally {
    client.release();
  }
}
