import test from 'node:test';
import assert from 'node:assert/strict';
import {EPT} from '../src/constants.mjs';
import {
  assertInvitationPolicy,
  buildInvitationRequest,
  candidatesFromRegistry,
  selectSkills,
} from '../src/policy.mjs';

function record(overrides = {}) {
  return {
    id: 'agent-1',
    name: 'Evidence Agent',
    description: 'Public evidence verification service',
    conformance: true,
    is_healthy: true,
    executionEnabled: true,
    url: 'https://agent.example.org/a2a',
    wellKnownURI: 'https://agent.example.org/.well-known/agent-card.json',
    task_conformance: {passed: true, category: 'WORKING', checked_at: '2026-09-22T00:00:00Z'},
    supportedInterfaces: [{
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      url: 'https://agent.example.org/a2a',
    }],
    skills: [{id: 'verify', name: 'Verify evidence', description: 'Read-only evidence validation', tags: ['trust']}],
    ...overrides,
  };
}

test('candidate discovery keeps only healthy public unauthenticated read-only skills and dedupes hostname', () => {
  const unsafeSkill = record({
    id: 'agent-unsafe',
    supportedInterfaces: [{protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'https://unsafe.example.org/a2a'}],
    url: 'https://unsafe.example.org/a2a',
    wellKnownURI: 'https://unsafe.example.org/card',
    skills: [{id: 'delete', name: 'Verify and delete evidence', description: 'Delete stored records'}],
  });
  assert.equal(selectSkills(unsafeSkill).length, 0);

  const duplicate = record({
    id: 'agent-2',
    name: 'Lower score',
    description: '',
    skills: [{id: 'research', name: 'Research source', description: ''}],
  });
  const candidates = candidatesFromRegistry([duplicate, record(), unsafeSkill]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hostname, 'agent.example.org');
  assert.equal(candidates[0].skillName, 'Verify evidence');
});

test('registry manifest, declared URL, and delivery endpoint must share one hostname', () => {
  const manifestMismatch = record({wellKnownURI: 'https://unrelated.example.net/.well-known/agent-card.json'});
  const declaredMismatch = record({url: 'https://unrelated.example.net/a2a'});
  assert.deepEqual(candidatesFromRegistry([manifestMismatch]), []);
  assert.deepEqual(candidatesFromRegistry([declaredMismatch]), []);
});

test('invitation is one disclosed text part with a free link and no requested interaction', () => {
  const [candidate] = candidatesFromRegistry([record()]);
  const request = buildInvitationRequest(candidate, {
    runId: '00000000-0000-4000-8000-000000000001',
    marketOrigin: 'https://market.example',
    messageId: '00000000-0000-4000-8000-000000000002',
  });
  assert.equal(assertInvitationPolicy(request), true);
  const parts = request.body.params.message.parts;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].data, undefined);
  assert.equal(parts[0].file, undefined);
  assert.match(parts[0].text, new RegExp(EPT.sha256));
  assert.match(parts[0].text, /has no attachment/i);
  assert.match(parts[0].text, /requests no subsequent task, payment, signature/i);
  assert.match(parts[0].text, /may consume endpoint compute/i);
  assert.match(parts[0].text, /https:\/\/market\.example\/llms\.txt/);
  assert.match(parts[0].text, /No action is requested/);
  assert.match(parts[0].text, /will not contact this hostname again/i);
  assert.doesNotMatch(JSON.stringify(request.body), /\/v1\/evaluations|x-payment|payment-required|signature-required/i);
});

test('policy assertion rejects attachments and evaluation requests', () => {
  const [candidate] = candidatesFromRegistry([record()]);
  const request = buildInvitationRequest(candidate, {
    runId: '00000000-0000-4000-8000-000000000003',
    marketOrigin: 'https://market.example',
  });
  request.body.params.message.parts.push({data: {attached: true}});
  assert.throws(() => assertInvitationPolicy(request), /exactly one part/);
});
