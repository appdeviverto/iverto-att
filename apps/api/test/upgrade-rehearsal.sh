#!/bin/bash
# Upgrade rehearsal: proves a deploy leaves every existing row and column unchanged.
# Builds a throwaway DB at production's schema, fills it with the local stack's data (run
# `node test/restart-stack.mjs && node test/seed-demo.mjs` first), hashes every table, applies
# exactly the deploy steps (prisma migrate deploy + scripts/post-init.ts, twice), hashes again.
#
#   bash test/upgrade-rehearsal.sh <last migration applied in production> [git ref of the production deploy]
#   e.g. bash test/upgrade-rehearsal.sh 20261105000000_leave_policy_engine b9dd7c5
#
# Production's last migration: SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1.
# The database owner mimics Supabase's postgres role (BYPASSRLS, not superuser). LOCAL ONLY.
set -euo pipefail
PROD_MIGRATION=${1:?usage: upgrade-rehearsal.sh <last production migration> [git ref]}
PROD_REF=${2:-HEAD}
API=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; mkdir -p "$T/old/prisma/migrations" "$T/old/post-init"
SU() { docker exec -i att-pg psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
RH() { SU -d rehearsal "$@"; }

echo '== fresh rehearsal DB, owner like Supabase postgres (BYPASSRLS, not superuser)'
SU -c "DROP DATABASE IF EXISTS rehearsal WITH (FORCE)"
SU -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rh_owner') THEN CREATE ROLE rh_owner LOGIN BYPASSRLS PASSWORD 'rh'; END IF; END \$\$"
SU -c "CREATE DATABASE rehearsal OWNER rh_owner"
RH -c "ALTER SCHEMA public OWNER TO rh_owner; GRANT ALL ON SCHEMA public TO rh_owner"
RH -c "CREATE EXTENSION IF NOT EXISTS btree_gist"
URL='postgresql://rh_owner:rh@localhost:55432/rehearsal'

echo "== production state: migrations through $PROD_MIGRATION + post-init from $PROD_REF"
cd "$API"
git show "$PROD_REF:apps/api/prisma/schema.prisma" > "$T/old/prisma/schema.prisma"
for m in prisma/migrations/2*/; do
  m=$(basename "$m"); [[ "$m" > "$PROD_MIGRATION" ]] || cp -r "prisma/migrations/$m" "$T/old/prisma/migrations/"
done
[ -d "$T/old/prisma/migrations/$PROD_MIGRATION" ] || { echo "no migration $PROD_MIGRATION"; exit 1; }
cp prisma/migrations/migration_lock.toml "$T/old/prisma/migrations/"
for f in $(git ls-tree --name-only --full-name "$PROD_REF" prisma/post-init/ | grep '\.sql$'); do git show "$PROD_REF:$f" > "$T/old/post-init/$(basename "$f")"; done
DATABASE_URL=$URL DIRECT_URL=$URL npx prisma migrate deploy --schema "$(cygpath -w "$T/old/prisma/schema.prisma")" 2>&1 | grep -E "applied|Error|error" || true
for f in "$T"/old/post-init/*.sql; do docker exec -i att-pg psql "postgresql://rh_owner:rh@localhost:5432/rehearsal" -v ON_ERROR_STOP=1 -q < "$f"; done

echo '== copy local e2e data into the production-shaped tables'
RH -At -F'|' -c "SELECT table_name, string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname='public') AND table_name <> '_prisma_migrations' GROUP BY 1 ORDER BY 1" > "$T/cols-old.txt"
SU -d postgres -At -F'|' -c "SELECT table_name, string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' GROUP BY 1" > "$T/cols-src.txt"
while IFS="|" read -r t cols <&3; do
  src=$(grep "^$t|" "$T/cols-src.txt" | cut -d'|' -f2 || true)
  [ -z "$src" ] && continue
  common=$(comm -12 <(tr ',' '\n' <<<"$cols" | sort) <(tr ',' '\n' <<<"$src" | sort) | paste -sd,)
  SU -d postgres -c "\\copy (SELECT $common FROM $t) TO STDOUT" | RH -c "SET session_replication_role = replica" -c "\\copy $t($common) FROM STDIN"
done 3< "$T/cols-old.txt"
# Exercise the one data-moving migration (corrections' single field visit -> array).
RH -c "SET session_replication_role = replica; UPDATE attendance_corrections c SET field_visit_id = (SELECT id FROM field_visits f WHERE f.tenant_id = c.tenant_id LIMIT 1) WHERE id IN (SELECT id FROM attendance_corrections ORDER BY id LIMIT 3)"

snapshot() { # $1 = output file; hashes every production-era column of every production-era table
  while IFS="|" read -r t cols <&3; do
    c=$cols; [ "$t" = attendance_corrections ] && c=$(sed 's/,field_visit_id//' <<<"$cols")
    RH -At -c "SET TimeZone='UTC'; SELECT '$t', count(*), md5(coalesce(string_agg(r::text, E'\n' ORDER BY r::text), '')) FROM (SELECT $c FROM $t) r"
  done 3< "$T/cols-old.txt" > "$1"
}
snapshot "$T/before.txt"; [ "$(wc -l < "$T/before.txt")" -ge 25 ] || { echo "SNAPSHOT TOO SMALL"; exit 1; }
RH -At -c "SELECT id || '=' || coalesce(field_visit_id, '') FROM attendance_corrections WHERE field_visit_id IS NOT NULL ORDER BY id" > "$T/fv-before.txt"
echo "rows: $(awk -F'|' '{s+=$2} END {print s}' "$T/before.txt") across $(wc -l < "$T/before.txt") tables; corrections with a field visit: $(wc -l < "$T/fv-before.txt")"

echo '== upgrade: every pending migration + current post-init (exactly the deploy steps)'
DATABASE_URL=$URL DIRECT_URL=$URL npx prisma migrate deploy 2>&1 | grep -E "applied|Error|error|migrations" || true
DATABASE_URL=$URL DIRECT_URL=$URL npx ts-node --transpile-only scripts/post-init.ts
echo '== second post-init run (every deploy reruns it)'
DATABASE_URL=$URL DIRECT_URL=$URL npx ts-node --transpile-only scripts/post-init.ts | tail -1

snapshot "$T/after.txt"
RH -At -c "SELECT id || '=' || coalesce(field_visit_ids[1], '') FROM attendance_corrections WHERE cardinality(field_visit_ids) > 0 ORDER BY id" > "$T/fv-after.txt"
echo '== compare'
if diff "$T/before.txt" "$T/after.txt" && diff "$T/fv-before.txt" "$T/fv-after.txt"; then echo 'IDENTICAL: every pre-existing row and column unchanged; field visit proof carried over'; else echo 'DIFFERENCES FOUND'; exit 1; fi
