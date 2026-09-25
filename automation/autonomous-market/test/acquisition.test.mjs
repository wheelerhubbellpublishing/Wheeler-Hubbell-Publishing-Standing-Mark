import test from "node:test";
import assert from "node:assert/strict";
import { acquisitionIdentity, bindAcquisitionQuote, normalizeAcquisitionRequest } from "../src/acquisition.mjs";

const request = {
  version: "WHP-VENDING-ACQUISITION-REQUEST-v1",
  client_reference: "AA".repeat(32),
  product: "WHP_VENDING",
  purchaser: { actor_id: `sha256:${"BB".repeat(32)}` },
  referral: { referrer_id: "whp-ref-992", attribution_token: "token_12345678" },
  requested_license: { type: "STANDARD_USE_LICENSE" },
};
const referrer = {
  credential_id: "cred-1", referrer_id: "whp-ref-992", attribution_token: "token_12345678",
  compensation_plan: "urn:whp:referral-plan:standard-v1",
};
const catalog = {
  product: "WHP_VENDING", edition: "1.0", artifact_sha256: "11".repeat(32),
  artifact_manifest_sha256: "22".repeat(32), license_profile: "STANDARD_USE_LICENSE",
  price_atomic: "100000000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  network: "eip155:8453", pay_to: "0x1050eddd8282623b0c263ed6bdbd42370bbc28d3",
};

test("acquisition normalization is strict and canonical", () => {
  const normalized = normalizeAcquisitionRequest(request);
  assert.equal(normalized.client_reference, "aa".repeat(32));
  assert.equal(normalized.purchaser.actor_id, `sha256:${"bb".repeat(32)}`);
  assert.throws(() => normalizeAcquisitionRequest({ ...request, extra: true }), /OBJECT_FIELDS_INVALID/u);
  assert.throws(() => normalizeAcquisitionRequest({ ...request, product: "OTHER" }), /ACQUISITION_PRODUCT_UNSUPPORTED/u);
});

test("quote binds exact artifact, purchaser, price, settlement destination and referral", () => {
  const quote = bindAcquisitionQuote(request, catalog, referrer);
  assert.equal(quote.artifact_sha256, catalog.artifact_sha256);
  assert.equal(quote.price_atomic, "100000000");
  assert.equal(quote.referral.referrer_id, "whp-ref-992");
  assert.match(quote.quote_id, /^[0-9a-f]{64}$/u);
  assert.match(acquisitionIdentity(quote), /^[0-9a-f]{64}$/u);
});

test("referral cannot be attached, removed or substituted during quote binding", () => {
  assert.throws(() => bindAcquisitionQuote(request, catalog, null), /REFERRAL_VERIFICATION_REQUIRED/u);
  assert.throws(() => bindAcquisitionQuote(request, catalog, { ...referrer, referrer_id: "whp-ref-other" }), /REFERRAL_IDENTITY_MISMATCH/u);
  const noReferral = { ...request }; delete noReferral.referral;
  assert.throws(() => bindAcquisitionQuote(noReferral, catalog, referrer), /UNREQUESTED_REFERRAL/u);
});
