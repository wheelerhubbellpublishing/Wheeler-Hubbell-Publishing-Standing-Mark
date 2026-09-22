import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatusServer} from '../src/status-server.mjs';

test('malformed absolute request targets return 400 without rejecting the async listener', async () => {
  const server = createStatusServer({
    repository: {ping: async () => true, status: async () => ({})},
    runtimeState: {startedAt: Date.now(), initialized: true},
    config: {statusTimeoutMs: 1000, intervalMs: 21600000},
  });
  const listener = server.listeners('request')[0];
  let status;
  let body;
  await listener(
    {method: 'GET', url: 'http://['},
    {
      writeHead(value) { status = value; },
      end(value) { body = value; },
    },
  );
  assert.equal(status, 400);
  assert.deepEqual(JSON.parse(body), {error: 'invalid_request_target'});
});

