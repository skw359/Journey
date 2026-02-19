const crypto = require('crypto');
const { Pool } = require('pg');

let _pool = new Pool({ connectionString: process.env.DATABASE_URL });

const pool = new Proxy({}, {
  get(_, prop) {
    return typeof _pool[prop] === 'function' ? _pool[prop].bind(_pool) : _pool[prop];
  }
});

const ensuredTenantSchemas = new Set();

const ROUTE_COLUMNS = [
  'id',
  'name',
  'date',
  'distance',
  'duration',
  'top_speed',
  'avg_speed',
  'top_elevation',
  'lowest_elevation',
  'avg_elevation',
  'start_time',
  'end_time',
  'coordinates',
  'elevation_gain',
  'elevation_loss',
  'start_lat',
  'start_lon',
  'end_lat',
  'end_lon',
  'source',
  'watch_recorded',
  'profile_time_ms',
  'profile_dist_mi',
  'profile_elev_m',
  'profile_speed_mph',
  'travel_mode',
];

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tenantSchemaForUser(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('A valid userId is required for tenant access');
  }
  const digest = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return `tenant_${digest}`;
}

async function createTenantTables(dbClient, schema) {
  const qSchema = quoteIdent(schema);
  await dbClient.query(`
    CREATE SCHEMA IF NOT EXISTS ${qSchema};

    CREATE TABLE IF NOT EXISTS ${qSchema}.routes (
      id TEXT PRIMARY KEY,
      name TEXT,
      date TEXT,
      distance DOUBLE PRECISION,
      duration TEXT,
      top_speed DOUBLE PRECISION,
      avg_speed DOUBLE PRECISION,
      top_elevation DOUBLE PRECISION,
      lowest_elevation DOUBLE PRECISION,
      avg_elevation DOUBLE PRECISION,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      coordinates JSONB,
      elevation_gain DOUBLE PRECISION,
      elevation_loss DOUBLE PRECISION,
      start_lat DOUBLE PRECISION,
      start_lon DOUBLE PRECISION,
      end_lat DOUBLE PRECISION,
      end_lon DOUBLE PRECISION,
      source TEXT,
      watch_recorded BOOLEAN,
      profile_time_ms JSONB,
      profile_dist_mi JSONB,
      profile_elev_m JSONB,
      profile_speed_mph JSONB,
      travel_mode TEXT
    );

    CREATE TABLE IF NOT EXISTS ${qSchema}.waypoints (
      id TEXT PRIMARY KEY,
      route_id TEXT REFERENCES ${qSchema}.routes(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      elevation DOUBLE PRECISION,
      "timestamp" BIGINT,
      note TEXT,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS ${qSchema}.photos (
      id TEXT PRIMARY KEY,
      route_id TEXT REFERENCES ${qSchema}.routes(id) ON DELETE CASCADE,
      filename TEXT,
      original_name TEXT,
      mimetype TEXT,
      size INTEGER,
      uploaded_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${schema}_idx_routes_start_time`)}
      ON ${qSchema}.routes(start_time DESC);
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${schema}_idx_routes_distance`)}
      ON ${qSchema}.routes(distance);
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${schema}_idx_waypoints_route_id`)}
      ON ${qSchema}.waypoints(route_id);
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${schema}_idx_photos_route_id`)}
      ON ${qSchema}.photos(route_id);
  `);
}

async function ensureTenantSchema(userId, dbClient = pool) {
  const schema = tenantSchemaForUser(userId);
  if (dbClient === pool && ensuredTenantSchemas.has(schema)) {
    return schema;
  }

  await createTenantTables(dbClient, schema);
  if (dbClient === pool) {
    ensuredTenantSchemas.add(schema);
  }
  return schema;
}

async function withTenantClient(userId, callback) {
  const schema = await ensureTenantSchema(userId);
  const client = await pool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['search_path', `${schema},public`]);
    return await callback(client);
  } finally {
    try {
      await client.query('RESET search_path');
    } catch {
      // Ignore reset failures; connection will be recycled by pool.
    }
    client.release();
  }
}

async function queryTenant(userId, text, params = []) {
  return withTenantClient(userId, (client) => client.query(text, params));
}

function buildLegacyRouteFilter(includeUnassigned) {
  return includeUnassigned
    ? '(r.user_id = $1 OR r.user_id IS NULL)'
    : 'r.user_id = $1';
}

async function migrateLegacyDataForUser(userId, options = {}) {
  const includeUnassigned = options.includeUnassigned === true;
  const purgeLegacy = options.purgeLegacy === true;
  const schema = tenantSchemaForUser(userId);
  const qSchema = quoteIdent(schema);
  const legacyRouteFilter = buildLegacyRouteFilter(includeUnassigned);
  const routeColumnList = ROUTE_COLUMNS.join(', ');
  const routeColumnSelect = ROUTE_COLUMNS.map((column) => `r.${column}`).join(', ');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureTenantSchema(userId, client);

    const insertedRoutes = await client.query(`
      INSERT INTO ${qSchema}.routes (${routeColumnList})
      SELECT ${routeColumnSelect}
      FROM public.routes r
      WHERE ${legacyRouteFilter}
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `, [userId]);

    await client.query(`
      INSERT INTO ${qSchema}.waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
      SELECT w.id, w.route_id, w.lat, w.lon, w.elevation, w."timestamp", w.note, w.label
      FROM public.waypoints w
      JOIN public.routes r ON r.id = w.route_id
      WHERE ${legacyRouteFilter}
      ON CONFLICT (id) DO NOTHING
    `, [userId]);

    await client.query(`
      INSERT INTO ${qSchema}.photos (id, route_id, filename, original_name, mimetype, size, uploaded_at)
      SELECT p.id, p.route_id, p.filename, p.original_name, p.mimetype, p.size, p.uploaded_at
      FROM public.photos p
      JOIN public.routes r ON r.id = p.route_id
      WHERE ${legacyRouteFilter}
      ON CONFLICT (id) DO NOTHING
    `, [userId]);

    let purgedRoutes = 0;
    if (purgeLegacy) {
      const purgeResult = await client.query(`
        DELETE FROM public.routes r
        WHERE ${legacyRouteFilter}
        RETURNING r.id
      `, [userId]);
      purgedRoutes = purgeResult.rowCount;
    }

    await client.query('COMMIT');
    ensuredTenantSchemas.add(schema);

    return {
      migratedRoutes: insertedRoutes.rowCount,
      purgedRoutes,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reconnect(connStr) {
  await _pool.end();
  _pool = new Pool({ connectionString: connStr });
  ensuredTenantSchemas.clear();
  await initSchema();
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      first_name TEXT,
      last_name TEXT,
      avatar_filename TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Legacy shared tables kept for backwards-compatible migration.
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      name TEXT,
      date TEXT,
      distance DOUBLE PRECISION,
      duration TEXT,
      top_speed DOUBLE PRECISION,
      avg_speed DOUBLE PRECISION,
      top_elevation DOUBLE PRECISION,
      lowest_elevation DOUBLE PRECISION,
      avg_elevation DOUBLE PRECISION,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      coordinates JSONB,
      elevation_gain DOUBLE PRECISION,
      elevation_loss DOUBLE PRECISION,
      start_lat DOUBLE PRECISION,
      start_lon DOUBLE PRECISION,
      end_lat DOUBLE PRECISION,
      end_lon DOUBLE PRECISION,
      source TEXT,
      watch_recorded BOOLEAN,
      profile_time_ms JSONB,
      profile_dist_mi JSONB,
      profile_elev_m JSONB,
      profile_speed_mph JSONB,
      travel_mode TEXT,
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS waypoints (
      id TEXT PRIMARY KEY,
      route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      elevation DOUBLE PRECISION,
      "timestamp" BIGINT,
      note TEXT,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
      filename TEXT,
      original_name TEXT,
      mimetype TEXT,
      size INTEGER,
      uploaded_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_routes_start_time ON routes(start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_routes_distance ON routes(distance);
    CREATE INDEX IF NOT EXISTS idx_waypoints_route_id ON waypoints(route_id);
    CREATE INDEX IF NOT EXISTS idx_photos_route_id ON photos(route_id);
    CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
    CREATE INDEX IF NOT EXISTS idx_pairing_tokens_token ON pairing_tokens(token);
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'routes' AND column_name = 'user_id'
      ) THEN
        ALTER TABLE routes ADD COLUMN user_id TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'routes_user_id_fkey' AND conrelid = 'routes'::regclass
      ) THEN
        ALTER TABLE routes
        ADD CONSTRAINT routes_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'first_name'
      ) THEN
        ALTER TABLE users ADD COLUMN first_name TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'last_name'
      ) THEN
        ALTER TABLE users ADD COLUMN last_name TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'avatar_filename'
      ) THEN
        ALTER TABLE users ADD COLUMN avatar_filename TEXT;
      END IF;
    END $$;
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_routes_user_id ON routes(user_id)');

  const { rows: users } = await pool.query('SELECT id FROM users');
  for (const user of users) {
    await ensureTenantSchema(user.id);
    await migrateLegacyDataForUser(user.id, { includeUnassigned: false, purgeLegacy: true });
  }
}

function toApiRoute(row, waypoints, photos) {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    distance: row.distance != null ? Number(row.distance).toFixed(2) : null,
    duration: row.duration,
    topSpeed: row.top_speed != null ? Number(row.top_speed).toFixed(2) : null,
    avgSpeed: row.avg_speed != null ? Number(row.avg_speed).toFixed(2) : null,
    topElevation: row.top_elevation != null ? Number(row.top_elevation).toFixed(2) : null,
    lowestElevation: row.lowest_elevation != null ? Number(row.lowest_elevation).toFixed(2) : null,
    avgElevation: row.avg_elevation != null ? Number(row.avg_elevation).toFixed(2) : null,
    startTime: row.start_time ? row.start_time.toISOString() : null,
    endTime: row.end_time ? row.end_time.toISOString() : null,
    coordinates: row.coordinates || [],
    elevationGain: row.elevation_gain != null ? Number(row.elevation_gain) : null,
    elevationLoss: row.elevation_loss != null ? Number(row.elevation_loss) : null,
    startCoord: (row.start_lat != null && row.start_lon != null) ? [row.start_lat, row.start_lon] : null,
    endCoord: (row.end_lat != null && row.end_lon != null) ? [row.end_lat, row.end_lon] : null,
    source: row.source,
    watchRecorded: !!row.watch_recorded,
    profileTimeMs: row.profile_time_ms || [],
    profileDistMi: row.profile_dist_mi || [],
    profileElevM: row.profile_elev_m || [],
    profileSpeedMph: row.profile_speed_mph || [],
    waypoints: (waypoints || []).map(toApiWaypoint),
    photos: (photos || []).map(toApiPhoto),
    travelMode: row.travel_mode || null,
  };
}

function toApiSummary(row) {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    startTime: row.start_time ? row.start_time.toISOString() : null,
    endTime: row.end_time ? row.end_time.toISOString() : null,
    distance: row.distance != null ? Number(row.distance).toFixed(2) : null,
    duration: row.duration,
    watchRecorded: !!row.watch_recorded,
    waypointCount: Number(row.waypoint_count) || 0,
    photoCount: Number(row.photo_count) || 0,
    travelMode: row.travel_mode || null,
    avgSpeed: row.avg_speed != null ? Number(row.avg_speed).toFixed(2) : null,
  };
}

function toApiWaypoint(row) {
  return {
    id: row.id,
    lat: row.lat,
    lon: row.lon,
    timestamp: row.timestamp != null ? Number(row.timestamp) : null,
    note: row.note || '',
    elevation: row.elevation != null ? Number(row.elevation) : null,
    label: row.label || undefined,
  };
}

function toApiPhoto(row) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    size: row.size,
    uploadedAt: row.uploaded_at ? row.uploaded_at.toISOString() : null,
    mimetype: row.mimetype,
  };
}

module.exports = {
  pool,
  initSchema,
  reconnect,
  toApiRoute,
  toApiSummary,
  toApiWaypoint,
  toApiPhoto,
  tenantSchemaForUser,
  ensureTenantSchema,
  withTenantClient,
  queryTenant,
  migrateLegacyDataForUser,
};
