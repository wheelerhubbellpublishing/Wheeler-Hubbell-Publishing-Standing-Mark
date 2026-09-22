import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLiveCandidate} from '../src/discovery.mjs';

const candidate = {
  hostname: 'agent.example.org',
  endpoint: 'https://agent.example.org/a2a',
  manifestUrl: 'https://agent.example.org/.well-known/agent-card.json',
  registryId: 'agent-1',
  name: 'Evidence Agent',
  protocolVersion: '1.0',
  tenant: null,
  skillId: 'verify',
  skillName: 'Verify evidence',
  registryTaskCheckedAt: '2026-09-22T00:00:00Z',
  score: 10,
};

function liveCard(endpoint = candidate.endpoint) {
  return {
    url: endpoint,
    supportedInterfaces: [{protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: endpoint}],
    skills: [{id: 'verify', name: 'Verify evidence', description: 'Read-only evidence validation'}],
  };
}

test('live same-host agent card must re-bind the exact endpoint and selected read-only skill', async () => {
  let observedOptions;
  const verified = await verifyLiveCandidate(candidate, {
    jsonGet: async (_url, options) => {
      observedOptions = options;
      return liveCard();
    },
  });
  assert.equal(verified.endpoint, candidate.endpoint);
  assert.equal(verified.skillId, 'verify');
  assert.equal(observedOptions.maxRedirects, 0);

  await assert.rejects(
    verifyLiveCandidate(candidate, {jsonGet: async () => liveCard('https://agent.example.org/changed')}),
    /does not bind/,
  );
  await assert.rejects(
    verifyLiveCandidate(candidate, {
      jsonGet: async () => ({
        ...liveCard(),
        skills: [{id: 'other', name: 'Other research', description: 'Read only'}],
      }),
    }),
    /does not retain/,
  );
});
