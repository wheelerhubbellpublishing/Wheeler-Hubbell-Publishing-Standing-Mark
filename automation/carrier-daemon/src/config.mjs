import {
  DEFAULT_MAX_AUTOMATED_CONTACTS,
  DEFAULT_REGISTRY_PAGES,
  SCHEDULE_INTERVAL_MS,
  WHP_ORIGIN,
} from './constants.mjs';
import {parsePublicHttpsUrl} from './security.mjs';

function httpsOrigin(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  let url;
  try {
    url = parsePublicHttpsUrl(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin with no path, credentials, query, or fragment`);
  }
  return url.origin;
}

function integer(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

export function readConfig(argv = process.argv.slice(2)) {
  const once = argv.includes('--once') || process.env.CARRIER_MODE === 'once';
  const databaseUrl = process.env.CARRIER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('CARRIER_DATABASE_URL is required');
  }
  const marketOrigin = httpsOrigin('WHP_MARKET_ORIGIN');
  if (marketOrigin === new URL(WHP_ORIGIN).origin) {
    throw new Error('WHP_MARKET_ORIGIN must identify the distinct WHP market service');
  }

  return Object.freeze({
    mode: once ? 'once' : 'daemon',
    databaseUrl,
    marketOrigin,
    port: integer('PORT', 3000, 1, 65535),
    disabled: boolean('CARRIER_DISABLED', false),
    runImmediately: boolean('CARRIER_RUN_IMMEDIATELY', true),
    intervalMs: SCHEDULE_INTERVAL_MS,
    maxAutomatedContacts: integer(
      'CARRIER_MAX_AUTOMATED_CONTACTS',
      DEFAULT_MAX_AUTOMATED_CONTACTS,
      1,
      100000,
    ),
    registryPages: integer('CARRIER_REGISTRY_PAGES', DEFAULT_REGISTRY_PAGES, 1, 10),
    connectTimeoutMs: integer('CARRIER_CONNECT_TIMEOUT_MS', 20000, 1000, 60000),
    statusTimeoutMs: integer('CARRIER_STATUS_TIMEOUT_MS', 3000, 250, 10000),
  });
}
