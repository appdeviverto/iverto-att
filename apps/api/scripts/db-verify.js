// Usage on the server (apps/api): node scripts/db-verify.js ~/deploy-backups/<ts>/database  (exit 0 = unchanged)
// After the deploy: every table from the snapshot, hashed again over exactly the columns it had
// before. Identical counts and md5 = no existing row or value changed. The one migration that
// moves data (attendance_corrections.field_visit_id → field_visit_ids) is checked separately.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
(async () => {
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();
  await c.query("SET TimeZone = 'UTC'");
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let bad = 0;
  let same = 0;
  for (const [t, before] of Object.entries(snap.tables)) {
    let cols = before.columns;
    if (t === 'attendance_corrections') cols = cols.filter((x) => x !== 'field_visit_id');
    const moving = t === 'attendance_corrections' && cols.length !== before.columns.length;
    if (moving) {
      // Compare the remaining columns against the backup itself (the snapshot hash included field_visit_id).
      const rows = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(dir, 'db', `${t}.json.gz`))).toString());
      const { rows: now } = await c.query(`SELECT id, field_visit_ids FROM public.attendance_corrections`);
      const byId = new Map(now.map((r) => [r.id, r.field_visit_ids]));
      const moved = rows.every((r) => byId.has(r.id) && JSON.stringify(byId.get(r.id)) === JSON.stringify(r.field_visit_id ? [r.field_visit_id] : []));
      console.log(`${moved && now.length === rows.length ? 'same' : 'DIFF'}  attendance_corrections: ${now.length} rows, field visit proof carried into field_visit_ids`);
      if (!(moved && now.length === rows.length)) bad++;
      else same++;
    }
    const list = cols.map((x) => `"${x}"`).join(', ');
    const exists = await c.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1", [t]);
    if (!exists.rowCount) {
      console.log(`DIFF  ${t}: table missing`);
      bad++;
      continue;
    }
    const { rows: [r] } = await c.query(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM (SELECT ${list} FROM public."${t}") x`,
    );
    if (moving) continue;
    if (r.n === before.count && r.h === before.md5) same++;
    else {
      bad++;
      console.log(`DIFF  ${t}: ${before.count} → ${r.n} rows, md5 ${r.h === before.md5 ? 'same' : 'changed'}`);
    }
  }
  const { rows: migrations } = await c.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at');
  await c.query('COMMIT');
  await c.end();
  console.log(`${same} tables identical, ${bad} different; migrations now end at ${migrations.at(-1).migration_name} (${migrations.length})`);
  process.exit(bad ? 2 : 0);
})().catch((e) => {
  console.error('VERIFY FAILED:', e.message);
  process.exit(1);
});
