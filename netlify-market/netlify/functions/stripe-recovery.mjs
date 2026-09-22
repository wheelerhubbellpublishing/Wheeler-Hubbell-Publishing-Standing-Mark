import { getConnectionString } from "@netlify/database";
import { databaseConnectionString } from "../../src/netlify-env.mjs";
import { recoverOneStripeOrder } from "../../src/market-runtime.mjs";

export default async () => {
  const result = await recoverOneStripeOrder({
    databaseUrl: databaseConnectionString(getConnectionString),
  });
  console.log(JSON.stringify({ event: "stripe_recovery", ...result }));
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config = { schedule: "@daily" };
