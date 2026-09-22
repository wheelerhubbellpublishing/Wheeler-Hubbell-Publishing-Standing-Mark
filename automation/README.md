# WHP autonomous revenue loop

This isolated automation tree publishes two exact-price x402 products, sends one disclosed complimentary EPT invitation per eligible public hostname, and records finalized inbound Base USDC transfers to the WHP receiving address.

It does not alter WHP Standing, hold a signing key, move funds, issue Standing, claim truth, or retry outreach to a hostname.

`whp-autonomous-market` runs `npm run start:market`. The private Railway Cron service runs `npm run run:hourly` every five minutes so paid Stripe work is fulfilled promptly. The carrier still has a durable database gate permitting at most one new invitation every six hours.

The database bootstrap creates isolated schemas and login roles for the public market, the least-privilege Stripe worker, the carrier migration owner, the append-only carrier runtime, and the finalized-settlement observer. The migration owner is returned to `NOLOGIN` after each bootstrap.
