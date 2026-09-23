# Native capital matching — observed results

Observation time: 2026-09-23T17:44:12.731347+00:00.

Request: `ept-internal-use-15000`, the published USD 15,000 WHP internal-use EPT license payment-right funding request. Both purchase and secured advance remain permitted, including partial funding. The retained upstream EPT estate is outside the financing object.

This record summarizes API responses captured in GitHub Actions run 35897635261, job 107305429744, at workflow commit bcb65112f58231a23c6037e928cb344a362b1687. It is not the original API response or an independent verification of on-chain balances. Source run: https://github.com/wheelerhubbellpublishing/Wheeler-Hubbell-Publishing-Standing-Mark/actions/runs/35897635261

## Queries and observations

### Public strategies

GET https://api.pwn.xyz/api/v2/pwn_contracts/thesis/?limit=100 returned HTTP 200, reported count 18, supplied 18 strategy records, and supplied no next page. Response SHA-256: a29c294f2a3b246bd3bfc92cc51bf937ede1ee6a4bde8dfbe6b46fb954c307e6.

The returned strategies identify particular collateral assets: ETH/BTC-related tokens, GNO, sDAI, bCSPX, OP, CELO, and a STRK/ETH strategy on Starknet Sepolia. The testnet strategy is not mainnet funding. None of these returned strategy definitions identifies the WHP EPT license account or a generic facility for all receivables.

### Open offer listing without a chain filter

GET https://api.pwn.xyz/api/v2/pwn_contracts/proposal-and-loan/?isOffer=true&statuses=1&includeLoans=false&includeProposals=true&includeUnverifiedCollateral=true&includeCollateralWithoutPrice=true&includeUnverifiedCredit=true&includeCreditWithoutPrice=true&limit=100 returned HTTP 200. The response reported count 35, supplied 29 records, and supplied no next page. Response SHA-256: 90779a0440dac9d463b9c075901cb845f764434808b1debaaece32c4b286325b.

The 29 returned offer records were marked OPEN, had signature fields, and specified ERC-20 collateral consisting of ETH/BTC-related assets. No returned collateral definition covered the identified WHP payment right. Signature presence is not verification, and no lender balance, allowance, nonce validity, or acceptance simulation was independently checked.

Returned proposal IDs by chain:

- Base: 11638, 11637, 11636, 11635, 11634, 11633, 11372, 11371, 11370, 11369, 11368, 11367.
- Unichain: 11632, 11631.
- Optimism: 11197, 11196, 11195, 11194, 11193, 11158, 11157, 11156, 11155, 11154.
- Polygon: 11161, 11160, 11159.
- Gnosis: 11129, 11128.

All 29 records had a zero-address allowed-acceptor field. That does not remove their specifically identified collateral requirements. An offer open to different borrowers is not an offer against any collateral.

The reported count and returned records disagree. This record therefore does not claim an exhaustive inventory of all PWN offers, even though the response supplied no further pagination.

### Designated borrower filter

The same inclusive open-offer query with borrowerAddress=0xdbb1c7dcf901c9b76e5943c27ad652cfc7f61135 returned HTTP 200, reported and returned zero records, and supplied no next page. Response SHA-256: 0595424161ea863805d9b92c0e52d7aa1e3c46ec58cd8f0d6933759006a5fb74.

This is a filtered search result, not a credit refusal or proof that no future or off-index quote can exist.

## Result and limits

No executable offer for the WHP payment right was identified in these responses. The checked offers do not become offers for EPT collateral through changing the collateral address, buying gas, or minting a different token.

No native financing proposal was submitted, no financing agreement was accepted, and no wallet signature, approval, collateral transfer, loan drawdown, or payment was made. No new hosting was provisioned, no paid upgrade was purchased, and no Standing runtime, custody service, signing key, or database was changed.

The GitHub job's successful completion means these API reads ran and their results were captured. It does not mean financing succeeded. This record adds no financing condition or intermediary.
