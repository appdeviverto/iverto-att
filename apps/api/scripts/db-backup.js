// Usage on the server (apps/api): set -a; . ./.env; set +a; node scripts/db-backup.js ~/deploy-backups/<ts>/database
// Production backup + pre-deploy snapshot, run on the server from apps/api (uses its `pg`).
// One REPEATABLE READ, READ ONLY transaction: every table as JSON (json_agg; restore with
// INSERT … SELECT * FROM json_populate_recordset(NULL::public.<t>, <file>)), plus per-table
// row count and md5 of every row's text over the columns that exist now. Prints no secrets.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = process.argv[2];
(async () => {
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();
  await c.query("SET TimeZone = 'UTC'");
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: tables } = await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
  const snapshot = { takenAt: new Date().toISOString(), tables: {} };
  for (const { tablename: t } of tables) {
    const { rows: cols } = await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
      [t],
    );
    const list = cols.map((x) => `"${x.column_name}"`).join(', ');
    const { rows: [r] } = await c.query(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h, coalesce(json_agg(x), '[]')::text AS j FROM (SELECT ${list} FROM public."${t}") x`,
    );
    fs.writeFileSync(path.join(dir, 'db', `${t}.json.gz`), zlib.gzipSync(r.j));
    snapshot.tables[t] = { columns: cols.map((x) => x.column_name), count: r.n, md5: r.h };
  }
  const { rows: migrations } = await c.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at');
  snapshot.migrations = migrations.map((m) => m.migration_name);
  await c.query('COMMIT');
  await c.end();
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
  const total = Object.values(snapshot.tables).reduce((s, x) => s + x.count, 0);
  console.log(`backup ok: ${tables.length} tables, ${total} rows, last migration ${snapshot.migrations.at(-1)}`);
  for (const [t, x] of Object.entries(snapshot.tables)) if (x.count) console.log(`  ${t}: ${x.count}`);
})().catch((e) => {
  console.error('BACKUP FAILED:', e.message);
  process.exit(1);
});
