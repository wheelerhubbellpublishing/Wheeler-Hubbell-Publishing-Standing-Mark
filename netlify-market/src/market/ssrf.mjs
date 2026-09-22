import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Fault, demand, sha256 } from "./core.mjs";

export const MAX_TARGET_URL_BYTES = 2_048;
export const MAX_REMOTE_BODY_BYTES = 524_288;
export const MAX_REMOTE_HEADER_BYTES = 16_384;
export const MAX_REMOTE_HEADERS = 64;
export const MAX_DNS_ANSWERS = 16;
export const MAX_REDIRECTS = 3;
export const TOTAL_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 4_000;

const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
  ".arpa",
];

const IPV4_DENY = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4Integer(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const ip = ipv4Integer(address);
  const network = ipv4Integer(base);
  if (ip === null || network === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (network & mask);
}

function expandIpv6(address) {
  const withoutZone = address.toLowerCase().split("%")[0];
  if (withoutZone.includes(".")) {
    const index = withoutZone.lastIndexOf(":");
    const v4 = ipv4Integer(withoutZone.slice(index + 1));
    if (v4 === null) return null;
    address = `${withoutZone.slice(0, index)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  } else address = withoutZone;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 1 && halves.length === 2) return null;
  const words = [...left, ...Array(fill).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function ipv6Prefix(words, prefixWords) {
  return prefixWords.every((word, index) => words[index] === word);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !IPV4_DENY.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  if (family !== 6) return false;
  const words = expandIpv6(address);
  if (!words) return false;

  // Only globally routable unicast is admitted. Translation, transition,
  // documentation, special-use, ULA, link-local and multicast space is rejected.
  const isGlobal2000 = (words[0] & 0xe000) === 0x2000;
  if (!isGlobal2000) return false;
  if (words[0] === 0x2001 && words[1] <= 0x01ff) return false;
  if (ipv6Prefix(words, [0x2001, 0x0db8])) return false;
  if (ipv6Prefix(words, [0x2002])) return false;
  if ((words[0] & 0xfff0) === 0x3ff0) return false;
  return true;
}

export function normalizePublicHttpsUrl(input) {
  demand(typeof input === "string" && Buffer.byteLength(input) > 0 && Buffer.byteLength(input) <= MAX_TARGET_URL_BYTES, "TARGET_URL_INVALID");
  demand(!/[\u0000-\u0020\u007f\\]/u.test(input), "TARGET_URL_INVALID");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Fault("TARGET_URL_INVALID");
  }
  demand(url.protocol === "https:" && !url.username && !url.password, "TARGET_HTTPS_REQUIRED");
  demand(url.port === "" || url.port === "443", "TARGET_PORT_FORBIDDEN");
  demand(url.hash === "", "TARGET_FRAGMENT_FORBIDDEN");
  demand(net.isIP(url.hostname) === 0, "TARGET_IP_LITERAL_FORBIDDEN");
  const hostname = url.hostname.toLowerCase();
  demand(hostname.length <= 253 && hostname.includes(".") && !hostname.endsWith("."), "TARGET_HOST_INVALID");
  demand(hostname !== "localhost" && !FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)), "TARGET_HOST_FORBIDDEN");
  const labels = hostname.split(".");
  demand(labels.every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)), "TARGET_HOST_INVALID");
  url.hostname = hostname;
  if (url.port === "443") url.port = "";
  return url;
}

async function withDeadline(promise, deadline, code) {
  const remaining = deadline - Date.now();
  demand(remaining > 0, code, 504, { retryable: true });
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Fault(code, 504, { retryable: true })), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePublicHost(hostname, { lookup = dns.lookup, deadline = Date.now() + TOTAL_TIMEOUT_MS } = {}) {
  let answers;
  try {
    answers = await withDeadline(lookup(hostname, { all: true, verbatim: true }), deadline, "TARGET_DNS_TIMEOUT");
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("TARGET_DNS_FAILED", 422);
  }
  demand(Array.isArray(answers) && answers.length > 0 && answers.length <= MAX_DNS_ANSWERS, "TARGET_DNS_INVALID", 422);
  demand(answers.every((entry) => entry && [4, 6].includes(entry.family) && net.isIP(entry.address) === entry.family), "TARGET_DNS_INVALID", 422);
  demand(answers.every((entry) => isPublicAddress(entry.address)), "TARGET_ADDRESS_FORBIDDEN", 422);
  return [...answers].sort((a, b) => a.family - b.family || a.address.localeCompare(b.address))[0];
}

function headerBytes(rawHeaders = []) {
  return rawHeaders.reduce((size, value) => size + Buffer.byteLength(value) + 2, 2);
}

function comparableAddress(address) {
  const stripped = address.replace(/^::ffff:/u, "");
  if (net.isIP(stripped) === 4) return stripped;
  const words = expandIpv6(stripped);
  return words ? words.map((word) => word.toString(16).padStart(4, "0")).join("") : null;
}

function oneRequest(url, pin, { requestImpl, deadline, maxBodyBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Fault("TARGET_TIMEOUT", 504, { retryable: true }));
      return;
    }
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      reject(error instanceof Fault ? error : new Fault("TARGET_FETCH_FAILED", 422));
    };
    const totalTimer = setTimeout(() => {
      request.destroy(new Fault("TARGET_TIMEOUT", 504, { retryable: true }));
    }, remaining);
    const pinnedLookup = (_hostname, options, callback) => {
      const item = { address: pin.address, family: pin.family };
      if (options?.all) callback(null, [item]);
      else callback(null, item.address, item.family);
    };
    const request = requestImpl(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          accept: "application/json, text/plain;q=0.9, text/html;q=0.7, */*;q=0.1",
          "accept-encoding": "identity",
          host: url.host,
          "user-agent": "WHP-Integrity-Snapshot/1.0 (+https://wheelerhubbell.com)",
        },
        lookup: pinnedLookup,
        family: pin.family,
        servername: url.hostname,
        agent: false,
        autoSelectFamily: false,
        insecureHTTPParser: false,
        maxHeaderSize: MAX_REMOTE_HEADER_BYTES,
        rejectUnauthorized: true,
      },
      (response) => {
        const rawHeaders = response.rawHeaders ?? [];
        if (rawHeaders.length / 2 > MAX_REMOTE_HEADERS || headerBytes(rawHeaders) > MAX_REMOTE_HEADER_BYTES) {
          response.destroy();
          fail(new Fault("TARGET_HEADERS_TOO_LARGE", 422));
          return;
        }
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location !== undefined) {
          settled = true;
          clearTimeout(totalTimer);
          response.destroy();
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.alloc(0) });
          return;
        }
        const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
        if (encoding !== "identity") {
          response.destroy();
          fail(new Fault("TARGET_CONTENT_ENCODING_UNSUPPORTED", 422));
          return;
        }
        const declared = response.headers["content-length"];
        if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > maxBodyBytes)) {
          response.destroy();
          fail(new Fault("TARGET_BODY_TOO_LARGE", 422));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBodyBytes) {
            response.destroy();
            fail(new Fault("TARGET_BODY_TOO_LARGE", 422));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimer);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.once("error", fail);
    request.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        const remote = socket.remoteAddress?.replace(/^::ffff:/u, "") ?? "";
        if (comparableAddress(remote) !== comparableAddress(pin.address) || !isPublicAddress(remote)) request.destroy(new Fault("TARGET_ADDRESS_CHANGED", 422));
      });
    });
    request.setTimeout(Math.min(IDLE_TIMEOUT_MS, remaining), () => request.destroy(new Fault("TARGET_TIMEOUT", 504, { retryable: true })));
    request.end();
  });
}

export function createSafeFetcher({
  lookup = dns.lookup,
  requestImpl = https.request,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
  maxBodyBytes = MAX_REMOTE_BODY_BYTES,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  return async function safeFetch(input) {
    let url = normalizePublicHttpsUrl(input);
    const deadline = Date.now() + totalTimeoutMs;
    const redirects = [];
    const seen = new Set();
    for (let hop = 0; ; hop += 1) {
      const key = url.href;
      demand(!seen.has(key), "TARGET_REDIRECT_CYCLE", 422);
      seen.add(key);
      const pin = await resolvePublicHost(url.hostname, { lookup, deadline });
      const response = await oneRequest(url, pin, { requestImpl, deadline, maxBodyBytes });
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.status) && location !== undefined) {
        demand(hop < maxRedirects, "TARGET_REDIRECT_LIMIT", 422);
        let next;
        try {
          next = new URL(String(location), url);
        } catch {
          throw new Fault("TARGET_REDIRECT_INVALID", 422);
        }
        const normalized = normalizePublicHttpsUrl(next.href);
        redirects.push({ from: url.href, status: response.status, to: normalized.href });
        url = normalized;
        continue;
      }
      return {
        requested_url: normalizePublicHttpsUrl(input).href,
        final_url: url.href,
        redirects,
        status: response.status,
        headers: response.headers,
        body: response.body,
        body_sha256: sha256(response.body),
        body_bytes: response.body.length,
      };
    }
  };
}
