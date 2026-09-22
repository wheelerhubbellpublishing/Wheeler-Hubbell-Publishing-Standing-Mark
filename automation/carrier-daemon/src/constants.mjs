export const SERVICE_NAME = 'whp-ept-carrier';
export const SERVICE_VERSION = '1.0.0';
export const CAMPAIGN_ID = 'whp-ept-public-invitation-v2';
export const DATABASE_SCHEMA = 'carrier_automation';

export const WHP_ORIGIN = 'https://whp-standing-live-production.up.railway.app';
export const STANDING_BOOTSTRAP_URL = `${WHP_ORIGIN}/.well-known/whp-standing.json`;
export const REGISTRY_URL = 'https://a2aregistry.org/api/agents';
export const MARKET_SERVICE_IDENTITY = 'WHP Agent/x402 Integrity Market';
export const MARKET_SETTLEMENT_GATE = 'finalized-on-chain';

export const ARTIFACT_COMMIT = '0daf1eec3f13b053e648a54f8f1b91bc377a46e3';
export const ARTIFACT_BASE_URL = `https://raw.githubusercontent.com/wheelerhubbellpublishing/Wheeler-Hubbell-Publishing-Standing-Mark/${ARTIFACT_COMMIT}/public/free/ept`;

export const EPT = Object.freeze({
  artifact_id: 'WHP-EPT-N001',
  title: 'The Elemental Properties of True',
  author: 'Wheeler Hubbell',
  edition: 'First Edition',
  media_type: 'application/pdf',
  bytes: 286707,
  sha256: 'b1d6297ab5bf1a0c2c3ee7e28531285fdfdb6b974513102700d2f24d43feb1ef',
  download_url: `${ARTIFACT_BASE_URL}/N001_The_Elemental_Properties_of_True_First_Edition.pdf`,
  manifest_url: `${ARTIFACT_BASE_URL}/manifest.json`,
});

export const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_INVITATIONS_PER_RUN = 1;
export const MAX_INVITATIONS_PER_24_HOURS = 4;
export const MAX_CANDIDATE_VALIDATIONS_PER_RUN = 25;
export const DEFAULT_MAX_AUTOMATED_CONTACTS = 500;
export const DEFAULT_REGISTRY_PAGES = 3;
export const REGISTRY_PAGE_SIZE = 100;
export const RUN_FAILURES_BEFORE_BREAKER = 3;

export const CONTACT_POLICY = 'One lifetime invitation per public hostname; at most one new invitation per run and four per rolling 24 hours; no attachment, subsequent task or reply request, retry, or follow-up.';

export const LEGACY_CONTACTS = Object.freeze([
  '01mind.net',
  'afmr.ai',
  'agent-guild-5d5r.onrender.com',
  'agents.muj428.com',
  'aiagent.tessa.tech',
  'anp2.com',
  'api.aux.prdictionedge.ai',
  'api.berrergate.com',
  'api.getaiscan.app',
  'attractor-observatory-demo.vercel.app',
  'coinrailz.com',
  'gaip-agent-to-art-prototype-production.up.railway.app',
  'marginalia.polycode.co.uk',
  'namewhisper.ai',
  'nulliverba.ol-lo.workers.dev',
  'p0stman.com',
  'relaymarket.notary-labs.workers.dev',
  'sssnack.com',
  'tellumen-a2a-agent.onrender.com',
]);

export const LEGACY_CAMPAIGN = Object.freeze({
  campaign_id: 'whp-ept-interns-20260922',
  contacted_at: '2026-09-22T01:46:36.765Z',
  evidence_version: 'WHP-EPT-INTERN-FLEET-EXECUTION-v1',
  unique_hosts: 19,
});
