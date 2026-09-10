import { chmod, readFile } from "node:fs/promises";
import {
	type CodexQuotaObservation,
	parseCodexRateLimits,
} from "./candidate-selector.js";
import {
	type CandidateIdentity,
	type CandidateWorkspace,
	runIsolatedCodex,
} from "./probe.js";
export interface CodexQuotaReadOptions {
	workspace: CandidateWorkspace;
	binary: string;
	profile: string;
	accountKey: string;
	limitId: string;
	identify: (auth: string) => CandidateIdentity;
	/** Must compare account/read identity with this registered candidate, never the canonical file. */
	accountMatches: (account: unknown) => boolean;
	now?: () => number;
	signal?: AbortSignal;
}
export interface CodexQuotaReadResult {
	observation: CodexQuotaObservation;
	reason:
		| "ok"
		| "identity_mismatch"
		| "refresh_invalid"
		| "observation_unavailable";
	finalAuthPath: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
export async function readCodexQuota(
	options: CodexQuotaReadOptions,
): Promise<CodexQuotaReadResult> {
	const now = options.now ?? Date.now;
	const observation: CodexQuotaObservation = {
		profile: options.profile,
		accountKey: options.accountKey,
		observedAt: now(),
		identityVerified: false,
		authHealth: "unknown",
		windows: [],
		scopeKnown: false,
	};
	let reason: CodexQuotaReadResult["reason"] = "observation_unavailable";
	const result = (): CodexQuotaReadResult => ({
		observation,
		reason,
		finalAuthPath: options.workspace.authPath,
	});
	const matches = (raw: string) => {
		const id = options.identify(raw);
		return (
			id.accountKey === options.accountKey && id.profile === options.profile
		);
	};
	try {
		if (!matches(await readFile(options.workspace.authPath, "utf8"))) {
			reason = "identity_mismatch";
			return result();
		}
		let expected = 1,
			readComplete = false,
			accountVerified = false;
		const processResult = await runIsolatedCodex({
			binary: options.binary,
			workspace: options.workspace,
			timeoutMs: 20_000,
			signal: options.signal,
			args: ["app-server", "-c", 'cli_auth_credentials_store="file"'],
			onSpawn: (child) => {
				child.stdin.write(
					`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "flywheel-quota-reader", version: "1.0.0" } } })}\n`,
				);
			},
			onLine: (line, child) => {
				const message: unknown = JSON.parse(line);
				if (!record(message)) throw new Error("invalid_protocol");
				if (message.id === undefined) return; // app-server notifications are not request results
				if (message.id !== expected) throw new Error("unexpected_response");
				if (message.error) {
					const error = message.error;
					if (
						record(error) &&
						/\b(?:invalid_grant|refresh_token_reused|refresh_token_expired|refresh_token_invalidated|token_revoked)\b/.test(
							`${String(error.code)} ${typeof error.message === "string" ? error.message.slice(0, 4096) : ""}`,
						)
					) {
						observation.authHealth = "refresh_invalid";
						reason = "refresh_invalid";
					}
					child.stdin.end();
					expected = -1;
					return;
				}
				if (expected === 1) {
					expected = 2;
					child.stdin.write(
						`${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: false } })}\n`,
					);
					return;
				}
				if (expected === 2) {
					if (
						!record(message.result) ||
						!options.accountMatches(message.result.account)
					) {
						reason = "identity_mismatch";
						child.stdin.end();
						expected = -1;
						return;
					}
					accountVerified = true;
					expected = 3;
					child.stdin.write(
						`${JSON.stringify({ id: 3, method: "account/rateLimits/read" })}\n`,
					);
					return;
				}
				if (expected === 3) {
					Object.assign(
						observation,
						parseCodexRateLimits(message.result, options.limitId, now()),
					);
					readComplete = true;
					child.stdin.end();
					expected = -1;
				}
			},
		});
		const finalAuth = await readFile(options.workspace.authPath, "utf8");
		await chmod(options.workspace.authPath, 0o600);
		if (!matches(finalAuth)) {
			reason = "identity_mismatch";
			observation.authHealth = "unknown";
			return result();
		}
		if (
			!processResult.failed &&
			processResult.exitCode === 0 &&
			accountVerified &&
			readComplete
		) {
			observation.identityVerified = true;
			observation.authHealth = "valid";
			observation.observedAt = now();
			reason = observation.scopeKnown ? "ok" : "observation_unavailable";
		}
	} catch {
		/* sanitized, bounded diagnostic only; final credentials remain on disk */
	}
	return result();
}
