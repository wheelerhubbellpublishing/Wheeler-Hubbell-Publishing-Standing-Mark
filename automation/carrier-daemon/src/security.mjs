import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const FORBIDDEN_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$|\.home\.arpa$|\.test$|\.invalid$|\.example$|\.onion$|\.ts\.net$|\.tailnet$|\.nip\.io$|\.sslip\.io$|(^|\.)metadata\.google\.internal$|(^|\.)chatgpt\.site$|(^|\.)chatgpt\.com$|(^|\.)openai\.com$|workspace)/i;

function ipv4Integer(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv6Parts(address) {
  let input = address.toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const splitAt = input.lastIndexOf(':');
    const embedded = ipv4Integer(input.slice(splitAt + 1));
    if (embedded === null) return null;
    input = `${input.slice(0, splitAt)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftText, rightText] = input.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!input.includes('::') && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map(part => Number.parseInt(part, 16));
}

function ipv6BigInt(address) {
  const parts = ipv6Parts(address);
  if (!parts) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(part), 0n);
}

function matchesPrefix(value, network, prefix) {
  if (prefix === 0) return true;
  const shift = 128n - BigInt(prefix);
  return value >> shift === network >> shift;
}

const IPV6_DENYLIST = Object.freeze([
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
].map(([network, prefix]) => [ipv6BigInt(network), prefix]));

export function isPublicIp(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Integer(address);
    if (value === null) return false;
    const a = value >>> 24;
    const b = value >>> 16 & 0xff;
    const c = value >>> 8 & 0xff;
    return !(
      a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const value = ipv6BigInt(address);
    if (value === null) return false;
    return !IPV6_DENYLIST.some(([network, prefix]) => matchesPrefix(value, network, prefix));
  }
  return false;
}

export function parsePublicHttpsUrl(value) {
  const url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !hostname
    || url.href.length > 4096
    || FORBIDDEN_HOST.test(hostname)
  ) {
    throw new Error('unsafe or non-public URL');
  }
  if (isIP(hostname) && !isPublicIp(hostname)) {
    throw new Error('URL resolves to a non-public address');
  }
  return url;
}

export async function resolvePublicUrl(value, lookup = dnsLookup, timeoutMs = 10000) {
  const url = parsePublicHttpsUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  let addresses;
  if (isIP(hostname)) {
    addresses = [{address: hostname, family: isIP(hostname)}];
  } else {
    let timer;
    try {
      addresses = await Promise.race([
        lookup(hostname, {all: true, verbatim: true}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS lookup timeout')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const unique = [...new Map(addresses.map(item => [`${item.family}:${item.address}`, item])).values()];
  if (!unique.length || unique.some(item => !isPublicIp(item.address))) {
    throw new Error('hostname has no exclusively public address set');
  }
  unique.sort((left, right) => left.family - right.family);
  return {url, hostname, address: unique[0].address, family: unique[0].family, addresses: unique};
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{address, family}]);
      return;
    }
    callback(null, address, family);
  };
}

function requestOnce(target, options) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    maxBytes = 1024 * 1024,
    signal,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      operation(value);
    };
    const request = https.request({
      protocol: 'https:',
      hostname: target.hostname,
      port: 443,
      path: `${target.url.pathname}${target.url.search}`,
      method,
      headers,
      agent: false,
      lookup: pinnedLookup(target.address, target.family),
      servername: isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
    }, response => {
      response.once('error', error => finish(reject, error));
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy(new Error('response too large'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        url: target.url.href,
        remoteAddress: target.address,
      }));
    });
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('request aborted'));
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, {once: true});
    }
    deadlineTimer = setTimeout(() => request.destroy(new Error('request deadline exceeded')), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('request timeout')));
    request.on('error', error => finish(reject, error));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function secureRequest(value, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  let current = String(value);
  const maxRedirects = method === 'GET' ? Number(options.maxRedirects ?? 3) : 0;
  const timeoutMs = Number(options.timeoutMs ?? 20000);
  const deadline = Date.now() + timeoutMs;

  for (let redirects = 0; ; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('request deadline exceeded');
    const target = await resolvePublicUrl(current, options.lookup, Math.min(remaining, 10000));
    const result = await requestOnce(target, {...options, method, timeoutMs: Math.max(1, deadline - Date.now())});
    const location = result.headers.location;
    if (result.status >= 300 && result.status < 400 && location) {
      if (redirects >= maxRedirects) return result;
      current = new URL(location, target.url).href;
      continue;
    }
    return result;
  }
}

export async function secureJsonGet(value, options = {}) {
  const response = await secureRequest(value, {
    ...options,
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'WHP-EPT-Carrier/1.0',
      ...(options.headers ?? {}),
    },
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new Error('invalid JSON response');
  }
}
