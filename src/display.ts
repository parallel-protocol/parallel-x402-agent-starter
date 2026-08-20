/**
 * Console output for the demo agent — none of it is part of the payment flow.
 *
 * Three views of one payment:
 *   - showInvoice():    the 402 invoice, decoded before anything is signed
 *   - showSettlement(): the payment receipt, then the settlement transaction
 *                       read back from a public RPC — method, gas sponsorship
 *                       and every token movement, fully decoded
 *   - showRefusal():    payer-guard refusals (nothing signed, nothing spent)
 *
 * The agent never trusts the merchant's account of the payment: everything in
 * showSettlement() is read from the chain. Delete this file (and its calls in
 * agent.ts) if all you want is the payment itself.
 */

import {
	COLLATERAL_TOKENS,
	getParallelizerAddress,
	getSUSDpAddress,
	getTokenDecimals,
	getUSDCAddress,
	getUSDpAddress,
} from "@parallel-protocol/chains";
import {
	MULTICALL3_ABI,
	PARALLELIZER_ABI,
	SUSDP_ABI,
	USDC_EIP3009_ABI,
	USDP_EIP3009_ABI,
} from "@parallel-protocol/chains/abi";
import {
	decodePaymentResponse,
	X402FetchError,
} from "@parallel-protocol/x402-fetch";
import {
	type Abi,
	type Address,
	createPublicClient,
	decodeFunctionData,
	formatEther,
	formatUnits,
	type Hex,
	http,
} from "viem";
import { avalanche, base, hyperEvm, mainnet } from "viem/chains";
import { config } from "./config";

// ─── Chain + token catalogs ──────────────────────────────────────────────────

const CHAINS = {
	ethereum: { viem: mainnet, explorer: "https://etherscan.io" },
	base: { viem: base, explorer: "https://basescan.org" },
	avalanche: { viem: avalanche, explorer: "https://snowtrace.io" },
	hyperevm: { viem: hyperEvm, explorer: "https://hyperevmscan.io" },
} as const;

type ChainConfig = (typeof CHAINS)[keyof typeof CHAINS];

// Honest lookup: the cast is only taken on keys proven to exist.
function chainConfigOf(chain: string): ChainConfig | undefined {
	return Object.hasOwn(CHAINS, chain)
		? CHAINS[chain as keyof typeof CHAINS]
		: undefined;
}

const COMBINED_ABI = [
	...USDP_EIP3009_ABI,
	...USDC_EIP3009_ABI,
	...SUSDP_ABI,
	...PARALLELIZER_ABI,
	...MULTICALL3_ABI,
] as Abi;

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
	"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function tokenInfo(
	chain: string,
	address: string,
): { symbol: string; decimals: number } {
	const lower = address.toLowerCase();
	if (getUSDpAddress(chain)?.toLowerCase() === lower)
		return { symbol: "USDp", decimals: 18 };
	if (getSUSDpAddress(chain)?.toLowerCase() === lower)
		return { symbol: "sUSDp", decimals: 18 };
	if (getUSDCAddress(chain)?.toLowerCase() === lower)
		return { symbol: "USDC", decimals: 6 };
	// The catalog is keyed per known chain; widening lets us index with a
	// runtime chain slug and fall through cleanly when it is not covered.
	const collateral = (
		COLLATERAL_TOKENS as Record<
			string,
			Record<string, { symbol: string; decimals: number }>
		>
	)[chain]?.[lower];
	if (collateral) return collateral;
	return {
		symbol: `${address.slice(0, 8)}…`,
		decimals: getTokenDecimals(chain, address as Address) ?? 18,
	};
}

// ─── The 402 invoice ─────────────────────────────────────────────────────────

export type Invoice = {
	payTo: Address;
	accepts: { asset: string; amount: bigint; decimals: number }[];
};

type WireAccept = {
	asset: string;
	amount: string;
	payTo: string;
	extra?: { decimals?: number };
};

/**
 * Fetches the URL without a payment and prints the decoded 402 invoice.
 * Free by construction: nothing is signed until the paid retry.
 * Returns the invoice so showSettlement() can compare it with what arrived.
 */
export async function showInvoice(
	url: string,
	chain: string,
): Promise<Invoice | undefined> {
	let header: string | null;
	try {
		const probe = await fetch(url);
		if (probe.status !== 402) return undefined;
		header = probe.headers.get("payment-required");
	} catch {
		return undefined; // unreachable merchant — payFetch will surface the error
	}
	if (!header) return undefined;

	let wire: { accepts?: WireAccept[] };
	try {
		wire = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
	if (!wire.accepts?.length) return undefined;

	console.log(`\n💳  402 invoice received — the merchant accepts:`);
	const accepts: Invoice["accepts"] = [];
	for (const accept of wire.accepts) {
		const { symbol } = tokenInfo(chain, accept.asset);
		const decimals = accept.extra?.decimals ?? 18;
		accepts.push({
			asset: accept.asset.toLowerCase(),
			amount: BigInt(accept.amount),
			decimals,
		});
		console.log(
			`    · ${formatUnits(BigInt(accept.amount), decimals)} ${symbol.padEnd(6)} (${decimals} decimals)`,
		);
	}
	console.log(`    → payTo ${wire.accepts[0]!.payTo}`);
	return { payTo: wire.accepts[0]!.payTo as Address, accepts };
}

// ─── The settlement, read back from the chain ────────────────────────────────

/**
 * Prints the payment receipt, then decodes the settlement transaction from a
 * public RPC: what the agent paid, what the merchant received, the contract
 * method, the sponsored gas, and every token movement — annotated.
 */
export async function showSettlement(
	response: Response,
	chain: string,
	invoice: Invoice | undefined,
): Promise<void> {
	const receipt = decodePaymentResponse(response);
	if (!receipt) return;

	const chainConfig = chainConfigOf(chain);
	console.log(
		`\n✅  Paid — gas sponsored: ${receipt.gasSponsored ? "yes" : "no"}`,
	);
	console.log(
		`    tx: ${(chainConfig ?? CHAINS.base).explorer}/tx/${receipt.txHash}`,
	);
	if (!chainConfig) return;

	try {
		await describeSettlement(
			chain,
			chainConfig,
			receipt.txHash as Hex,
			invoice,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.log(`    (settlement decoding unavailable: ${reason})`);
	}
}

async function describeSettlement(
	chain: string,
	{ viem }: ChainConfig,
	hash: Hex,
	invoice: Invoice | undefined,
): Promise<void> {
	const client = createPublicClient({ chain: viem, transport: http() });
	const [tx, receipt] = await Promise.all([
		client.getTransaction({ hash }),
		client.getTransactionReceipt({ hash }),
	]);

	// Address book: agent from config, merchant from the invoice, the rest from
	// the on-chain catalog. Anything else prints as a shortened address.
	const labels: Record<string, string> = {
		[config.agentAddress.toLowerCase()]: "agent",
		[tx.from.toLowerCase()]: "relayer",
	};
	if (invoice) labels[invoice.payTo.toLowerCase()] = "merchant";
	const parallelizer = getParallelizerAddress(chain);
	if (parallelizer) labels[parallelizer.toLowerCase()] = "Parallelizer";
	const vault = getSUSDpAddress(chain)?.toLowerCase();
	if (vault) labels[vault] = "vault sUSDp";
	const who = (address: string) => labels[address] ?? `${address.slice(0, 8)}…`;

	const transfers = receipt.logs
		.filter((log) => log.topics[0] === TRANSFER_TOPIC && log.topics.length >= 3)
		.map((log) => ({
			from: `0x${log.topics[1]!.slice(26)}`.toLowerCase(),
			to: `0x${log.topics[2]!.slice(26)}`.toLowerCase(),
			token: log.address.toLowerCase(),
			amount: BigInt(log.data === "0x" ? 0 : log.data),
			...tokenInfo(chain, log.address),
		}));

	// "What did the agent pay, what did the merchant receive". Mints and burns
	// are never the payment itself (e.g. vault yield accrual), so the fallbacks
	// used when a label is missing skip them.
	const agent = config.agentAddress.toLowerCase();
	const merchant = invoice?.payTo.toLowerCase();
	const paid =
		transfers.find((t) => t.from === agent) ??
		transfers.find((t) => t.from !== ZERO_ADDRESS);
	const received =
		transfers.findLast((t) => merchant && t.to === merchant) ??
		transfers.findLast((t) => t.to !== ZERO_ADDRESS && t.to !== vault);

	console.log(`\n🧾  On-chain settlement (${chain})`);
	if (paid && received) {
		console.log(
			`    payment : ${formatUnits(paid.amount, paid.decimals)} ${paid.symbol} (agent) → ${formatUnits(received.amount, received.decimals)} ${received.symbol} (merchant)`,
		);
		// The invoice is a guaranteed MINIMUM: on routes where the exchange rate
		// can move between quote and execution, the payer funds a small buffer
		// so the merchant is never underpaid. Surface it when it lands.
		const invoiced = invoice?.accepts.find((a) => a.asset === received.token);
		if (invoiced && received.amount > invoiced.amount) {
			const extra = received.amount - invoiced.amount;
			console.log(
				`    note    : +${formatUnits(extra, received.decimals)} ${received.symbol} over the invoice — payer-funded slippage buffer (the invoice is a guaranteed minimum)`,
			);
		}
	}
	console.log(`    method  : ${methodName(tx.input)}`);
	const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
	console.log(
		`    gas     : ${receipt.gasUsed} — ${formatEther(gasCost)} ${viem.nativeCurrency.symbol}, paid by the relayer (agent: 0)`,
	);

	for (const t of transfers) {
		const fromLabel = t.from === ZERO_ADDRESS ? "mint" : who(t.from);
		const toLabel = t.to === ZERO_ADDRESS ? "burn" : who(t.to);
		let note = "";
		if (t.symbol === "USDp" && t.from === ZERO_ADDRESS && t.to === vault) {
			// USDp minted straight into the vault is the savings yield accruing
			// for ALL sUSDp holders — triggered by this interaction, unrelated to it.
			note =
				"  (vault yield accrual for all sUSDp holders — not part of this payment)";
		} else if (who(t.from) === "Parallelizer" && who(t.to) === "agent") {
			// Exact-output swaps pull maxAmountIn then return what was not needed.
			note = "  (unused slippage buffer refunded)";
		}
		console.log(
			`    ${t.symbol.padEnd(10)} ${formatUnits(t.amount, t.decimals).padStart(12)}  ${fromLabel} → ${toLabel}${note}`,
		);
	}
}

function methodName(input: Hex): string {
	try {
		const { functionName, args } = decodeFunctionData({
			abi: COMBINED_ABI,
			data: input,
		});
		if (functionName !== "aggregate3") return functionName;
		const calls = (args?.[0] ?? []) as { callData: Hex }[];
		const inner = calls.map((call) => {
			try {
				return decodeFunctionData({ abi: COMBINED_ABI, data: call.callData })
					.functionName;
			} catch {
				return "?";
			}
		});
		return `aggregate3 → [${inner.join(" + ")}]`;
	} catch {
		return `selector ${input.slice(0, 10)}`;
	}
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * Payer-guard refusals happen BEFORE anything is signed: a refused invoice
 * costs nothing. Anything else is unexpected and rethrown.
 */
export function showRefusal(error: unknown): never {
	if (error instanceof X402FetchError) {
		console.error(`🛡️   Refused [${error.code}]: ${error.message}`);
		if (error.engineCode) console.error(`    engine: ${error.engineCode}`);
		if (error.hint) console.error(`    hint: ${error.hint}`);
		process.exit(1);
	}
	throw error;
}
