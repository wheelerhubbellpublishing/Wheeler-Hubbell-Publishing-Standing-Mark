import { getConnectionString } from "@netlify/database";
import { createMarketHandler } from "../../src/market-runtime.mjs";

const handle = createMarketHandler({
  getEnv: (name) => Netlify.env.get(name),
  getDatabaseUrl: getConnectionString,
});

export default async (request, context) => handle(request, context);

export const config = {
  path: [
    "/",
    "/healthz",
    "/openapi.json",
    "/v1/openapi.json",
    "/.well-known/agent-card.json",
    "/.well-known/agent.json",
    "/.well-known/x402",
    "/llms.txt",
    "/a2a",
    "/v1/readiness",
    "/v1/snapshots",
    "/v1/purchases/:purchase_id/result",
    "/v1/purchases/:purchase_id/recover",
    "/webhooks/stripe",
    "/stripe/result",
    "/v1/stripe/results/:token",
  ],
};
