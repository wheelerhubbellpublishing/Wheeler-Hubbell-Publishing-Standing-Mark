import { demand, exactKeys, sha256 } from "./core.mjs";

export const REFERRAL_CREDENTIAL_VERSION = "WHP-VENDING-REFERRAL-CREDENTIAL-v1";
export const REFERRAL_AUTHORITY = "REFER_CANONICAL_WHP_VENDING_SALES";
const FORBIDDEN = new Set(["ISSUE_LICENSE", "SUBLICENSE", "ALTER_PRICE", "COLLECT_WHP_PURCHASE_FUNDS", "REPRESENT_SELF_AS_WHP"]);
const REFERRER_ID = /^whp-ref-[A-Za-z0-9._-]{1,128}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{8,4096}$/u;
const PLAN = /^urn:whp:referral-plan:[A-Za-z0-9._-]+-v[0-9]+$/u;

export function verifyReferralCredential(credential, expected, now) {
  demand(Number.isSafeInteger(now) && now >= 0, "REFERRAL_TIME_INVALID", 500);
  exactKeys(credential, [
    "version", "credential_id", "referrer_id", "license_id", "instance_id", "principal",
    "authority", "authority_not_granted", "compensation_plan", "valid_from", "valid_until",
    "status", "attribution_token", "signature_verified",
  ]);
  demand(credential.version === REFERRAL_CREDENTIAL_VERSION, "REFERRAL_VERSION_UNSUPPORTED");
  demand(credential.principal === "WHEELER_HUBBELL_PUBLISHING_INC", "REFERRAL_PRINCIPAL_INVALID");
  demand(credential.signature_verified === true, "REFERRAL_SIGNATURE_INVALID");
  demand(credential.status === "ACTIVE", "REFERRAL_NOT_ACTIVE");
  demand(Number.isSafeInteger(credential.valid_from) && Number.isSafeInteger(credential.valid_until)
    && credential.valid_from <= now && now < credential.valid_until, "REFERRAL_OUTSIDE_VALIDITY");
  demand(REFERRER_ID.test(credential.referrer_id), "REFERRER_ID_INVALID");
  demand(TOKEN.test(credential.attribution_token), "ATTRIBUTION_TOKEN_INVALID");
  demand(PLAN.test(credential.compensation_plan), "REFERRAL_PLAN_INVALID");
  demand(Array.isArray(credential.authority) && credential.authority.length === 1
    && credential.authority[0] === REFERRAL_AUTHORITY, "UNAUTHORIZED_REFERRAL_AUTHORITY");
  demand(Array.isArray(credential.authority_not_granted)
    && [...FORBIDDEN].every((name) => credential.authority_not_granted.includes(name)),
  "REFERRAL_ANTI_COLLAPSE_INVALID");
  demand(expected?.referrer_id === credential.referrer_id, "REFERRAL_IDENTITY_MISMATCH");
  demand(expected?.attribution_token === credential.attribution_token, "REFERRAL_TOKEN_MISMATCH");
  return Object.freeze({
    credential_id: credential.credential_id,
    referrer_id: credential.referrer_id,
    license_id: credential.license_id,
    instance_id: credential.instance_id,
    attribution_token: credential.attribution_token,
    compensation_plan: credential.compensation_plan,
  });
}

export function calculateReferralPayable({ saleId, referrer, purchaserId, grossSaleAmount, asset, rateNumerator = 30, rateDenominator = 100 }) {
  demand(typeof saleId === "string" && saleId.length > 0, "SALE_ID_INVALID");
  demand(referrer?.referrer_id && referrer?.compensation_plan, "VERIFIED_REFERRER_REQUIRED");
  demand(typeof purchaserId === "string" && purchaserId.length > 0, "PURCHASER_ID_INVALID");
  demand(/^[1-9][0-9]*$/u.test(grossSaleAmount), "GROSS_SALE_AMOUNT_INVALID");
  demand(/^0x[0-9a-fA-F]{40}$/u.test(asset), "COMPENSATION_ASSET_INVALID");
  demand(Number.isSafeInteger(rateNumerator) && Number.isSafeInteger(rateDenominator)
    && rateNumerator >= 0 && rateDenominator > 0 && rateNumerator <= rateDenominator, "REFERRAL_RATE_INVALID");
  const gross = BigInt(grossSaleAmount);
  const amount = gross * BigInt(rateNumerator) / BigInt(rateDenominator);
  demand(amount > 0n, "REFERRAL_COMPENSATION_ZERO");
  const record = {
    version: "WHP-REFERRAL-SALE-ATTRIBUTION-v1",
    sale_id: saleId,
    referrer_id: referrer.referrer_id,
    purchaser_id: purchaserId,
    gross_sale_amount: grossSaleAmount,
    compensation_plan: referrer.compensation_plan,
    compensation_basis: "QUALIFIED_COMPLETED_SOFTWARE_SALE",
    compensation_amount: amount.toString(),
    compensation_asset: asset.toLowerCase(),
    status: "PAYABLE",
  };
  return Object.freeze({ ...record, attribution_id: sha256({ domain: "WHP-REFERRAL-ATTRIBUTION-v1", record }) });
}
