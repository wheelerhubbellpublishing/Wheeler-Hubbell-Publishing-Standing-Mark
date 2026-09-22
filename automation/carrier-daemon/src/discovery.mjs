import {REGISTRY_PAGE_SIZE, REGISTRY_URL} from './constants.mjs';
import {candidatesFromRegistry, selectInterface, selectSkills} from './policy.mjs';
import {parsePublicHttpsUrl, secureJsonGet} from './security.mjs';

export async function discoverCandidates({pages, signal, timeoutMs, jsonGet = secureJsonGet}) {
  const requests = Array.from({length: pages}, (_, page) => {
    const url = new URL(REGISTRY_URL);
    url.searchParams.set('task_verified', 'true');
    url.searchParams.set('conformance', 'standard');
    url.searchParams.set('limit', String(REGISTRY_PAGE_SIZE));
    url.searchParams.set('offset', String(page * REGISTRY_PAGE_SIZE));
    return jsonGet(url.href, {signal, timeoutMs, maxRedirects: 0});
  });
  const responses = await Promise.all(requests);
  const records = new Map();
  for (const response of responses) {
    if (!Array.isArray(response?.agents)) throw new Error('registry response has no agents array');
    for (const record of response.agents) {
      if (record?.id) records.set(String(record.id), record);
    }
  }
  return {
    registryRecords: records.size,
    candidates: candidatesFromRegistry([...records.values()]),
  };
}

export async function verifyLiveCandidate(candidate, {signal, timeoutMs, jsonGet = secureJsonGet} = {}) {
  const card = await jsonGet(candidate.manifestUrl, {signal, timeoutMs, maxRedirects: 0});
  const iface = selectInterface(card);
  if (!iface) throw new Error('live agent card has no eligible JSON-RPC interface');
  const liveEndpoint = parsePublicHttpsUrl(iface.url);
  const liveHostname = liveEndpoint.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (liveHostname !== candidate.hostname || liveEndpoint.href !== candidate.endpoint) {
    throw new Error('live agent card does not bind the selected endpoint');
  }
  const skill = selectSkills(card).find(value => (
    (candidate.skillId && String(value.id ?? '') === candidate.skillId)
    || String(value.name ?? '') === candidate.skillName
  ));
  if (!skill) throw new Error('live agent card does not retain the selected read-only skill');
  return {
    ...candidate,
    protocolVersion: iface.protocolVersion,
    tenant: iface.tenant,
    skillId: String(skill.id ?? '').slice(0, 200),
    skillName: String(skill.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
  };
}
