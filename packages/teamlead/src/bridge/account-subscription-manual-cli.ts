#!/usr/bin/env node
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexInstallAccountKey } from "flywheel-claude-runner/bin/codex-account-install.mjs";
import { identityKey as claudeIdentityKey } from "../account-heal/account-identity.js";
import {
	defaultStorePath,
	readStoreStrict,
} from "../account-heal/account-store.js";
import {
	AccountSubscriptionManualError,
	defaultAccountSubscriptionManualPath,
	installAccountSubscriptionManual,
	type SubscriptionProvider,
	validateAccountSubscriptionManualInput,
} from "./account-subscription-manual.js";

export interface AccountSubscriptionIdentity {
	provider: SubscriptionProvider;
	profile: string;
	identityKey: string | null;
}

export interface AccountSubscriptionManualCliDeps {
	env?: Record<string, string | undefined>;
	home?: string;
	now?: () => Date;
	readIdentities?: () => readonly AccountSubscriptionIdentity[];
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

function stateDir(
	env: Record<string, string | undefined>,
	home: string,
): string {
	return resolve(env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel"));
}

function defaultIdentities(
	env: Record<string, string | undefined>,
	home: string,
): AccountSubscriptionIdentity[] {
	const identities: AccountSubscriptionIdentity[] = [];
	const claudeStorePath =
		env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH?.trim() ||
		(env === process.env
			? defaultStorePath()
			: join(stateDir(env, home), "claude-accounts.json"));
	const claude = readStoreStrict(claudeStorePath);
	for (const account of claude?.accounts ?? []) {
		identities.push({
			provider: "Claude",
			profile: account.name,
			identityKey:
				account.identity === undefined
					? null
					: createHash("sha256")
							.update(claudeIdentityKey(account.identity))
							.digest("hex"),
		});
	}
	try {
		const canonicalHome = resolve(
			env.FLYWHEEL_CODEX_SOURCE_HOME?.trim() || join(home, ".codex"),
		);
		const pool = loadCodexAccountPool({
			profilesRoot: join(canonicalHome, "profiles"),
		});
		const problems = new Set(pool.problems.map((problem) => problem.name));
		for (const slot of pool.slots) {
			identities.push({
				provider: "Codex",
				profile: slot.name,
				identityKey:
					slot.state === "ready" &&
					slot.identity !== undefined &&
					!problems.has(slot.name)
						? codexInstallAccountKey(slot.identity)
						: null,
			});
		}
	} catch {
		// An unavailable Codex pool contributes no guessed identities.
	}
	return identities.sort(
		(left, right) =>
			left.provider.localeCompare(right.provider, "en-US") ||
			left.profile.localeCompare(right.profile, "en-US"),
	);
}

function identityMap(
	identities: readonly AccountSubscriptionIdentity[],
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		identities.flatMap((identity) =>
			identity.identityKey === null
				? []
				: [[`${identity.provider}:${identity.profile}`, identity.identityKey]],
		),
	);
}

function inputArgument(args: readonly string[]): string | null {
	return args.length === 3 && args[1] === "--input" && args[2]
		? resolve(args[2])
		: null;
}

export async function runAccountSubscriptionManualCli(
	args: readonly string[],
	deps: AccountSubscriptionManualCliDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const now = (deps.now ?? (() => new Date()))();
	const stdout =
		deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
	const stderr =
		deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
	const readIdentities =
		deps.readIdentities ?? (() => defaultIdentities(env, home));
	try {
		if (args.length === 1 && args[0] === "identities") {
			for (const identity of readIdentities()) {
				stdout(
					JSON.stringify({
						provider: identity.provider,
						profile: identity.profile,
						hasIdentity: identity.identityKey !== null,
						identityKey: identity.identityKey,
					}),
				);
			}
			return 0;
		}
		const command = args[0];
		const inputPath = inputArgument(args);
		if (
			(command !== "validate" && command !== "install") ||
			inputPath === null
		) {
			stderr(JSON.stringify({ ok: false, error: "invalid_arguments" }));
			return 2;
		}
		const identities = identityMap(readIdentities());
		const generatedAt = now.toISOString();
		if (command === "validate") {
			const data = validateAccountSubscriptionManualInput({
				inputPath,
				identityKeys: identities,
				generatedAt,
			});
			stdout(
				JSON.stringify({ ok: true, confirmations: data.confirmations.length }),
			);
			return 0;
		}
		const result = await installAccountSubscriptionManual({
			inputPath,
			targetPath: defaultAccountSubscriptionManualPath(env, home),
			stateDir: stateDir(env, home),
			identityKeys: identities,
			generatedAt,
		});
		stdout(JSON.stringify({ ok: true, ...result }));
		return 0;
	} catch (error) {
		stderr(
			JSON.stringify({
				ok: false,
				error:
					error instanceof AccountSubscriptionManualError
						? error.code
						: "operation_failed",
			}),
		);
		return 2;
	}
}

async function main(): Promise<void> {
	process.exitCode = await runAccountSubscriptionManualCli(
		process.argv.slice(2),
	);
}

if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	void main();
}
