# Migration scripts

One-shot tooling for the **speedcdnjs → KV-backed worker-api migration**.

Everything in this directory is transitional. It exists to verify the new
worker returns the same data as the legacy `metadata.speedcdnjs.com` origin,
and should be deleted once the migration is complete and the shadow-comparison
D1 is no longer needed.

## Contents

- **`create-d1.sh`** — Provisions the per-env D1 database that backs the
  shadow-comparison drift table (see `src/shadow.js` and
  `migrations/0001_shadow_mismatches.sql`). Two-phase: `create` prints a
  `database_id` you paste into `worker-api-cdnjs-account-wrangler.toml`, then
  `migrate` applies the schema remotely.

  ```bash
  ./scripts/migration/create-d1.sh staging create
  # paste database_id into worker-api-cdnjs-account-wrangler.toml
  ./scripts/migration/create-d1.sh staging migrate
  ```

## Post-migration cleanup

When the migration is complete:

1. Drop `SHADOW_DB`, `SHADOW_ORIGIN`, `SHADOW_SAMPLE_RATE` from
   `worker-api-cdnjs-account-wrangler.toml`.
2. Delete `src/shadow.js` and the `shadowCompare` call in `src/index.js`.
3. Delete the D1 databases:
   `npx wrangler d1 delete cdnjs-shadow-mismatches-{staging,production}`.
4. Delete this directory.
