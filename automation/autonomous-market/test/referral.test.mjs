import test from "node:test";
import assert from "node:assert/strict";
import { calculateReferralPayable, verifyReferralCredential } from "../src/referral.mjs";

const expected = { referrer_id: "whp-ref-992", attribution_token: "token_12345678" };
const credential = {
  version: "WHP-VENDING-REFERRAL-CREDENTIAL-v1", credential_id: "cred-1",
  referrer_id: "whp-ref-992", license_id: "lic-1", instance_id: "inst-1",
  principal: "WHEELER_HUBBELL_PUBLISHING_INC",
  authority: ["REFER_CANONICAL_WHP_VENDING_SALES"],
  authority_not_granted: ["ISSUE_LICENSE","SUBLICENSE","ALTER_PRICE","COLLECT_WHP_PURCHASE_FUNDS","REPRESENT_SELF_AS_WHP"],
  compensation_plan: "urn:whp:referral-plan:standard-v1",
  valid_from: 100, valid_until: 200, status: "ACTIVE", attribution_token: "token_12345678",
  signature_verified: true,
};

test("referral credential preserves referral-only authority", () => {
  const verified = verifyReferralCredential(credential, expected, 150);
  assert.equal(verified.referrer_id, expected.referrer_id);
  assert.equal(verified.compensation_plan, credential.compensation_plan);
});

test("issuance, collection, inactive, unsigned and substituted referral credentials fail closed", () => {
  assert.throws(() => verifyReferralCredential({ ...credential, authority: ["ISSUE_LICENSE"] }, expected, 150), /UNAUTHORIZED_REFERRAL_AUTHORITY/u);
  assert.throws(() => verifyReferralCredential({ ...credential, authority_not_granted: [] }, expected, 150), /REFERRAL_ANTI_COLLAPSE_INVALID/u);
  assert.throws(() => verifyReferralCredential({ ...credential, status: "REVOKED" }, expected, 150), /REFERRAL_NOT_ACTIVE/u);
  assert.throws(() => verifyReferralCredential({ ...credential, signature_verified: false }, expected, 150), /REFERRAL_SIGNATURE_INVALID/u);
  assert.throws(() => verifyReferralCredential(credential, { ...expected, attribution_token: "other_token" }, 150), /REFERRAL_TOKEN_MISMATCH/u);
});

test("qualified sale creates a separate payable amount, never a paid state", () => {
  const referrer = verifyReferralCredential(credential, expected, 150);
  const payable = calculateReferralPayable({
    saleId: "sale-1", referrer, purchaserId: "sha256:" + "aa".repeat(32),
    grossSaleAmount: "100000000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  });
  assert.equal(payable.compensation_amount, "30000000");
  assert.equal(payable.status, "PAYABLE");
  assert.match(payable.attribution_id, /^[0-9a-f]{64}$/u);
});
