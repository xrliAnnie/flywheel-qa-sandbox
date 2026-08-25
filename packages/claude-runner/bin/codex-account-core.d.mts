export type CodexProfileName = "school" | "personal" | "business";
export type CodexProfileRole = "primary" | "manual_backup";

export interface CodexAccountProfile {
	name: CodexProfileName;
	email: string;
	role: CodexProfileRole;
}

export interface CodexAccountRegistry {
	version: 1;
	primary: "personal";
	profiles: readonly CodexAccountProfile[];
}

export interface CodexAuthIdentity {
	profile: CodexProfileName;
	email: string;
	accountId: string | null;
	plan: string | null;
	mode: CodexProfileRole;
}

export type CodexAccountObservationSource =
	| "status"
	| "use"
	| "save"
	| "provision";

export interface CodexAccountSnapshot extends CodexAuthIdentity {
	version: 1;
	lastObservedAt: string;
	lastSource: CodexAccountObservationSource;
	lastHomeFingerprint: string;
}

export const DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH: string;
export function loadCodexAccountRegistry(
	registryPath?: string,
): CodexAccountRegistry;
export function identifyCodexAuth(
	rawAuth: string,
	registry: CodexAccountRegistry,
): CodexAuthIdentity;
export function readCodexAuthIdentity(
	authPath: string,
	opts?: { registryPath?: string },
): CodexAuthIdentity;
export function redactCodexEmail(email: string): string;
export function resolveCodexAccountLedgerRoot(
	env?: Record<string, string | undefined>,
): string;
export function fingerprintCodexHome(home: string): string;
export function recordCodexAccountObservation(options: {
	identity: CodexAuthIdentity;
	home: string;
	source: CodexAccountObservationSource;
	ledgerRoot?: string;
	registryPath?: string;
	observedAt?: Date | string | number;
}): CodexAccountSnapshot;
export function readCodexAccountSnapshot(
	profile: CodexProfileName,
	options?: { ledgerRoot?: string; registryPath?: string },
): CodexAccountSnapshot | null;
