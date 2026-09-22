import { Client, Pool } from "pg";
import { createPostgresStore } from "./autonomous-market/src/store.mjs";
import { migrateDatabase as migrateCarrierDatabase } from "./carrier-daemon/src/database.mjs";
import { SettlementStore } from "./settlement-observer/src/store.mjs";

const DATABASE_NAME = "whp_automation";
const ROLES = Object.freeze([
  { role: "whp_market", schema: "whp_market", passwordName: "WHP_MARKET_DB_PASSWORD", connections: 2 },
  { role: "whp_market_worker", schema: "whp_market", passwordName: "WHP_MARKET_WORKER_DB_PASSWORD", connections: 2 },
  { role: "carrier_automation_owner", schema: "carrier_automation", passwordName: "CARRIER_MIGRATION_DB_PASSWORD", connections: 1 },
  { role: "carrier_automation", schema: "carrier_automation", passwordName: "CARRIER_DB_PASSWORD", connections: 2 },
  { role: "settlement_observer", schema: "settlement_observer", passwordName: "SETTLEMENT_DB_PASSWORD", connections: 2 },
]);
const SCHEMA_OWNERS = Object.freeze([
  ["whp_market", "whp_market"],
  ["carrier_automation", "carrier_automation_owner"],
  ["settlement_observer", "settlement_observer"],
]);

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function password(name) {
  const value = required(name);
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} must be 32 random bytes encoded as lowercase hex`);
  return value;
}

function databaseUrl(source, database) {
  const url = new URL(source);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error("BOOTSTRAP_DATABASE_URL must be PostgreSQL");
  url.pathname = `/${database}`;
  return url.toString();
}

function roleDatabaseUrl(source, role, secret) {
  const url = new URL(databaseUrl(source, DATABASE_NAME));
  url.username = role;
  url.password = secret;
  return url.toString();
}

async function ensureRolesAndDatabase(ownerUrl) {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    for (const { role, passwordName, connections } of ROLES) {
      const secret = password(passwordName);
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE "${role}" LOGIN`);
      await client.query(`ALTER ROLE "${role}" WITH LOGIN PASSWORD '${secret}' CONNECTION LIMIT ${connections} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    }
    const database = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [DATABASE_NAME]);
    if (database.rowCount === 0) await client.query(`CREATE DATABASE "${DATABASE_NAME}"`);
    await client.query(`REVOKE ALL ON DATABASE "${DATABASE_NAME}" FROM PUBLIC`);
    for (const { role } of ROLES) await client.query(`GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO "${role}"`);
    await client.query(`GRANT CREATE ON DATABASE "${DATABASE_NAME}" TO "carrier_automation_owner"`);
  } finally {
    await client.end();
  }
}

async function ensureSchemas(ownerUrl) {
  const client = new Client({ connectionString: databaseUrl(ownerUrl, DATABASE_NAME) });
  await client.connect();
  try {
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    for (const [schema, owner] of SCHEMA_OWNERS) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${owner}"`);
      await client.query(`ALTER SCHEMA "${schema}" OWNER TO "${owner}"`);
      await client.query(`REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${owner}"`);
    }
    for (const { role, schema } of ROLES) {
      const owner = SCHEMA_OWNERS.find(([name]) => name === schema)?.[1];
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      if (role !== owner) await client.query(`REVOKE CREATE ON SCHEMA "${schema}" FROM "${role}"`);
      await client.query(`ALTER ROLE "${role}" IN DATABASE "${DATABASE_NAME}" SET search_path = "${schema}", pg_catalog`);
      await client.query(`ALTER ROLE "${role}" IN DATABASE "${DATABASE_NAME}" SET statement_timeout = '30s'`);
      await client.query(`ALTER ROLE "${role}" IN DATABASE "${DATABASE_NAME}" SET lock_timeout = '5s'`);
      await client.query(`ALTER ROLE "${role}" IN DATABASE "${DATABASE_NAME}" SET idle_in_transaction_session_timeout = '30s'`);
    }
  } finally {
    await client.end();
  }
}

async function initializeMarket(ownerUrl) {
  const store = await createPostgresStore(
    roleDatabaseUrl(ownerUrl, "whp_market", password("WHP_MARKET_DB_PASSWORD")),
  );
  await store.close();
}

async function grantMarketWorker(ownerUrl) {
  const client = new Client({
    connectionString: roleDatabaseUrl(ownerUrl, "whp_market", password("WHP_MARKET_DB_PASSWORD")),
  });
  await client.connect();
  try {
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA "whp_market" FROM PUBLIC');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA "whp_market" FROM "whp_market_worker"');
    await client.query('GRANT USAGE ON SCHEMA "whp_market" TO "whp_market_worker"');
    await client.query('GRANT SELECT, UPDATE ON TABLE "whp_market"."whp_market_stripe_fulfillments" TO "whp_market_worker"');
  } finally {
    await client.end();
  }
}

async function initializeObserver(ownerUrl) {
  const pool = new Pool({
    connectionString: roleDatabaseUrl(ownerUrl, "settlement_observer", password("SETTLEMENT_DB_PASSWORD")),
    max: 1,
  });
  const store = new SettlementStore(pool);
  try {
    await store.migrate();
  } finally {
    await pool.end();
  }
}

async function disableCarrierOwnerLogin(ownerUrl) {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`REVOKE CREATE ON DATABASE "${DATABASE_NAME}" FROM "carrier_automation_owner"`);
    await client.query('ALTER ROLE "carrier_automation_owner" NOLOGIN');
  } finally {
    await client.end();
  }
}

const ownerUrl = required("BOOTSTRAP_DATABASE_URL");
await ensureRolesAndDatabase(ownerUrl);
await ensureSchemas(ownerUrl);
await initializeMarket(ownerUrl);
await grantMarketWorker(ownerUrl);
await initializeObserver(ownerUrl);
await migrateCarrierDatabase({
  databaseUrl: roleDatabaseUrl(ownerUrl, "carrier_automation_owner", password("CARRIER_MIGRATION_DB_PASSWORD")),
  runtimeRole: "carrier_automation",
});
await disableCarrierOwnerLogin(ownerUrl);
process.stdout.write(`${JSON.stringify({ event: "database_bootstrap_complete", database: DATABASE_NAME, roles: ROLES.map(({ role }) => role) })}\n`);
