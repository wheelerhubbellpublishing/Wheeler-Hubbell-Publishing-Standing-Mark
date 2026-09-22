import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  createSafeFetcher,
  isPublicAddress,
  normalizePublicHttpsUrl,
  resolvePublicHost,
} from "../src/ssrf.mjs";

test("URL policy admits only public HTTPS hostnames on port 443", () => {
  assert.equal(normalizePublicHttpsUrl("https://EXAMPLE.com:443/a?b=1").href, "https://example.com/a?b=1");
  for (const value of [
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://example.com:444/",
    "https://localhost/",
    "https://metadata.internal/",
    "https://example.local/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://127.1/",
    "https://example.com/#fragment",
    "https://example.com\\@127.0.0.1/",
  ]) assert.throws(() => normalizePublicHttpsUrl(value), undefined, value);
});

test("public address classifier blocks private, metadata, documentation and special ranges", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.2",
    "203.0.113.2", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1",
    "2001:db8::1", "2001:0000::1", "2002:7f00:1::",
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("DNS rejects any mixed private answer and caps answer sets", async () => {
  await assert.rejects(
    resolvePublicHost("mixed.example.com", { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] }),
    /TARGET_ADDRESS_FORBIDDEN/u,
  );
  await assert.rejects(
    resolvePublicHost("empty.example.com", { lookup: async () => [] }),
    /TARGET_DNS_INVALID/u,
  );
});

function fakeRequestFactory(responses, observed) {
  return (options, callback) => {
    observed.options.push(options);
    class FakeRequest extends EventEmitter {
      setTimeout() {}
      end() {
        options.lookup(options.hostname, { all: false }, (error, address, family) => {
          if (error) return this.emit("error", error);
          observed.pins.push({ address, family });
          const socket = new EventEmitter();
          socket.remoteAddress = address;
          this.emit("socket", socket);
          socket.emit("secureConnect");
          const next = responses.shift();
          const response = Readable.from(next.body ? [Buffer.from(next.body)] : []);
          response.statusCode = next.status;
          response.headers = next.headers ?? { "content-type": "text/plain" };
          response.rawHeaders = Object.entries(response.headers).flatMap(([name, value]) => [name, String(value)]);
          callback(response);
        });
      }
      destroy(error) {
        if (error) this.emit("error", error);
      }
    }
    return new FakeRequest();
  };
}

test("safe fetch pins the vetted DNS answer into the actual request", async () => {
  let resolverCalls = 0;
  const observed = { options: [], pins: [] };
  const fetcher = createSafeFetcher({
    lookup: async () => {
      resolverCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    requestImpl: fakeRequestFactory([{ status: 200, body: "ok" }], observed),
  });
  const result = await fetcher("https://example.com/");
  assert.equal(result.status, 200);
  assert.equal(resolverCalls, 1);
  assert.deepEqual(observed.pins, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(observed.options[0].servername, "example.com");
  assert.equal(observed.options[0].agent, false);
});

test("every redirect is re-resolved and a public-to-private redirect is stopped", async () => {
  const observed = { options: [], pins: [] };
  const fetcher = createSafeFetcher({
    lookup: async (hostname) => hostname === "public.example.com"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }],
    requestImpl: fakeRequestFactory([{ status: 302, headers: { location: "https://private.example.com/latest" } }], observed),
  });
  await assert.rejects(fetcher("https://public.example.com/"), /TARGET_ADDRESS_FORBIDDEN/u);
  assert.equal(observed.options.length, 1);
});
