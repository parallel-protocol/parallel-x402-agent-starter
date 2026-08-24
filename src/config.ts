/**
 * Runtime configuration — read once from the environment, validated, typed.
 *
 * The private key never leaves your machine: it is handed to the payment
 * engine for signing, and this process derives the public address locally.
 */

import type { WrapFetchOptions } from "@parallel-protocol/x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

// viem is the authority on what a valid signing key is — no hand-rolled regex.
const privateKey = (process.env.AGENT_PRIVATE_KEY ?? "0x") as `0x${string}`;
const account = (() => {
	try {
		return privateKeyToAccount(privateKey);
	} catch {
		console.error(
			"❌  AGENT_PRIVATE_KEY missing or invalid — the agent's wallet key (see .env.example)",
		);
		process.exit(1);
	}
})();

export const config = {
	/** The agent's wallet key, passed to the payment engine for signing. */
	privateKey,
	/** The agent's public address, derived locally from the key. */
	agentAddress: account.address,
	/** The x402-enabled API to call. */
	merchantUrl: process.env.MERCHANT_URL ?? "https://api.parallel.best",
	/** The paid route, query string included if the route takes parameters. */
	endpoint: process.env.ENDPOINT ?? "/public/x402/base/snapshot",
	/** Chain to pay on — invoices for any other chain are refused. */
	chain: (process.env.CHAIN ?? "base") as NonNullable<
		WrapFetchOptions["chain"]
	>,
	/**
	 * Force a payment token; omit to let the agent pick from its balances.
	 * Not validated here — the payment engine rejects unknown values cleanly.
	 */
	payWith: process.env.PAY_WITH as WrapFetchOptions["payWith"],
	/** Hard spend cap per request — invoices above it are refused unsigned. */
	maxAmount: process.env.MAX_AMOUNT,
} as const;
