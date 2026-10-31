/**
 * Applies prisma/post-init/*.sql in order after `prisma migrate deploy`.
 * Every file is idempotent, so this runs on every deploy.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  const dir = join(__dirname, '..', 'prisma', 'post-init');
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      process.stdout.write(`post-init ${file} … `);
      await client.query(readFileSync(join(dir, file), 'utf8'));
      console.log('ok');
    }
    // The Supabase advisor's "table publicly accessible" check, run on every deploy (006).
    const { rows } = await client.query(`
      SELECT c.relname || ' has no row-level security' AS problem FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      UNION ALL
      SELECT r.rolname || ' can still use schema public' FROM pg_roles r
       WHERE r.rolname IN ('anon', 'authenticated') AND has_schema_privilege(r.oid, 'public', 'USAGE')`);
    if (rows.length) throw new Error(`Public schema not locked down:\n${rows.map((r) => `  ${r.problem}`).join('\n')}`);
    console.log('lockdown verified');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
