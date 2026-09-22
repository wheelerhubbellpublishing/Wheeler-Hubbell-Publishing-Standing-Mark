import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunEngine} from '../src/run.mjs';
import {sha256} from '../src/policy.mjs';

function candidate(hostname) {
  return {
    hostname,
    endpoint: `https://${hostname}/a2a`,
    manifestUrl: `https://${hostname}/.well-known/agent-card.json`,
    registryId: `${hostname}-id`,
    name: hostname,
    protocolVersion: '1.0',
    tenant: null,
    skillId: 'verify',
    skillName: 'Verify evidence',
    registryTaskCheckedAt: '2026-09-22T00:00:00Z',
    score: 10,
  };
}

function fakeRepository(order = []) {
  const contacts = new Set();
  const events = [];
  return {
    contacts,
    events,
    withRunLock: operation => operation({}),
    gate: async () => ({allowed: true, counts: {}}),
    recordEvent: async (_client, event) => { events.push(event); },
    contactedHostnames: async (_client, hostnames) => new Set(hostnames.filter(host => contacts.has(host))),
    claimHost: async (_client, {candidate: value}) => {
      order.push(`claim:${value.hostname}`);
      if (contacts.has(value.hostname)) return false;
      contacts.add(value.hostname);
      return true;
    },
    noteSuccess: async (_client, event) => { events.push(event); },
    noteFailure: async () => ({failures: 1, circuitOpened: false}),
  };
}

function configured() {
  return {
    disabled: false,
    maxAutomatedContacts: 500,
    registryPages: 3,
    marketOrigin: 'https://market.example',
    connectTimeoutMs: 20000,
  };
}

test('each run claims before delivery, attempts at most one host, and never revisits it', async () => {
  const order = [];
  const repository = fakeRepository(order);
  const runtimeState = {breakerOpen: false, breakerReason: null};
  const candidates = [candidate('first.example.org'), candidate('second.example.org')];
  let ids = 0;
  let deliveries = 0;
  const engine = createRunEngine({
    repository,
    config: configured(),
    runtimeState,
    idFactory: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    preflight: async () => ({standingEnvironment: 'LIVE'}),
    discover: async () => ({registryRecords: 2, candidates}),
    verifyCandidate: async value => value,
    resolveTarget: async () => true,
    deliver: async ({candidate: value, request}) => {
      order.push(`deliver:${value.hostname}`);
      deliveries += 1;
      const wire = JSON.stringify(request.body);
      return {
        attempted: true,
        responded: false,
        request_sha256: sha256(wire),
        request_bytes: Buffer.byteLength(wire),
        network_error: 'simulated timeout',
      };
    },
  });

  const first = await engine();
  assert.equal(first.kind, 'attempted');
  assert.deepEqual(order, ['claim:first.example.org', 'deliver:first.example.org']);
  assert.equal(deliveries, 1);

  const second = await engine();
  assert.equal(second.kind, 'attempted');
  assert.deepEqual(order, [
    'claim:first.example.org',
    'deliver:first.example.org',
    'claim:second.example.org',
    'deliver:second.example.org',
  ]);
  assert.equal(deliveries, 2);
  assert.deepEqual([...repository.contacts], ['first.example.org', 'second.example.org']);
});

test('a gate suppression performs no preflight, discovery, claim, or delivery', async () => {
  let externalCalls = 0;
  const repository = fakeRepository();
  repository.gate = async () => ({allowed: false, reason: 'minimum_interval'});
  const engine = createRunEngine({
    repository,
    config: configured(),
    runtimeState: {breakerOpen: false, breakerReason: null},
    preflight: async () => { externalCalls += 1; },
    discover: async () => { externalCalls += 1; },
    resolveTarget: async () => { externalCalls += 1; },
    deliver: async () => { externalCalls += 1; },
  });
  const result = await engine();
  assert.equal(result.kind, 'suppressed');
  assert.equal(result.reason, 'minimum_interval');
  assert.equal(externalCalls, 0);
  assert.equal(repository.contacts.size, 0);
});

test('a request mismatch opens the hard circuit breaker after the hostname is consumed', async () => {
  const repository = fakeRepository();
  repository.noteFailure = async ({fatal}) => ({failures: 1, circuitOpened: fatal});
  const runtimeState = {breakerOpen: false, breakerReason: null};
  const target = candidate('mismatch.example.org');
  const engine = createRunEngine({
    repository,
    config: configured(),
    runtimeState,
    preflight: async () => ({standingEnvironment: 'LIVE'}),
    discover: async () => ({registryRecords: 1, candidates: [target]}),
    verifyCandidate: async value => value,
    resolveTarget: async () => true,
    deliver: async () => ({
      attempted: true,
      responded: true,
      request_sha256: '0'.repeat(64),
      request_bytes: 1,
      http_status: 200,
    }),
  });
  const result = await engine();
  assert.equal(result.kind, 'failed');
  assert.equal(result.fatal, true);
  assert.equal(runtimeState.breakerOpen, true);
  assert.equal(repository.contacts.has(target.hostname), true);
});

test('failure and breaker evidence is durable before the advisory lock is released', async () => {
  const order = [];
  const repository = fakeRepository(order);
  repository.withRunLock = async operation => {
    order.push('lock');
    const result = await operation({});
    order.push('unlock');
    return result;
  };
  repository.noteFailureWithClient = async (_client, {fatal}) => {
    order.push('failure-persisted');
    return {failures: 1, circuitOpened: fatal};
  };
  const fault = new Error('locked artifact drift');
  fault.fatal = true;
  const engine = createRunEngine({
    repository,
    config: configured(),
    runtimeState: {breakerOpen: false, breakerReason: null},
    preflight: async () => { throw fault; },
    discover: async () => { throw new Error('must not discover'); },
  });
  const result = await engine();
  assert.equal(result.kind, 'failed');
  assert.deepEqual(order, ['lock', 'failure-persisted', 'unlock']);
});

test('two simultaneous workers yield one bounded pass and suppress the other', async () => {
  const repository = fakeRepository();
  let locked = false;
  repository.withRunLock = async operation => {
    if (locked) return {kind: 'suppressed', reason: 'another_run_active'};
    locked = true;
    try {
      return await operation({});
    } finally {
      locked = false;
    }
  };
  let releasePreflight;
  let announcePreflight;
  const enteredPreflight = new Promise(resolve => { announcePreflight = resolve; });
  const preflightBarrier = new Promise(resolve => { releasePreflight = resolve; });
  let deliveries = 0;
  const target = candidate('concurrent.example.org');
  const engine = createRunEngine({
    repository,
    config: configured(),
    runtimeState: {breakerOpen: false, breakerReason: null},
    preflight: async () => {
      announcePreflight();
      await preflightBarrier;
      return {standingEnvironment: 'LIVE'};
    },
    discover: async () => ({registryRecords: 1, candidates: [target]}),
    verifyCandidate: async value => value,
    resolveTarget: async () => true,
    deliver: async ({request}) => {
      deliveries += 1;
      const wire = JSON.stringify(request.body);
      return {
        attempted: true,
        responded: true,
        request_sha256: sha256(wire),
        request_bytes: Buffer.byteLength(wire),
        http_status: 200,
      };
    },
  });
  const first = engine();
  await enteredPreflight;
  const second = await engine();
  assert.equal(second.kind, 'suppressed');
  assert.equal(second.reason, 'another_run_active');
  releasePreflight();
  assert.equal((await first).kind, 'attempted');
  assert.equal(deliveries, 1);
});

test('a registry full of stale cards cannot make one run validate more than 25 hosts', async () => {
  const repository = fakeRepository();
  const candidates = Array.from({length: 40}, (_, index) => candidate(`stale-${index}.example.org`));
  let validations = 0;
  let deliveries = 0;
  const engine = createRunEngine({
    repository,
    config: configured(),
    runtimeState: {breakerOpen: false, breakerReason: null},
    preflight: async () => ({standingEnvironment: 'LIVE'}),
    discover: async () => ({registryRecords: 40, candidates}),
    resolveTarget: async () => true,
    verifyCandidate: async () => {
      validations += 1;
      throw new Error('stale card');
    },
    deliver: async () => { deliveries += 1; },
  });
  const result = await engine();
  assert.equal(result.kind, 'no_candidate');
  assert.equal(validations, 25);
  assert.equal(deliveries, 0);
});
