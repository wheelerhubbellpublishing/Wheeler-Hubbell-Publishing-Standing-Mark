import { createHash, timingSafeEqual } from "node:crypto";

export class Fault extends Error {
  constructor(code, status = 400, options = {}) {
    super(code);
    this.name = "Fault";
    this.code = code;
    this.status = status;
    this.retryable = options.retryable === true;
  }
}

export function demand(condition, code, status = 400, options) {
  if (!condition) throw new Fault(code, status, options);
}

function normalized(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    demand(Number.isFinite(value), "NON_FINITE_NUMBER", 500);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalized);
  demand(typeof value === "object", "NON_JSON_VALUE", 500);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, normalized(value[key])]),
  );
}

export function canonical(value) {
  return JSON.stringify(normalized(value));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonical(value));
  return createHash("sha256").update(bytes).digest("hex");
}

export function sameJson(left, right) {
  const a = Buffer.from(canonical(left));
  const b = Buffer.from(canonical(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encodeBase64Json(value) {
  return Buffer.from(canonical(value)).toString("base64");
}

export function decodeBase64Json(value, maxBytes = 65_536) {
  demand(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(maxBytes / 3) * 4 + 4, "PAYMENT_HEADER_INVALID");
  demand(/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0, "PAYMENT_HEADER_INVALID");
  const bytes = Buffer.from(value, "base64");
  demand(bytes.length <= maxBytes && bytes.toString("base64") === value, "PAYMENT_HEADER_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Fault("PAYMENT_HEADER_INVALID");
  }
  demand(parsed && typeof parsed === "object" && !Array.isArray(parsed), "PAYMENT_HEADER_INVALID");
  return parsed;
}

export async function readRequestBytes(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Fault("BODY_TOO_LARGE", 413);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

export async function readRequestBody(request, maxBytes) {
  const bytes = await readRequestBytes(request, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Fault("INVALID_UTF8");
  }
}

export function parseJson(raw, code = "INVALID_JSON") {
  try {
    const value = JSON.parse(raw);
    demand(value && typeof value === "object" && !Array.isArray(value), code);
    return value;
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(code);
  }
}

export function exactKeys(value, required, optional = []) {
  demand(value && typeof value === "object" && !Array.isArray(value), "OBJECT_REQUIRED");
  const allowed = new Set([...required, ...optional]);
  demand(required.every((key) => Object.hasOwn(value, key)), "OBJECT_FIELDS_INVALID");
  demand(Object.keys(value).every((key) => allowed.has(key)), "OBJECT_FIELDS_INVALID");
}

export const NO_STORE_HEADERS = Object.freeze({
  "cache-control": "no-store, private",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
});

export function jsonResponse(status, value, headers = {}) {
  const body = `${canonical(value)}\n`;
  return new Response(body, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
