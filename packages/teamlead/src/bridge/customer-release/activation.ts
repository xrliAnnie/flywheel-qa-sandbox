import { createHash } from "node:crypto";
import { parseCustomerReleaseConfig } from "flywheel-config";
import { isDiscordId } from "./notice.js";

function invalid(): never {
	throw new Error("customer release activation identity invalid");
}
function sorted(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
/** Exclude the digest itself and the future receipt id to avoid circular authority.
 * Every actual policy/configuration field, including mode, remains bound. */
export function customerReleasePolicyDigest(value: unknown): string {
	try {
		const config = parseCustomerReleaseConfig(value);
		const {
			policyRevision: _revision,
			founderEnableReceiptId: _receipt,
			...policy
		} = config;
		return hash(JSON.stringify(sorted(policy)));
	} catch {
		invalid();
	}
}

/** Runtime inputs come from canonical owner resolution and trusted deployment
 * configuration. Token values are used only for rotation detection, never stored. */
export function customerReleaseIdentity(input: {
	config: unknown;
	founderId: string | null;
	endpoint: string;
	audience: string;
	env: Record<string, string | undefined>;
}) {
	try {
		const config = parseCustomerReleaseConfig(input.config);
		const policyRevision = customerReleasePolicyDigest(config);
		if (
			config.policyRevision !== policyRevision ||
			!isDiscordId(input.founderId) ||
			!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.audience)
		)
			invalid();
		const endpoint = new URL(input.endpoint);
		if (
			(endpoint.protocol !== "https:" &&
				!(
					endpoint.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
				)) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.pathname !== "/" ||
			endpoint.search ||
			endpoint.hash
		)
			invalid();
		if (!config.bot_token_env || !config.decision_token_env) invalid();
		const bot = input.env[config.bot_token_env],
			decision = input.env[config.decision_token_env];
		if (
			typeof bot !== "string" ||
			typeof decision !== "string" ||
			bot.length < 32 ||
			decision.length < 32 ||
			/[\r\n]/.test(bot) ||
			/[\r\n]/.test(decision) ||
			bot === decision
		)
			invalid();
		const identity = {
			projectId: "flywheel" as const,
			policyRevision,
			founderId: input.founderId,
			endpoint: endpoint.origin,
			audience: input.audience,
			botTokenSha256: hash(bot),
			decisionTokenSha256: hash(decision),
		};
		return {
			...identity,
			identityDigest: hash(JSON.stringify(sorted(identity))),
		};
	} catch {
		invalid();
	}
}
export type CustomerReleaseIdentity = ReturnType<
	typeof customerReleaseIdentity
>;
