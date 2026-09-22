import {
  EPT,
  MARKET_SERVICE_IDENTITY,
  MARKET_SETTLEMENT_GATE,
  STANDING_BOOTSTRAP_URL,
} from './constants.mjs';
import {sha256} from './policy.mjs';
import {secureRequest} from './security.mjs';

export class PreflightSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightSafetyError';
    this.fatal = true;
  }
}

function parsedJson(response, label) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new PreflightSafetyError(`${label} is not valid JSON`);
  }
}

export async function verifyMarketPointer({marketOrigin, signal, timeoutMs, request = secureRequest} = {}) {
  if (!marketOrigin) throw new PreflightSafetyError('WHP market origin is unavailable');
  const healthUrl = new URL('/healthz', marketOrigin).href;
  const llmsUrl = new URL('/llms.txt', marketOrigin).href;
  const [health, llms] = await Promise.all([
    request(healthUrl, {
      method: 'GET',
      headers: {accept: 'application/json', 'user-agent': 'WHP-EPT-Carrier/1.0'},
      maxBytes: 100000,
      maxRedirects: 0,
      timeoutMs,
      signal,
    }),
    request(llmsUrl, {
      method: 'GET',
      headers: {accept: 'text/plain', 'user-agent': 'WHP-EPT-Carrier/1.0'},
      maxBytes: 250000,
      maxRedirects: 0,
      timeoutMs,
      signal,
    }),
  ]);
  if (health.status !== 200) {
    throw new PreflightSafetyError(`WHP market health returned HTTP ${health.status}`);
  }
  const identity = parsedJson(health, 'WHP market health');
  if (
    identity.status !== 'ok'
    || identity.service !== MARKET_SERVICE_IDENTITY
    || identity.settlement_gate !== MARKET_SETTLEMENT_GATE
  ) {
    throw new PreflightSafetyError('WHP market health identity or settlement gate does not match the expected service');
  }
  if (llms.status !== 200 || !llms.body.toString('utf8').trim()) {
    throw new PreflightSafetyError('WHP market public-interface listing is unavailable');
  }
  return {healthUrl, llmsUrl, service: identity.service, settlementGate: identity.settlement_gate};
}

export async function verifyPreflight({marketOrigin, signal, timeoutMs, request = secureRequest} = {}) {
  const [copy, manifest, standing, market] = await Promise.all([
    request(EPT.download_url, {
      method: 'GET',
      headers: {accept: 'application/pdf', 'user-agent': 'WHP-EPT-Carrier/1.0'},
      maxBytes: 400000,
      maxRedirects: 0,
      timeoutMs,
      signal,
    }),
    request(EPT.manifest_url, {
      method: 'GET',
      headers: {accept: 'application/json', 'user-agent': 'WHP-EPT-Carrier/1.0'},
      maxBytes: 100000,
      maxRedirects: 0,
      timeoutMs,
      signal,
    }),
    request(STANDING_BOOTSTRAP_URL, {
      method: 'GET',
      headers: {accept: 'application/json', 'user-agent': 'WHP-EPT-Carrier/1.0'},
      maxBytes: 1000000,
      maxRedirects: 0,
      timeoutMs,
      signal,
    }),
    verifyMarketPointer({marketOrigin, signal, timeoutMs, request}),
  ]);

  if (copy.status !== 200 || copy.body.length !== EPT.bytes || sha256(copy.body) !== EPT.sha256) {
    throw new PreflightSafetyError('complimentary EPT artifact does not match its locked bytes and hash');
  }
  if (manifest.status !== 200) {
    throw new PreflightSafetyError(`complimentary EPT manifest returned HTTP ${manifest.status}`);
  }
  parsedJson(manifest, 'complimentary EPT manifest');
  if (standing.status !== 200) {
    throw new PreflightSafetyError(`WHP Standing bootstrap returned HTTP ${standing.status}`);
  }
  const standingJson = parsedJson(standing, 'WHP Standing bootstrap');
  if (standingJson.environment !== 'LIVE') {
    throw new PreflightSafetyError('WHP Standing bootstrap is not LIVE');
  }
  return {
    artifactSha256: EPT.sha256,
    artifactBytes: EPT.bytes,
    manifestAvailable: true,
    standingEnvironment: 'LIVE',
    market,
  };
}
