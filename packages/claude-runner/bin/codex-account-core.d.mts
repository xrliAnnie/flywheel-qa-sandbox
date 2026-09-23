export type CodexProfileName = string;
export type CodexProfileRole = "primary" | "manual_backup";

export interface CodexAccountProfile {
	name: CodexProfileName;
	email: string;
	role: CodexProfileRole;
}

export interface CodexAccountPolicy {
	version: 2;
	primary: CodexProfileName;
}

export interface CodexAuthIdentity {
	profile: CodexProfileName;
	email: string;
	accountId: string | null;
	plan: string | null;
	mode: CodexProfileRole;
}

export type CodexProfileSlotState =
	| "ready"
	| "not_logged_in"
	| "invalid_credential"
	| "invalid_name";

export interface CodexProfileSlot {
	name: string;
	state: CodexProfileSlotState;
	identity?: CodexAuthIdentity;
	error?: string;
}

export type CodexAccountPoolProblemCode =
	| "duplicate_email"
	| "invalid_name"
	| "invalid_credential"
	| "not_logged_in";

export interface CodexAccountPoolProblem {
	name: string;
	code: CodexAccountPoolProblemCode;
}

export interface CodexAccountPool {
	version: 2;
	primary: CodexProfileName | null;
	profiles: readonly CodexAccountProfile[];
	slots: readonly CodexProfileSlot[];
	problems: readonly CodexAccountPoolProblem[];
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
export const CODEX_PROFILE_NAME: RegExp;
export function isCodexSlotName(name: unknown): name is string;
export function isCodexIdentityLabel(name: unknown): name is string;
export function loadCodexAccountPolicy(
	registryPath?: string,
): CodexAccountPolicy;
export function enumerateCodexProfileSlots(
	profilesRoot: string,
): readonly CodexProfileSlot[];
export function validateCodexAccountPool(value: unknown): CodexAccountPool;
export function loadCodexAccountPool(options: {
	profilesRoot: string;
	registryPath?: string;
}): CodexAccountPool;
export function identifyCodexAuth(
	rawAuth: string,
	pool: Pick<CodexAccountPool, "profiles">,
): CodexAuthIdentity;
export function readCodexAuthIdentity(
	authPath: string,
	opts: { profilesRoot: string; registryPath?: string },
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
	profilesRoot: string;
	ledgerRoot?: string;
	registryPath?: string;
	observedAt?: Date | string | number;
}): CodexAccountSnapshot;
export function readCodexAccountSnapshot(
	profile: CodexProfileName,
	options: {
		profilesRoot: string;
		ledgerRoot?: string;
		registryPath?: string;
	},
): CodexAccountSnapshot | null;
