import { canonical, demand, exactKeys, sha256 } from "./core.mjs";

export const ACQUISITION_VERSION = "WHP-VENDING-ACQUISITION-REQUEST-v1";
export const PRODUCT_ID = "WHP_VENDING";
export const STANDARD_LICENSE = "STANDARD_USE_LICENSE";
const HEX64 = /^[0-9a-fA-F]{64}$/u;
const ACTOR_ID = /^sha256:[0-9a-fA-F]{64}$/u;
const REFERRER_ID = /^whp-ref-[A-Za-z0-9._-]{1,128}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{8,4096}$/u;

export function normalizeAcquisitionRequest(value) {
  exactKeys(value, ["version", "client_reference", "product", "purchaser", "requested_license"], ["referral"]);
  demand(value.version === ACQUISITION_VERSION, "ACQUISITION_VERSION_UNSUPPORTED");
  demand(HEX64.test(value.client_reference), "CLIENT_REFERENCE_INVALID");
  demand(value.product === PRODUCT_ID, "ACQUISITION_PRODUCT_UNSUPPORTED");

  exactKeys(value.purchaser, ["actor_id"]);
  demand(ACTOR_ID.test(value.purchaser.actor_id), "PURCHASER_ACTOR_ID_INVALID");

  exactKeys(value.requested_license, ["type"]);
  demand(value.requested_license.type === STANDARD_LICENSE, "LICENSE_PROFILE_UNSUPPORTED");

  let referral = null;
  if (value.referral !== undefined) {
    exactKeys(value.referral, ["referrer_id", "attribution_token"]);
    demand(REFERRER_ID.test(value.referral.referrer_id), "REFERRER_ID_INVALID");
    demand(TOKEN.test(value.referral.attribution_token), "ATTRIBUTION_TOKEN_INVALID");
    referral = Object.freeze({
      referrer_id: value.referral.referrer_id,
      attribution_token: value.referral.attribution_token,
    });
  }

  return Object.freeze({
    version: ACQUISITION_VERSION,
    client_reference: value.client_reference.toLowerCase(),
    product: PRODUCT_ID,
    purchaser: Object.freeze({ actor_id: value.purchaser.actor_id.toLowerCase() }),
    ...(referral ? { referral } : {}),
    requested_license: Object.freeze({ type: STANDARD_LICENSE }),
  });
}

export function bindAcquisitionQuote(request, catalogEntry, verifiedReferral = null) {
  const normalized = normalizeAcquisitionRequest(request);
  exactKeys(catalogEntry, [
    "product", "edition", "artifact_sha256", "artifact_manifest_sha256",
    "license_profile", "price_atomic", "asset", "network", "pay_to",
  ]);
  demand(catalogEntry.product === PRODUCT_ID, "CATALOG_PRODUCT_MISMATCH", 503);
  demand(catalogEntry.license_profile === normalized.requested_license.type, "CATALOG_LICENSE_MISMATCH", 503);
  demand(HEX64.test(catalogEntry.artifact_sha256), "CATALOG_ARTIFACT_DIGEST_INVALID", 503);
  demand(HEX64.test(catalogEntry.artifact_manifest_sha256), "CATALOG_MANIFEST_DIGEST_INVALID", 503);
  demand(/^[1-9][0-9]*$/u.test(catalogEntry.price_atomic), "CATALOG_PRICE_INVALID", 503);
  demand(/^0x[0-9a-fA-F]{40}$/u.test(catalogEntry.asset), "CATALOG_ASSET_INVALID", 503);
  demand(/^0x[0-9a-fA-F]{40}$/u.test(catalogEntry.pay_to), "CATALOG_PAY_TO_INVALID", 503);
  demand(catalogEntry.network === "eip155:8453", "CATALOG_NETWORK_INVALID", 503);

  if (normalized.referral) {
    demand(verifiedReferral, "REFERRAL_VERIFICATION_REQUIRED");
    demand(verifiedReferral.referrer_id === normalized.referral.referrer_id, "REFERRAL_IDENTITY_MISMATCH");
    demand(verifiedReferral.attribution_token === normalized.referral.attribution_token, "REFERRAL_TOKEN_MISMATCH");
  } else {
    demand(verifiedReferral === null, "UNREQUESTED_REFERRAL");
  }

  const immutable = {
    version: "WHP-VENDING-ACQUISITION-QUOTE-v1",
    product: PRODUCT_ID,
    edition: catalogEntry.edition,
    artifact_sha256: catalogEntry.artifact_sha256.toLowerCase(),
    artifact_manifest_sha256: catalogEntry.artifact_manifest_sha256.toLowerCase(),
    license_profile: catalogEntry.license_profile,
    price_atomic: catalogEntry.price_atomic,
    asset: catalogEntry.asset.toLowerCase(),
    network: catalogEntry.network,
    pay_to: catalogEntry.pay_to.toLowerCase(),
    purchaser_id: normalized.purchaser.actor_id,
    client_reference: normalized.client_reference,
    ...(verifiedReferral ? {
      referral: {
        referrer_id: verifiedReferral.referrer_id,
        credential_id: verifiedReferral.credential_id,
        attribution_token: verifiedReferral.attribution_token,
        compensation_plan: verifiedReferral.compensation_plan,
      },
    } : {}),
  };
  return Object.freeze({
    ...immutable,
    quote_id: sha256({ domain: "WHP-VENDING-ACQUISITION-QUOTE-v1", immutable }),
    request_hash: sha256(normalized),
  });
}

export function acquisitionIdentity(quote) {
  demand(quote?.version === "WHP-VENDING-ACQUISITION-QUOTE-v1", "ACQUISITION_QUOTE_REQUIRED");
  return sha256({ domain: "WHP-VENDING-ACQUISITION-v1", quote: canonical(quote) });
}
