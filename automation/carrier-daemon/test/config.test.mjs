import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../src/config.mjs';

const KEYS = [
  'CARRIER_DATABASE_URL',
  'WHP_MARKET_ORIGIN',
  'CARRIER_MODE',
  'CARRIER_DISABLED',
  'CARRIER_RUN_IMMEDIATELY',
];

async function environment(values, operation) {
  const prior = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await operation();
  } finally {
    for (const key of KEYS) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('market origin is required, HTTPS, origin-only, and distinct from Standing', {concurrency: false}, async () => {
  const database = 'postgresql://carrier:test@database.example/carrier';
  await environment({CARRIER_DATABASE_URL: database}, async () => {
    assert.throws(() => readConfig(['--once']), /WHP_MARKET_ORIGIN is required/);
  });
  for (const origin of [
    'http://market.example',
    'https://market.example/path',
    'https://user:pass@market.example',
    'https://whp-standing-live-production.up.railway.app',
  ]) {
    await environment({CARRIER_DATABASE_URL: database, WHP_MARKET_ORIGIN: origin}, async () => {
      assert.throws(() => readConfig(['--once']), /WHP_MARKET_ORIGIN/);
    });
  }
  await environment({CARRIER_DATABASE_URL: database, WHP_MARKET_ORIGIN: 'https://market.whp-tools.com'}, async () => {
    const config = readConfig(['--once']);
    assert.equal(config.mode, 'once');
    assert.equal(config.marketOrigin, 'https://market.whp-tools.com');
  });
});
