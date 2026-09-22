import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublicIp, parsePublicHttpsUrl, resolvePublicUrl} from '../src/security.mjs';

test('public IP classification rejects local, private, special, and documentation ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.2',
    '203.0.113.4',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::7f00:1',
    '::a9fe:a9fe',
    '64:ff9b::1',
    '2001:db8::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('1.1.1.1'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('URL syntax policy accepts only credential-free public HTTPS targets on port 443', () => {
  assert.equal(parsePublicHttpsUrl('https://agent.example.org/a2a').href, 'https://agent.example.org/a2a');
  for (const value of [
    'http://agent.example.org/a2a',
    'https://user:pass@agent.example.org/a2a',
    'https://agent.example.org:8443/a2a',
    'https://localhost/a2a',
    'https://service.internal/a2a',
    'https://127.0.0.1/a2a',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1.nip.io/a2a',
  ]) {
    assert.throws(() => parsePublicHttpsUrl(value), /unsafe|non-public/);
  }
});

test('DNS policy requires every returned address to be public', async () => {
  const allPublic = async () => [
    {address: '1.1.1.1', family: 4},
    {address: '2606:4700:4700::1111', family: 6},
  ];
  const mixed = async () => [
    {address: '1.1.1.1', family: 4},
    {address: '127.0.0.1', family: 4},
  ];
  const target = await resolvePublicUrl('https://agent.example.org/a2a', allPublic);
  assert.equal(target.address, '1.1.1.1');
  await assert.rejects(
    resolvePublicUrl('https://agent.example.org/a2a', mixed),
    /exclusively public/,
  );
});
