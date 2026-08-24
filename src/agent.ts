/**
 * A complete x402 payment agent — this is the file you copy into your project.
 *
 * All the payment logic is one call: `wrapFetchWithPayment` turns fetch into a
 * payment-aware fetch. When an API answers 402 with an invoice, the agent
 * picks a token it holds, signs a gasless EIP-3009 authorization and retries
 * the call with the payment attached. You just use it like fetch.
 *
 * The `show*` helpers are display only — they print the invoice and the
 * decoded on-chain settlement so you can watch the protocol at work. Remove
 * them (and src/display.ts) for a minimal agent.
 */

import { wrapFetchWithPayment } from "@parallel-protocol/x402-fetch";
import { config } from "./config";
import { showInvoice, showRefusal, showSettlement } from "./display";

const payFetch = wrapFetchWithPayment(fetch, {
	privateKey: config.privateKey,
	chain: config.chain,
	payWith: config.payWith,
	maxAmount: config.maxAmount,
});

const url = `${config.merchantUrl}${config.endpoint}`;
console.log(`\n🤖  Agent → GET ${url}`);

const invoice = await showInvoice(url, config.chain);

try {
	const response = await payFetch(url);
	const raw = await response.text();
	let data: unknown = raw;
	try {
		data = JSON.parse(raw);
	} catch {}

	if (!response.ok) {
		console.error(
			`❌  ${response.status}:`,
			typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data),
		);
		process.exit(1);
	}

	await showSettlement(response, config.chain, invoice);
	console.log(`\n📦  Data:`, JSON.stringify(data, null, 2));
} catch (error) {
	showRefusal(error);
}
