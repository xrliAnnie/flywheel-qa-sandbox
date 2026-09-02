import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CandidatePanoramaEntry,
	CandidateSelectionOptions,
	CandidateSelectionResult,
	CandidateSnapshot,
} from "./account-candidate-selector.js";
import { verifyAndRankCandidates } from "./account-candidate-selector.js";
import { readStoreStrict, recordObservationInStore } from "./account-store.js";
import {
	withAccountsLock as acquireAccountsLock,
	reconcileTransitionJournal,
} from "./accounts-lock.js";
import {
	claudeProfileBinPath,
	makeClaudeProfileSwitchDeps,
	reconcileClaudeProfile,
} from "./claude-profile-cli.js";
import { verifyPoolCredential } from "./freshness.js";
import { appendManualSwitchFailureAudit } from "./manual-switch-audit.js";
import type { QuotaMonitorAlert } from "./quota-monitor.js";
import {
	type DeliveryReport,
	sendQuotaMonitorAlert,
} from "./quota-monitor-alert.js";
import { loadQuotaMonitorConfig } from "./quota-monitor-config.js";
import {
	listPoolAccounts,
	readKeychainMonitorCredential,
	readPoolMonitorCredential,
	readPoolProfileIdentity,
} from "./quota-monitor-credentials.js";
import { defaultQuotaMonitorPaths } from "./quota-monitor-runtime.js";
import { fetchAccountUsage } from "./quota-usage-api.js";
import type {
	ManualEligibilityOverrides,
	SwitchInput,
	SwitchResult,
} from "./switch-executor.js";
import { switchAccount as executeSwitch } from "./switch-executor.js";

const PROFILE_LABEL = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MANUAL_FAILURE_DETAIL_LENGTH = 2048;

export interface AccountSwitchCliDeps {
	now: () => number;
	trigger5hPct: number;
	readSnapshot: () => Promise<CandidateSnapshot>;
	selectCandidates: (
		snapshot: CandidateSnapshot,
		options: CandidateSelectionOptions,
	) => Promise<CandidateSelectionResult>;
	switchAccount: (input: SwitchInput) => Promise<SwitchResult>;
	readIdentity: (name: string) => Promise<{ email?: string } | null>;
	sendAlert: (alert: QuotaMonitorAlert) => Promise<DeliveryReport>;
	reconcile: () => Promise<boolean>;
	auditFailure?: (input: {
		command: "use" | "next";
		profile: string | null;
		reasonCode: string;
		reason: string;
	}) => void | Promise<void>;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

type ManualCommand =
	| { mode: "use"; target: string }
	| { mode: "next"; target?: never };

function parseCommand(args: readonly string[]): ManualCommand | null {
	if (args[0] === "next" && args.length === 1) return { mode: "next" };
	if (
		args[0] === "use" &&
		args.length === 2 &&
		typeof args[1] === "string" &&
		PROFILE_LABEL.test(args[1])
	) {
		return { mode: "use", target: args[1] };
	}
	return null;
}

function panoramaSummary(panorama: readonly CandidatePanoramaEntry[]): string {
	return [...panorama]
		.sort((a, b) => a.name.localeCompare(b.name, "en-US"))
		.map((entry) => `${entry.name}:${entry.status}`)
		.join(",");
}

function manualFailureDetail(reason: string): string {
	const normalized = Array.from(
		reason.replace(/[\r\n]+/g, " | "),
		(character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127 ? " " : character;
		},
	)
		.join("")
		.trim();
	if (normalized.length === 0) return "unspecified switch failure";
	return normalized.length > MAX_MANUAL_FAILURE_DETAIL_LENGTH
		? `…${normalized.slice(-(MAX_MANUAL_FAILURE_DETAIL_LENGTH - 1))}`
		: normalized;
}

function manualOverrides(
	selection: CandidateSelectionResult,
): ManualEligibilityOverrides | undefined {
	const byName = new Map(
		selection.panorama.map((entry) => [entry.name, entry]),
	);
	const overrides = new Map<string, { ignoreCooldown: boolean }>();
	for (const name of selection.ranked) {
		const bypassed = byName.get(name)?.bypassed;
		if (bypassed?.cooldown !== true) continue;
		overrides.set(name, {
			ignoreCooldown: true,
		});
	}
	return overrides.size === 0 ? undefined : overrides;
}

async function runAttempt(
	command: ManualCommand,
	deps: AccountSwitchCliDeps,
): Promise<{ result: SwitchResult | null; exitCode?: number }> {
	const snapshot = await deps.readSnapshot();
	if (
		command.mode === "use" &&
		snapshot.activeName !== null &&
		command.target === snapshot.activeName
	) {
		deps.stdout(
			`Machine Claude account is already profile '${command.target}'`,
		);
		return { result: null, exitCode: 0 };
	}

	const options: CandidateSelectionOptions =
		command.mode === "use"
			? {
					onlyNames: [command.target],
					cooldownPolicy: "ignore_explicit_target",
					headroomPolicy: { kind: "explicit_target" },
				}
			: {
					cooldownPolicy: "exclude",
					headroomPolicy: {
						kind: "prefer_below_trigger",
						trigger5hPct: deps.trigger5hPct,
					},
				};
	const selection = await deps.selectCandidates(snapshot, options);
	if (selection.ranked.length === 0) {
		const panorama = panoramaSummary(selection.panorama);
		try {
			await deps.sendAlert({
				kind: "quota_no_target",
				severity: "severe",
				title: "No live Claude account is available for manual switching",
				body: `trigger=manual:${command.mode}; ${panorama || "no candidates"}`,
				signature: `manual-account-switch-no-target-${command.mode}-${new Date(deps.now()).toISOString().slice(0, 10)}`,
			});
		} catch {
			deps.stderr("FLYWHEEL_MANUAL_NO_TARGET_ALERT_PENDING");
		}
		deps.stderr(`FLYWHEEL_MANUAL_NO_TARGET ${panorama || "no candidates"}`);
		return { result: null, exitCode: 32 };
	}

	const identityByName = new Map<string, { email?: string }>();
	await Promise.all(
		[...new Set([snapshot.activeName, ...selection.ranked])]
			.filter((name): name is string => name !== null)
			.map(async (name) => {
				try {
					const identity = await deps.readIdentity(name);
					identityByName.set(
						name,
						identity?.email === undefined ? {} : { email: identity.email },
					);
				} catch {
					identityByName.set(name, {});
				}
			}),
	);
	const overrides = manualOverrides(selection);
	const result = await deps.switchAccount({
		trigger: { kind: "manual", mode: command.mode },
		observedAccount: snapshot.activeName ?? "",
		observedGeneration: snapshot.store.generation,
		now: new Date(deps.now()),
		preferredOrder: selection.ranked,
		verifiedAt: selection.verifiedAt,
		quotaPreverified: true,
		...(overrides === undefined ? {} : { manualOverrides: overrides }),
		notificationContext: {
			usageByName: selection.usageByName,
			identityByName,
			panorama: selection.panorama,
			headroomDegraded: selection.headroomDegraded,
		},
	});
	return { result };
}

export async function runAccountSwitchCli(
	args: readonly string[],
	deps: AccountSwitchCliDeps,
): Promise<number> {
	const command = parseCommand(args);
	if (command === null) {
		deps.stderr("Usage: flywheel-claude-switch use <name> | next");
		return 2;
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const { result, exitCode } = await runAttempt(command, deps);
		if (exitCode !== undefined) return exitCode;
		if (result === null) return 0;
		if (result.outcome === "switched") {
			deps.stdout(
				`Switched machine Claude account: ${result.from} → ${result.to}`,
			);
			if (result.notification === "pending") {
				deps.stderr(
					"FLYWHEEL_SWITCH_NOTIFICATION_PENDING: switch committed; notification will replay on the next account-heal tick",
				);
			}
			return 0;
		}
		if (
			result.outcome === "noop_already_switched" ||
			result.outcome === "noop_reconciled"
		) {
			deps.stdout(
				`Machine Claude account is already profile '${result.activeAccount}'`,
			);
			return 0;
		}
		if (
			result.outcome === "failed" &&
			result.reasonCode === "active_marker_drift"
		) {
			if (attempt === 1) {
				deps.stderr("FLYWHEEL_MANUAL_RECONCILE_RACE");
				return 1;
			}
			if (!(await deps.reconcile())) {
				deps.stderr("FLYWHEEL_MANUAL_RECONCILE_FAILED");
				return 1;
			}
			continue;
		}
		const reasonCode = result.reasonCode;
		if (result.outcome === "failed") {
			const detail = manualFailureDetail(result.reason);
			if (result.applyProfileChildStarted !== true) {
				try {
					await deps.auditFailure?.({
						command: command.mode,
						profile: command.mode === "use" ? command.target : null,
						reasonCode,
						reason: detail,
					});
				} catch {
					deps.stderr("FLYWHEEL_MANUAL_SWITCH_AUDIT_FAILED");
				}
			}
			deps.stderr(
				`FLYWHEEL_MANUAL_SWITCH_FAILED reason=${reasonCode} details=${detail}`,
			);
		} else {
			deps.stderr(`FLYWHEEL_MANUAL_SWITCH_FAILED reason=${reasonCode}`);
		}
		if (reasonCode === "notification_outbox_full") {
			deps.stderr(
				"Recovery: restore notification delivery and run the quota monitor once before retrying the switch.",
			);
		}
		return result.outcome === "no_account" ? 32 : 1;
	}
	return 1;
}

function decodeDoubleQuoted(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		if (character !== "\\") {
			result += character;
			continue;
		}
		index += 1;
		if (index >= value.length) throw new Error("malformed double-quoted value");
		const escaped = value[index]!;
		result +=
			escaped === "n"
				? "\n"
				: escaped === "r"
					? "\r"
					: escaped === "t"
						? "\t"
						: escaped === '"' || escaped === "\\"
							? escaped
							: (() => {
									throw new Error("unsupported escape");
								})();
	}
	return result;
}

function parseDotEnvAssignmentsInternal(
	raw: string,
	rejectEveryDuplicate: boolean,
	allowedNames?: ReadonlySet<string>,
): { parsed: Record<string, string>; duplicates: Set<string> } {
	const parsed: Record<string, string> = {};
	const duplicates = new Set<string>();
	for (const [index, source] of raw.split(/\r?\n/).entries()) {
		let line = source.trim();
		if (line === "" || line.startsWith("#")) continue;
		line = line.replace(/^export\s+/, "");
		const equals = line.indexOf("=");
		if (equals <= 0) {
			const candidateName = line.split(/\s+/, 1)[0] ?? "";
			if (allowedNames !== undefined && !allowedNames.has(candidateName)) {
				continue;
			}
			throw new Error(`malformed dotenv line ${index + 1}`);
		}
		const name = line.slice(0, equals).trim();
		if (!ENV_NAME.test(name)) {
			if (allowedNames !== undefined && !allowedNames.has(name)) continue;
			throw new Error(`invalid dotenv key at line ${index + 1}`);
		}
		if (allowedNames !== undefined && !allowedNames.has(name)) continue;
		if (Object.hasOwn(parsed, name)) {
			duplicates.add(name);
			if (rejectEveryDuplicate) {
				throw new Error(`duplicate dotenv key at line ${index + 1}`);
			}
		}
		const encoded = line.slice(equals + 1).trim();
		if (/\$|`/.test(encoded)) {
			throw new Error(`dotenv expansion is forbidden at line ${index + 1}`);
		}
		let value: string;
		if (encoded.startsWith("'")) {
			if (!encoded.endsWith("'") || encoded.length < 2) {
				throw new Error(`malformed single quote at line ${index + 1}`);
			}
			value = encoded.slice(1, -1);
		} else if (encoded.startsWith('"')) {
			if (!encoded.endsWith('"') || encoded.length < 2) {
				throw new Error(`malformed double quote at line ${index + 1}`);
			}
			value = decodeDoubleQuoted(encoded.slice(1, -1));
		} else {
			if (/['"]/.test(encoded)) {
				throw new Error(`malformed plain value at line ${index + 1}`);
			}
			value = encoded;
		}
		parsed[name] = value;
	}
	return { parsed, duplicates };
}

/** Parse data-only dotenv assignments. No shell expansion or commands exist. */
export function parseDotEnvAssignments(raw: string): Record<string, string> {
	return parseDotEnvAssignmentsInternal(raw, true).parsed;
}

function dotenvCandidateName(source: string): string | null {
	let line = source.trim();
	if (line === "" || line.startsWith("#")) return null;
	line = line.replace(/^export\s+/, "");
	const equals = line.indexOf("=");
	return equals <= 0
		? (line.split(/\s+/, 1)[0] ?? null)
		: line.slice(0, equals).trim();
}

function parseAllowedDotEnvAssignments(
	raw: string,
	allowedNames: ReadonlySet<string>,
): Record<string, string> {
	const parsed: Record<string, string> = {};
	const seen = new Set<string>();
	for (const source of raw.split(/\r?\n/)) {
		const name = dotenvCandidateName(source);
		if (name === null || !allowedNames.has(name)) continue;
		if (seen.has(name)) {
			delete parsed[name];
			continue;
		}
		seen.add(name);
		try {
			const assignment = parseDotEnvAssignmentsInternal(
				source,
				true,
				allowedNames,
			).parsed;
			if (Object.hasOwn(assignment, name)) parsed[name] = assignment[name]!;
		} catch {
			// Alert configuration is supplemental. Unsafe or malformed values stay
			// unset so notification delivery can report config_error after switching.
			delete parsed[name];
		}
	}
	return parsed;
}

const ALERT_ENV_ALLOWLIST = [
	"FLYWHEEL_NOTIFY_CHANNEL",
	"FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID",
	"FLYWHEEL_ALERT_SENDER_TOKEN_ENV",
	"FLYWHEEL_CLAIMS_DB",
	"FLYWHEEL_PROJECTS_FILE",
	"FLYWHEEL_ALERT_QUEUE_DIR",
	"FLYWHEEL_ALERT_DEADLETTER_DIR",
	"FLYWHEEL_ALERT_RATE_PER_MIN",
	"FLYWHEEL_QUOTA_ALERT_MENTION_USER",
	"FLYWHEEL_FOUNDER_USER_ID",
	"FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID",
] as const;

function usableEnvValue(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Supplement only the notification identity/routing allowlist from .env. */
export function loadAlertIdentityEnv(
	opts: { baseEnv?: NodeJS.ProcessEnv; envPath?: string } = {},
): NodeJS.ProcessEnv {
	const baseEnv = opts.baseEnv ?? process.env;
	const effective = { ...baseEnv };
	const stateDir = usableEnvValue(baseEnv.FLYWHEEL_STATE_DIR)
		? baseEnv.FLYWHEEL_STATE_DIR
		: join(homedir(), ".flywheel");
	const envPath = opts.envPath ?? join(stateDir, ".env");
	let parsed: Record<string, string> = {};
	const protectedNames = new Set<string>(ALERT_ENV_ALLOWLIST);
	const senderNameFromBase = baseEnv.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
	if (senderNameFromBase && ENV_NAME.test(senderNameFromBase)) {
		protectedNames.add(senderNameFromBase);
	}
	try {
		const raw = readFileSync(envPath, "utf8");
		const firstPass = parseAllowedDotEnvAssignments(raw, protectedNames);
		const senderNameFromFile =
			firstPass.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
		if (senderNameFromFile && ENV_NAME.test(senderNameFromFile)) {
			protectedNames.add(senderNameFromFile);
		}
		parsed = parseAllowedDotEnvAssignments(raw, protectedNames);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const senderNameFromFile = parsed.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
	if (senderNameFromFile && ENV_NAME.test(senderNameFromFile)) {
		protectedNames.add(senderNameFromFile);
	}
	const supplement = (name: string): void => {
		if (usableEnvValue(effective[name])) return;
		if (usableEnvValue(parsed[name])) effective[name] = parsed[name];
	};
	for (const name of ALERT_ENV_ALLOWLIST) supplement(name);
	const senderName = effective.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
	if (senderName && ENV_NAME.test(senderName)) supplement(senderName);
	return effective;
}

async function makeProductionDeps(): Promise<AccountSwitchCliDeps> {
	const now = Date.now;
	const paths = defaultQuotaMonitorPaths();
	const profileBin = claudeProfileBinPath();
	const journalPath =
		process.env.FLYWHEEL_CLAUDE_TRANSITION_JOURNAL ??
		join(dirname(paths.storePath), "claude-account-transition.json");
	const alertEnv = loadAlertIdentityEnv();
	const auditPath =
		process.env.FLYWHEEL_PROFILE_AUDIT_LOG ??
		join(homedir(), ".flywheel", "claude-profile-audit.log");
	const auditActor = process.env.FLYWHEEL_AUDIT_ACTOR ?? `ppid:${process.ppid}`;
	const sendAlert = (alert: QuotaMonitorAlert) =>
		sendQuotaMonitorAlert(alert, { env: alertEnv });
	const withAccountsLock = async <T>(fn: () => Promise<T>): Promise<T> => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await acquireAccountsLock(
				paths.lockPath,
				async () => fn(),
				{
					reconcile: (lease) =>
						reconcileTransitionJournal(lease, {
							binPath: profileBin,
							journalPath,
						}),
				},
			);
			if (result.kind === "ok") return result.value;
			if (result.kind === "reconciled") continue;
			throw new Error(`account lock blocked: ${result.reason.kind}`);
		}
		throw new Error("account lock reconciled twice");
	};
	const readSnapshotLocked = async (): Promise<CandidateSnapshot> => {
		const store = readStoreStrict(paths.storePath);
		if (store === null) throw new Error("Claude account store is invalid");
		const activeName =
			store.activeAccount !== null &&
			store.accounts.some((account) => account.name === store.activeAccount)
				? store.activeAccount
				: null;
		return {
			activeName,
			store,
			activeCredential: await readKeychainMonitorCredential(),
			poolAccounts: listPoolAccounts(paths.poolDir),
		};
	};
	const selectionDeps = {
		now,
		withAccountsLock,
		readSnapshot: readSnapshotLocked,
		verifyCandidate: (name: string, activeName: string | null) =>
			verifyPoolCredential({ name, activeName, poolDir: paths.poolDir }),
		readPoolCredential: async (name: string) =>
			readPoolMonitorCredential(paths.poolDir, name),
		fetchUsage: (accessToken: string) => fetchAccountUsage(accessToken),
		recordObservation: (
			name: string,
			observation: Parameters<typeof recordObservationInStore>[2],
			generation: number,
		) =>
			withAccountsLock(async () =>
				recordObservationInStore(paths.storePath, name, observation, {
					expectedGeneration: generation,
				}),
			),
	};
	const config = loadQuotaMonitorConfig(paths.configPath);
	return {
		now,
		trigger5hPct: config.config.trigger5hPct,
		readSnapshot: () => withAccountsLock(readSnapshotLocked),
		selectCandidates: (snapshot, options) =>
			verifyAndRankCandidates(selectionDeps, snapshot, options),
		switchAccount: (input) => {
			const profileDeps = makeClaudeProfileSwitchDeps({
				binPath: profileBin,
				poolDir: paths.poolDir,
				claudeJsonPath: paths.claudeJsonPath,
				storePath: paths.storePath,
				lockPath: paths.lockPath,
				quotaPreverified: input.quotaPreverified === true,
				deliverNotification: sendAlert,
			});
			return executeSwitch(input, {
				...profileDeps,
				// Manual switching deliberately lets the bash primitive be the live
				// marker/identity authority. A stale marker becomes the typed drift
				// result that triggers the one-shot public reconcile path.
				resolveMachineAccount: (store) =>
					store.activeAccount !== null &&
					store.accounts.some((account) => account.name === store.activeAccount)
						? { kind: "resolved", name: store.activeAccount }
						: {
								kind: "untracked",
								identityEmail: null,
								activeMarker: null,
								ledgerAccount: store.activeAccount,
							},
			});
		},
		readIdentity: async (name) => readPoolProfileIdentity(paths.poolDir, name),
		sendAlert,
		auditFailure: (input) =>
			appendManualSwitchFailureAudit({
				path: auditPath,
				actor: auditActor,
				...input,
			}),
		reconcile: () =>
			reconcileClaudeProfile({
				binPath: profileBin,
				env: {
					FLYWHEEL_CLAUDE_PROFILES_DIR: paths.poolDir,
					FLYWHEEL_CLAUDE_ACCOUNTS_PATH: paths.storePath,
					FLYWHEEL_CLAUDE_ACCOUNTS_LOCK: paths.lockPath,
					FLYWHEEL_CLAUDE_JSON: paths.claudeJsonPath,
					FLYWHEEL_CLAUDE_TRANSITION_JOURNAL: journalPath,
				},
			}),
		stdout: (line) => process.stdout.write(`${line}\n`),
		stderr: (line) => process.stderr.write(`${line}\n`),
	};
}

export async function main(args = process.argv.slice(2)): Promise<number> {
	if (args.length === 1 && args[0] === "--runtime-check") {
		process.stdout.write("FLYWHEEL_ATOMIC_SWITCH_RUNTIME_OK\n");
		return 0;
	}
	try {
		return await runAccountSwitchCli(args, await makeProductionDeps());
	} catch (error) {
		process.stderr.write(
			`FLYWHEEL_ATOMIC_SWITCH_FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}

if (
	process.argv[1] !== undefined &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	process.exitCode = await main();
}
