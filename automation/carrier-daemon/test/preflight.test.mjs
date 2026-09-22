import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMarketPointer, verifyPreflight} from '../src/preflight.mjs';

test('artifact drift is a fatal preflight safety fault and no retry occurs', async () => {
  let requests = 0;
  const request = async value => {
    requests += 1;
    if (value.endsWith('.pdf')) return {status: 200, body: Buffer.from('wrong artifact')};
    if (value.endsWith('manifest.json')) return {status: 200, body: Buffer.from('{}')};
    if (value.endsWith('/healthz')) return {
      status: 200,
      body: Buffer.from('{"status":"ok","service":"WHP Agent/x402 Integrity Market","settlement_gate":"finalized-on-chain"}'),
    };
    if (value.endsWith('/llms.txt')) return {status: 200, body: Buffer.from('WHP public tools')};
    return {status: 200, body: Buffer.from('{"environment":"LIVE"}')};
  };
  await assert.rejects(
    verifyPreflight({marketOrigin: 'https://market.example', request}),
    error => error?.fatal === true && /locked bytes and hash/.test(error.message),
  );
  assert.equal(requests, 5);
});

test('market pointer requires the exact service identity and finalized-on-chain gate', async () => {
  const observed = [];
  const request = async (value, options) => {
    observed.push(options.maxRedirects);
    return value.endsWith('/healthz') ? {
    status: 200,
    body: Buffer.from(JSON.stringify({
      status: 'ok',
      service: 'WHP Agent/x402 Integrity Market',
      version: '1.0.0',
      settlement_gate: 'finalized-on-chain',
    })),
    } : {status: 200, body: Buffer.from('WHP public tools')};
  };
  const result = await verifyMarketPointer({marketOrigin: 'https://market.example', request});
  assert.equal(result.llmsUrl, 'https://market.example/llms.txt');
  assert.equal(result.settlementGate, 'finalized-on-chain');
  assert.deepEqual(observed, [0, 0]);

  await assert.rejects(
    verifyMarketPointer({
      marketOrigin: 'https://market.example',
      request: async value => value.endsWith('/healthz')
        ? {status: 200, body: Buffer.from('{"status":"ok","service":"Other","settlement_gate":"facilitator-only"}')}
        : {status: 200, body: Buffer.from('tools')},
    }),
    error => error?.fatal === true && /identity or settlement gate/.test(error.message),
  );
});
