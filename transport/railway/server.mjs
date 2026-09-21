import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM_ORIGIN =
  "https://whp-standing-mark-repository.wheelerhubbell.chatgpt.site";
const DEFAULT_UPSTREAM_PREFIX = "/__whp_transport";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHopHeaders(headers) {
  const forwarded = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
  return forwarded;
}

function normalizePrefix(prefix) {
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function writeJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

export function createGatewayServer({
  upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN,
  upstreamPrefix = DEFAULT_UPSTREAM_PREFIX,
} = {}) {
  const upstream = new URL(upstreamOrigin);
  const prefix = normalizePrefix(upstreamPrefix);
  const transport = upstream.protocol === "http:" ? http : https;

  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("UPSTREAM_ORIGIN must use http or https");
  }

  return http.createServer((request, response) => {
    const requestUrl = request.url || "/";
    const parsedRequestUrl = new URL(requestUrl, "http://gateway.invalid");

    if (parsedRequestUrl.pathname === "/__gateway_health") {
      writeJson(response, 200, {
        status: "ok",
        service: "whp-standing-mark-transport",
        upstream: `${upstream.origin}${prefix}`,
      });
      return;
    }

    const headers = withoutHopByHopHeaders(request.headers);
    headers.host = upstream.host;
    headers["x-forwarded-host"] = request.headers.host || "";
    headers["x-forwarded-proto"] = "https";

    const upstreamRequest = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: request.method,
        path: `${prefix}${requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`}`,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = withoutHopByHopHeaders(upstreamResponse.headers);
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          responseHeaders,
        );
        upstreamResponse.pipe(response);
      },
    );

    upstreamRequest.on("error", (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      writeJson(response, 502, {
        error: "upstream_unavailable",
        message: "The canonical application did not answer.",
      });
    });

    request.on("aborted", () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  const server = createGatewayServer({
    upstreamOrigin: process.env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN,
    upstreamPrefix: process.env.UPSTREAM_PREFIX || DEFAULT_UPSTREAM_PREFIX,
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`WHP Standing Mark transport listening on ${port}`);
  });
}
