# Parallel x402 Agent Starter

[![CI](https://github.com/parallel-protocol/parallel-x402-agent-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/parallel-protocol/parallel-x402-agent-starter/actions/workflows/ci.yml)

A complete AI agent that **pays for API calls, per call and gasless** — the agent itself is 50 lines of TypeScript.

It talks to any API protected by the [x402 payment protocol](https://www.x402.org/) using Parallel's payment rails: the API answers `402 Payment Required` with an invoice, the agent signs a gasless payment authorization, retries the call, and gets the data. No API keys, no subscriptions, no gas.

```
🤖  Agent → GET /public/x402/base/snapshot

💳  402 invoice received — the merchant accepts:
    · 0.0001 USDp   (18 decimals)
    · 0.0001 USDC   (6 decimals)
    · 0.0001 sUSDp  (18 decimals)

✅  Paid — gas sponsored: yes
    tx: https://basescan.org/tx/0xef67…

🧾  On-chain settlement (base)
    payment : 0.0001 USDC (agent) → 0.0001 USDC (merchant)
    method  : transferWithAuthorization
    gas     : 65231 — 0.00000039 ETH, paid by the relayer (agent: 0)
    USDC         0.0001  agent → merchant

📦  Data: { "tvlUsd": "12500000", … }
```

## How it works

1. **Challenge** — the API rejects the unauthenticated call with `402` and a signed invoice listing every token it accepts, each priced in its own decimals.
2. **Pay** — the agent picks a token it holds, signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) transfer authorization and retries the call with the payment attached. The signature *is* the payment: no approval transaction, no gas, no ETH in the wallet.
3. **Settle** — the API verifies the payment with Parallel's facilitator, serves the data, and the facilitator relays the transaction on-chain (gas sponsored). The response carries a receipt with the transaction hash.

The agent then reads the settlement back **from a public RPC** and prints every token movement — it verifies on-chain instead of trusting the merchant's receipt.

A single API route can be paid with different tokens: pay a USDC-priced route with USDp and the facilitator swaps through Parallel's Parallelizer atomically; pay an sUSDp route with USDp and it deposits into the savings vault — all within the same request.

## Quickstart

Requirements: [Bun](https://bun.sh) ≥ 1.0, and a wallet holding a small amount of USDp, USDC or sUSDp on Base.

The easiest funding path is **USDC on Base** — available from any exchange or bridge; the agent can pay with it directly, and the facilitator converts on the fly when a merchant asks for another token. USDp and sUSDp can be minted from the [Parallel app](https://app.parallel.best). A few cents is plenty: no ETH needed, gas is sponsored.

```bash
git clone https://github.com/parallel-protocol/parallel-x402-agent-starter.git
cd parallel-x402-agent-starter
bun install
cp .env.example .env       # set AGENT_PRIVATE_KEY — the only required variable
bun start
```

That's it — your agent just bought data from an API. Pick another route or token per call, quoting the endpoint when it takes query parameters:

```bash
ENDPOINT=/public/x402/base/savings PAY_WITH=usdc bun start
ENDPOINT="/public/x402/base/quote?operation=mint&collateral=usdc&amount=100" bun start
```

## Try the demo API

The Parallel demo API exists so you can try the **whole payment flow for real** — real invoices, real signatures, real on-chain settlements — without thinking about cost: every route charges **0.0001** of whichever token you pay with, roughly a hundredth of a cent. The price is deliberately symbolic — a production merchant sets real prices with the exact same middleware.

The routes accept different tokens *on purpose*: pay a route with a token the merchant doesn't hold and you'll watch the facilitator convert atomically — a swap, a savings deposit or a redeem — all decoded in your terminal.

Base is the default chain; the `/avalanche/*` and `/hyperevm/*` routes settle the same payment on another chain — set `CHAIN` to match the route:

```bash
CHAIN=avalanche ENDPOINT=/public/x402/avalanche/snapshot bun start
CHAIN=hyperevm  ENDPOINT=/public/x402/hyperevm/snapshot PAY_WITH=susdp bun start
```

| Endpoint | Returns | Accepts |
|---|---|---|
| `GET /public/x402/base/snapshot` | Protocol snapshot (TVL, supplies, APY) | USDp, USDC, sUSDp |
| `GET /public/x402/base/quote?operation=<mint\|redeem>&collateral=<usds\|susds\|usdc>&amount=<n>` | Mint/redeem quote | USDp |
| `GET /public/x402/base/savings` | Savings vault stats | sUSDp |
| `GET /public/x402/base/fees` | Round-trip conversion fee per collateral | USDC |
| `GET /public/x402/base/solvency` | Proof of solvency (reserves vs supply) | USDS |
| `GET /public/x402/avalanche/snapshot` | Same snapshot, settled on **Avalanche** | USDp, USDC, sUSDp |
| `GET /public/x402/hyperevm/snapshot` | Same snapshot, settled on **HyperEVM** | USDp, sUSDp |

Some combinations worth watching:

```bash
ENDPOINT=/public/x402/base/fees    PAY_WITH=usdp  bun start   # merchant wants USDC — atomic swap, surplus refunded
ENDPOINT=/public/x402/base/savings PAY_WITH=usdc  bun start   # merchant wants sUSDp — swap + vault deposit, one tx
ENDPOINT=/public/x402/base/fees    PAY_WITH=susdp bun start   # pay from your savings — redeem + swap, one tx
```

Note: `/quote` requires its query parameters — calling it without them returns a `400` **and nothing is charged** (the payment only settles when the API answers successfully).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_PRIVATE_KEY` | *(required)* | The agent's wallet. Use a dedicated wallet with small funds. |
| `MAX_AMOUNT` | `1` | Hard spend cap per request — invoices above it are refused before signing. |
| `MERCHANT_URL` | `https://api.parallel.best` | The x402-enabled API to call. |
| `ENDPOINT` | `/public/x402/base/snapshot` | The paid route. |
| `CHAIN` | `base` | `base`, `avalanche`, `hyperevm` or `ethereum`. |
| `PAY_WITH` | *(auto)* | Force a token (`usdp`, `usdc`, `susdp`). Omitted, the agent picks from its balances. |

## Safety model

- **Nothing moves without a signature.** Every refusal path (`🛡️ Refused`) happens *before* signing — a refused invoice costs nothing.
- **`MAX_AMOUNT` is enforced client-side** against the invoice's own decimals from a verified token catalog: a merchant cannot re-scale amounts or trick the agent into overpaying.
- **Chain is pinned.** An invoice for a different chain than the one you configured is rejected (`CHAIN_MISMATCH`).
- **The agent never configures who it pays.** Each 402 invoice carries the merchant's receiving address (`payTo`); the signature authorizes exactly one transfer — to that recipient, for that amount, within a time window.

## Troubleshooting

Every `🛡️ Refused` happens **before** anything is signed — a refusal never costs anything.

| Code | Cause | Fix |
|---|---|---|
| `NO_SIGNING_KEY` | `AGENT_PRIVATE_KEY` missing or malformed | Set it in `.env` (0x + 64 hex chars) |
| `AMOUNT_EXCEEDS_MAX` | The invoice asks more than your spend cap | Raise `MAX_AMOUNT` — after checking the price is what you expect |
| `CHAIN_MISMATCH` | The invoice targets a different chain than `CHAIN` | Set `CHAIN` to the merchant's chain (`base`, `avalanche`, `hyperevm`) |
| `INVALID_INVOICE` | The 402 response is malformed or missing fields | Merchant-side issue — nothing to fix on the agent |
| `INSECURE_URL` | The merchant URL is plain `http://` (localhost excepted) | Use `https://` — never send payments over clear HTTP |
| `ENGINE_FAILED` | Payment preparation failed; the message carries the cause | Usually a balance issue (fund the wallet) or a transient RPC error (retry) |
| `ENGINE_TIMEOUT` | Payment preparation exceeded its time budget | Retry — if it persists, check your network |

A `❌ 4xx/5xx` after `✅ Paid` never happens for the payment itself: the merchant only settles the payment when it successfully serves the response. An API error before that (e.g. a 400 on missing query parameters) means nothing was settled and nothing was spent.

## Project layout

```
src/
├── agent.ts     # the agent itself — this is the file you copy
├── config.ts    # environment variables, read once and validated
└── display.ts   # optional: renders the invoice and the decoded settlement
```

`agent.ts` is the whole product: wrap fetch, call the API, read the data. `display.ts` exists so you can *watch* the protocol — the 402 invoice before paying, then the settlement transaction read back from a public RPC (the agent verifies on-chain rather than trusting the merchant's receipt). Delete it and its three calls for a minimal agent.

Everything depends only on published packages: [`@parallel-protocol/x402-fetch`](https://www.npmjs.com/package/@parallel-protocol/x402-fetch) (the payment engine), [`@parallel-protocol/chains`](https://www.npmjs.com/package/@parallel-protocol/chains) (the verified token catalog) and [viem](https://viem.sh).

## Selling instead of buying?

The other side of the protocol — making *your* API payable — is the [`@parallel-protocol/x402`](https://www.npmjs.com/package/@parallel-protocol/x402) middleware (Fastify, Express, Hono and Next.js adapters).

## License

[MIT](./LICENSE)
