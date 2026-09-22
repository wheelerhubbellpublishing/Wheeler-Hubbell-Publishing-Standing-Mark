import {migrateDatabase} from './database.mjs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const databaseUrl = required('CARRIER_MIGRATION_DATABASE_URL');
  const runtimeRole = required('CARRIER_RUNTIME_ROLE');
  const runtimeUrl = required('CARRIER_DATABASE_URL');
  const migrationIdentity = decodeURIComponent(new URL(databaseUrl).username);
  const runtimeIdentity = decodeURIComponent(new URL(runtimeUrl).username);
  if (!migrationIdentity || !runtimeIdentity) throw new Error('database URLs must contain role names');
  if (migrationIdentity === runtimeIdentity || runtimeIdentity !== runtimeRole) {
    throw new Error('migration owner and restricted runtime role must be distinct and CARRIER_RUNTIME_ROLE must match CARRIER_DATABASE_URL');
  }
  await migrateDatabase({databaseUrl, runtimeRole});
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    event: 'carrier_database_migrated',
    schema: 'carrier_automation',
    runtime_role: runtimeRole,
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    time: new Date().toISOString(),
    event: 'carrier_migration_failed',
    error: String(error?.message ?? error).slice(0, 500),
  })}\n`);
  process.exitCode = 1;
});

