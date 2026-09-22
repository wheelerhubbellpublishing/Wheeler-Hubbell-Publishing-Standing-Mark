import { Fault, canonical, sha256 } from "./core.mjs";
import { createSafeFetcher, normalizePublicHttpsUrl } from "./ssrf.mjs";

const DISCOVERY_PATHS = Object.freeze([
  ["agent_card", "/.well-known/agent-card.json"],
  ["x402", "/.well-known/x402"],
  ["openapi", "/openapi.json"],
  ["llms", "/llms.txt"],
  ["health", "/healthz"],
]);

const SELECTED_HEADERS = Object.freeze([
  "content-type",
  "content-length",
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "www-authenticate",
  "payment-required",
  "server",
]);

function selectedHeaders(headers) {
  const selected = {};
  for (const name of SELECTED_HEADERS) {
    const value = headers[name];
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    selected[name] = text.slice(0, name === "payment-required" ? 256 : 1_024);
  }
  return selected;
}

function safeJson(body, contentType) {
  if (!String(contentType ?? "").toLowerCase().includes("json") || body.length > 262_144) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function summarizeJson(value) {
  if (!value || typeof value !== "object") return null;
  const object = Array.isArray(value) ? null : value;
  if (!object) return { kind: "array", length: value.length };
  const summary = { kind: "object", keys: Object.keys(object).sort().slice(0, 64) };
  if (typeof object.name === "string") summary.name = object.name.slice(0, 200);
  if (typeof object.description === "string") summary.description = object.description.slice(0, 500);
  if (typeof object.version === "string" || typeof object.version === "number") summary.version = object.version;
  if (typeof object.url === "string") summary.url = object.url.slice(0, 2_048);
  if (object.info && typeof object.info === "object" && !Array.isArray(object.info)) {
    summary.info = Object.fromEntries(
      ["title", "version", "description"]
        .filter((key) => ["string", "number"].includes(typeof object.info[key]))
        .map((key) => [key, String(object.info[key]).slice(0, 500)]),
    );
  }
  if (object.capabilities && typeof object.capabilities === "object") summary.capability_keys = Object.keys(object.capabilities).sort().slice(0, 64);
  if (object.paths && typeof object.paths === "object") summary.path_count = Object.keys(object.paths).length;
  if (Array.isArray(object.resources)) summary.resource_count = object.resources.length;
  return summary;
}

function observation(result) {
  const contentType = result.headers["content-type"];
  const parsed = safeJson(result.body, contentType);
  return {
    requested_url: result.requested_url,
    final_url: result.final_url,
    status: result.status,
    reachable: result.status > 0 && result.status < 600,
    redirects: result.redirects,
    response: {
      body_bytes: result.body_bytes,
      body_sha256: result.body_sha256,
      content_type: contentType ? String(contentType).slice(0, 200) : null,
      headers: selectedHeaders(result.headers),
      json_summary: summarizeJson(parsed),
    },
    parsed_json: parsed,
  };
}

async function observe(fetcher, url) {
  try {
    return observation(await fetcher(url));
  } catch (error) {
    const fault = error instanceof Fault ? error : new Fault("TARGET_FETCH_FAILED", 422);
    return {
      requested_url: url,
      final_url: null,
      status: null,
      reachable: false,
      redirects: [],
      error: { code: fault.code, retryable: fault.retryable },
    };
  }
}

function bazaarSignals(observations) {
  const x402 = observations.discovery.x402?.parsed_json;
  const target = observations.target?.parsed_json;
  const candidates = [x402, target].filter(Boolean);
  const challenge = candidates.find((value) => value?.x402Version === 2 && Array.isArray(value?.accepts));
  const extension = challenge?.extensions?.bazaar;
  return {
    x402_discovery_observed: observations.discovery.x402?.reachable === true && observations.discovery.x402?.status < 400,
    payment_challenge_observed: Boolean(challenge),
    bazaar_extension_observed: Boolean(extension?.info?.input && extension?.schema),
    input_type: extension?.info?.input?.type ?? null,
    output_type: extension?.info?.output?.type ?? null,
    indexing_or_ranking_verified: false,
  };
}

function securitySignals(target) {
  const headers = target.response?.headers ?? {};
  return {
    https: target.requested_url?.startsWith("https://") === true,
    hsts_observed: Boolean(headers["strict-transport-security"]),
    csp_observed: Boolean(headers["content-security-policy"]),
    nosniff_observed: String(headers["x-content-type-options"] ?? "").toLowerCase() === "nosniff",
    referrer_policy_observed: Boolean(headers["referrer-policy"]),
    permissions_policy_observed: Boolean(headers["permissions-policy"]),
    redirects_observed: target.redirects?.length ?? 0,
  };
}

function capabilitySignals(observations) {
  const card = observations.discovery.agent_card?.parsed_json;
  const openapi = observations.discovery.openapi?.parsed_json;
  return {
    agent_card_observed: Boolean(card),
    agent_name_claimed: typeof card?.name === "string" ? card.name.slice(0, 200) : null,
    agent_capability_keys_claimed: card?.capabilities && typeof card.capabilities === "object" ? Object.keys(card.capabilities).sort().slice(0, 64) : [],
    openapi_observed: Boolean(openapi?.openapi && openapi?.paths),
    openapi_title_claimed: typeof openapi?.info?.title === "string" ? openapi.info.title.slice(0, 200) : null,
    openapi_path_count_observed: openapi?.paths && typeof openapi.paths === "object" ? Object.keys(openapi.paths).length : 0,
    llms_txt_observed: observations.discovery.llms?.reachable === true && observations.discovery.llms?.status < 400,
    health_observed: observations.discovery.health?.reachable === true && observations.discovery.health?.status < 500,
  };
}

function findingsFor(observations, bazaar, security, capabilities) {
  const findings = [];
  findings.push({
    id: "target-liveness",
    status: observations.target.reachable ? "OBSERVED" : "NOT_OBSERVED",
    statement: observations.target.reachable
      ? `The submitted URL returned HTTP ${observations.target.status}.`
      : `The submitted URL did not produce an admissible public HTTPS response (${observations.target.error?.code ?? "UNKNOWN"}).`,
  });
  findings.push({
    id: "discovery-surface",
    status: capabilities.agent_card_observed || capabilities.openapi_observed || capabilities.llms_txt_observed ? "OBSERVED" : "NOT_OBSERVED",
    statement: `${[capabilities.agent_card_observed && "agent card", capabilities.openapi_observed && "OpenAPI", capabilities.llms_txt_observed && "llms.txt"].filter(Boolean).join(", ") || "No standard discovery artifact"} observed at the submitted origin.`,
  });
  findings.push({
    id: "x402-bazaar-readiness",
    status: bazaar.bazaar_extension_observed ? "DECLARED" : bazaar.x402_discovery_observed ? "PARTIAL" : "NOT_OBSERVED",
    statement: bazaar.bazaar_extension_observed
      ? "An x402 v2 challenge with Bazaar input metadata and a schema was observed. Indexing and ranking were not independently verified."
      : bazaar.x402_discovery_observed
        ? "An x402 discovery document was observed, but a Bazaar-bearing paid challenge was not observed by these GET-only probes."
        : "No x402 discovery document or Bazaar-bearing challenge was observed by these GET-only probes.",
  });
  findings.push({
    id: "browser-security-headers",
    status: security.hsts_observed && security.csp_observed && security.nosniff_observed ? "OBSERVED" : "INCOMPLETE",
    statement: `Observed HSTS=${security.hsts_observed}, CSP=${security.csp_observed}, nosniff=${security.nosniff_observed} on the submitted URL.`,
  });
  return findings;
}

function publicObservations(observations) {
  const copy = structuredClone(observations);
  delete copy.target?.parsed_json;
  for (const value of Object.values(copy.discovery ?? {})) delete value?.parsed_json;
  return copy;
}

function markdownFor(report) {
  const lines = [
    "# WHP Agent/x402 Integrity Snapshot",
    "",
    `Target: ${report.target.url}`,
    `HTTP observation: ${report.observations.target.reachable ? report.observations.target.status : report.observations.target.error.code}`,
    "",
    "## Findings",
    "",
    ...report.findings.flatMap((finding) => [`### ${finding.id} — ${finding.status}`, "", finding.statement, ""]),
    "## Limits",
    "",
    ...report.limitations.map((limit) => `- ${limit}`),
    "",
    `Structured report SHA-256: ${report.structured_sha256}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function createSnapshotEngine({ fetcher = createSafeFetcher() } = {}) {
  return async function makeSnapshot(targetInput) {
    const targetUrl = normalizePublicHttpsUrl(targetInput);
    const origin = targetUrl.origin;
    // Each safe fetch retains its own DNS pin, redirect checks, body limits and
    // ten-second deadline. Running the independent URLs together keeps a normal
    // six-probe snapshot inside a synchronous function's time budget without
    // relaxing any SSRF or response-size boundary. A submitted discovery URL is
    // fetched only once and reused below.
    const discoveryUrls = DISCOVERY_PATHS.map(([name, path]) => [name, new URL(path, origin).href]);
    const uniqueUrls = [...new Set([targetUrl.href, ...discoveryUrls.map(([, url]) => url)])];
    const observed = await Promise.all(uniqueUrls.map(async (url) => [url, await observe(fetcher, url)]));
    const byUrl = new Map(observed);
    const observations = {
      target: byUrl.get(targetUrl.href),
      discovery: Object.fromEntries(discoveryUrls.map(([name, url]) => [name, byUrl.get(url)])),
    };
    const bazaar = bazaarSignals(observations);
    const security = securitySignals(observations.target);
    const capabilities = capabilitySignals(observations);
    const report = {
      version: "WHP-INTEGRITY-SNAPSHOT-v1",
      product: "WHP Agent/x402 Integrity Snapshot",
      price: { amount: "25.00", currency: "USDC", network: "Base" },
      target: { url: targetUrl.href, origin },
      observations: publicObservations(observations),
      analysis: { bazaar, capabilities, security },
      findings: findingsFor(observations, bazaar, security, capabilities),
      limitations: [
        "This records bounded, unauthenticated public HTTPS observations only.",
        "It is not WHP Standing, a WHP Standing Mark, proof of truth, legal advice, or a security certification.",
        "Claims found in agent cards, OpenAPI, x402 documents, headers, and response bodies remain claims unless independently established.",
        "The probes use GET only; they do not sign, spend, execute tools, submit private material, or prove a paid route works.",
        "Payment purchases report generation, not a favorable finding.",
      ],
      determinism: "The same normalized input and identical fetched response bytes/statuses produce the same structured report and Markdown.",
    };
    const structuredSha256 = sha256(canonical(report));
    const withHash = { ...report, structured_sha256: structuredSha256 };
    const markdown = markdownFor(withHash);
    return {
      ...withHash,
      markdown,
      delivery_sha256: sha256(canonical({ report: withHash, markdown })),
    };
  };
}

export function createReadinessEngine({ snapshotEngine = createSnapshotEngine() } = {}) {
  return async function makeReadiness(targetInput) {
    const source = await snapshotEngine(targetInput);
    const missing = [];
    if (!source.analysis.capabilities.agent_card_observed) missing.push("agent-card");
    if (!source.analysis.capabilities.openapi_observed) missing.push("openapi");
    if (!source.analysis.capabilities.llms_txt_observed) missing.push("llms.txt");
    if (!source.analysis.bazaar.x402_discovery_observed) missing.push("x402-discovery");
    if (!source.analysis.bazaar.bazaar_extension_observed) missing.push("bazaar-payment-metadata");
    const report = {
      version: "WHP-X402-READINESS-v1",
      product: "WHP Agent/x402 Readiness Check",
      price: { amount: "0.05", currency: "USDC", network: "Base" },
      target: source.target,
      readiness: {
        target_publicly_reachable: source.observations.target.reachable,
        standard_interfaces_observed: {
          agent_card: source.analysis.capabilities.agent_card_observed,
          openapi: source.analysis.capabilities.openapi_observed,
          llms_txt: source.analysis.capabilities.llms_txt_observed,
          x402_discovery: source.analysis.bazaar.x402_discovery_observed,
          bazaar_payment_metadata: source.analysis.bazaar.bazaar_extension_observed,
        },
        missing_interfaces: missing,
        full_snapshot_may_be_useful: source.observations.target.reachable || missing.length > 0,
      },
      observations: {
        target_status: source.observations.target.status,
        target_error: source.observations.target.error ?? null,
        response_sha256: source.observations.target.response?.body_sha256 ?? null,
      },
      limitations: [
        "This is a bounded public-interface readiness check, not a full integrity snapshot.",
        "It never issues WHP Standing or a WHP Standing Mark and does not establish truth, authority, safety, or legal compliance.",
        "Missing-interface findings mean only that the fixed unauthenticated GET probes did not observe those interfaces.",
        "Payment purchases the check, not a favorable finding.",
      ],
      determinism: source.determinism,
    };
    const structuredSha256 = sha256(canonical(report));
    const withHash = { ...report, structured_sha256: structuredSha256 };
    const markdown = `${[
      "# WHP Agent/x402 Readiness Check",
      "",
      `Target: ${withHash.target.url}`,
      `Publicly reachable: ${withHash.readiness.target_publicly_reachable}`,
      `Missing interfaces: ${missing.join(", ") || "none observed missing"}`,
      `Full snapshot may be useful: ${withHash.readiness.full_snapshot_may_be_useful}`,
      "",
      "This is not WHP Standing, a Standing Mark, or proof of truth.",
      "",
      `Structured report SHA-256: ${structuredSha256}`,
      "",
    ].join("\n")}`;
    return {
      ...withHash,
      markdown,
      delivery_sha256: sha256(canonical({ report: withHash, markdown })),
    };
  };
}
