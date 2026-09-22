import {createHash, randomUUID} from 'node:crypto';
import {
  CAMPAIGN_ID,
  CONTACT_POLICY,
  EPT,
  STANDING_BOOTSTRAP_URL,
  WHP_ORIGIN,
} from './constants.mjs';
import {parsePublicHttpsUrl} from './security.mjs';

const RELEVANT = /provenance|authority|evidence|audit|governance|identity|verif|research|trust|lineage|source|fact.?check|citation|accountab|decision.?integrity|validation/i;
const SIDE_EFFECT = /\b(paid|payment|wallet|trade|trading|transaction|transfer|delete|purchase|buy|sell|swap|mint|bet|wager|book|hire|send|post|publish|submit|upload|update|create|register|remember|store|deploy|execute contract)\b/i;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function relevance(value) {
  return (String(value).match(new RegExp(RELEVANT.source, 'gi')) ?? []).length;
}

function strings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function boundedText(value, maximum) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function protocolVersion(value) {
  const version = boundedText(value, 32);
  return /^[0-9][0-9A-Za-z._-]{0,31}$/.test(version) ? version : null;
}

export function selectInterface(card) {
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const found = interfaces.find(value => String(value?.protocolBinding).toUpperCase() === 'JSONRPC' && value?.url);
  if (found) {
    const version = protocolVersion(found.protocolVersion ?? card.protocolVersion ?? '1.0');
    if (!version) return null;
    return {
      url: String(found.url),
      tenant: found.tenant === undefined || found.tenant === null ? null : boundedText(found.tenant, 200),
      protocolVersion: version,
    };
  }
  if (card.url && String(card.preferredTransport ?? 'JSONRPC').toUpperCase().includes('JSON')) {
    const version = protocolVersion(card.protocolVersion ?? '0.3');
    if (!version) return null;
    return {
      url: String(card.url),
      tenant: null,
      protocolVersion: version,
    };
  }
  return null;
}

function isUnauthenticated(card, skill) {
  const required = value => Array.isArray(value)
    ? value.length > 0
    : Boolean(value && typeof value === 'object' && Object.keys(value).length);
  if (required(card.securityRequirements)) return false;
  if (required(card.security)) return false;
  if (required(skill?.securityRequirements)) return false;
  if (required(skill?.security)) return false;
  return true;
}

export function selectSkills(card) {
  return (Array.isArray(card.skills) ? card.skills : [])
    .map(skill => {
      const text = [skill?.name, skill?.description, ...strings(skill?.tags)].join(' ');
      return {skill, text, score: relevance(text)};
    })
    .filter(item => item.skill?.name && RELEVANT.test(String(item.skill.name)) && !SIDE_EFFECT.test(item.text))
    .filter(item => isUnauthenticated(card, item.skill))
    .sort((left, right) => right.score - left.score || String(left.skill.name).localeCompare(String(right.skill.name)))
    .map(item => item.skill);
}

export function candidatesFromRegistry(records) {
  const byHost = new Map();
  const ownHost = new URL(WHP_ORIGIN).hostname;

  for (const record of records) {
    if (
      record?.conformance !== true
      || record?.is_healthy !== true
      || record?.task_conformance?.passed !== true
      || record?.task_conformance?.category !== 'WORKING'
      || !record?.wellKnownURI
      || !record?.url
      || record?.executionEnabled === false
      || /NOT_AN_ACTIVE|DISCOVERY_METADATA_ONLY|DORMANT/i.test(String(record?.interfaceStatus ?? ''))
    ) continue;

    const iface = selectInterface(record);
    const skill = selectSkills(record)[0];
    if (!iface || !skill) continue;

    let endpoint;
    let manifest;
    let declaredUrl;
    try {
      endpoint = parsePublicHttpsUrl(iface.url);
      manifest = parsePublicHttpsUrl(record.wellKnownURI);
      declaredUrl = parsePublicHttpsUrl(record.url);
    } catch {
      continue;
    }
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const manifestHostname = manifest.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const declaredHostname = declaredUrl.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (manifestHostname !== hostname || declaredHostname !== hostname) continue;
    if (hostname === ownHost) continue;

    const matchedText = [
      record.name,
      record.description,
      skill.name,
      skill.description,
      ...strings(skill.tags),
    ].join(' ');
    const candidate = {
      hostname,
      endpoint: endpoint.href,
      manifestUrl: manifest.href,
      registryId: boundedText(record.id, 200),
      name: boundedText(record.name ?? hostname, 200),
      protocolVersion: iface.protocolVersion,
      tenant: iface.tenant,
      skillId: boundedText(skill.id, 200),
      skillName: boundedText(skill.name, 160),
      registryTaskCheckedAt: boundedText(record.task_conformance?.checked_at, 64) || null,
      score: relevance(matchedText),
    };
    const existing = byHost.get(hostname);
    if (!existing || candidate.score > existing.score || (
      candidate.score === existing.score && candidate.endpoint.localeCompare(existing.endpoint) < 0
    )) {
      byHost.set(hostname, candidate);
    }
  }

  return [...byHost.values()].sort((left, right) => (
    right.score - left.score
    || left.hostname.localeCompare(right.hostname)
    || left.endpoint.localeCompare(right.endpoint)
  ));
}

export function invitationText(candidate, marketOrigin) {
  const marketTools = new URL('/llms.txt', marketOrigin).href;
  return `Hello from the Wheeler Hubbell Publishing T-shirt interns. Wheeler Hubbell Publishing is making one exact complimentary digital copy of Wheeler Hubbell's The Elemental Properties of True available because this public endpoint advertises the relevant skill "${candidate.skillName}". Copy: ${EPT.download_url} Manifest: ${EPT.manifest_url} SHA-256: ${EPT.sha256}. Reading it or ignoring it is entirely optional. Optional WHP public-interface tools, if independently useful, are listed at ${marketTools}. No action is requested. This one delivery invokes A2A message processing and may consume endpoint compute. It has no attachment and requests no subsequent task, payment, signature, account, wallet, reply, forwarding, or other action. WHP will not contact this hostname again. General WHP Standing information, if independently relevant, is available at ${STANDING_BOOTSTRAP_URL}. This is disclosed WHP outreach; it is not evidence of independent discovery, demand, endorsement, adoption, evaluation, standing, or propagation.`;
}

export function buildInvitationRequest(candidate, {runId, marketOrigin, messageId = randomUUID()} = {}) {
  if (!runId) throw new Error('runId is required');
  if (!marketOrigin) throw new Error('marketOrigin is required');
  const carrierId = `whp-ept-carrier-${runId}`;
  const versionOne = String(candidate.protocolVersion).startsWith('1');
  const text = invitationText(candidate, marketOrigin);
  const metadata = versionOne ? {
    campaignId: CAMPAIGN_ID,
    carrierId,
    operator: 'Wheeler Hubbell Publishing',
    outreach: true,
    automated: true,
    replyRequested: false,
    contactPolicy: CONTACT_POLICY,
  } : {
    campaign_id: CAMPAIGN_ID,
    carrier_id: carrierId,
    operator: 'Wheeler Hubbell Publishing',
    outreach: true,
    automated: true,
    reply_requested: false,
    contact_policy: CONTACT_POLICY,
  };
  const message = versionOne ? {
    messageId,
    role: 'ROLE_USER',
    parts: [{text, mediaType: 'text/plain'}],
    metadata,
  } : {
    kind: 'message',
    messageId,
    role: 'user',
    parts: [{kind: 'text', text}],
    metadata,
  };
  const params = versionOne ? {
    message,
    configuration: {acceptedOutputModes: ['text/plain'], historyLength: 0},
  } : {message};
  if (candidate.tenant) params.tenant = candidate.tenant;
  return {
    carrierId,
    body: {
      jsonrpc: '2.0',
      id: carrierId,
      method: versionOne ? 'SendMessage' : 'message/send',
      params,
    },
  };
}

export function assertInvitationPolicy(request) {
  const parts = request?.body?.params?.message?.parts;
  if (!Array.isArray(parts) || parts.length !== 1) throw new Error('invitation must have exactly one part');
  const part = parts[0];
  if (typeof part?.text !== 'string' || part.data !== undefined || part.file !== undefined) {
    throw new Error('invitation must be text-only without an attachment');
  }
  const wire = JSON.stringify(request.body);
  if (/\/v1\/evaluations|x-payment|payment-required|signature-required/i.test(wire)) {
    throw new Error('invitation contains a payment, signature, or evaluation request');
  }
  return true;
}
