import type {
	CodexAccountRegistry,
	CodexAuthIdentity,
} from "./codex-account-core.mjs";
export interface CodexCandidateRecovery {
	version: 1;
	accountKey: string;
	authPath: string;
	originalAuthDigest: string;
	process?: { state: "starting" | "running" | "stopped"; pid?: number };
}
export interface CodexAccountLease {
	orphanRecovery: CodexCandidateRecovery | null;
	profilesRoot: string;
	accountKey: string;
	assertHeld(): void;
	release(): void;
}
export function acquireCodexAccountLease(
	profilesRoot: string,
	accountKey: string,
): CodexAccountLease;
export function codexInstallAccountKey(identity: CodexAuthIdentity): string;
export function withCodexInstallLock<T>(home: string, callback: () => T): T;
export interface CodexInstallingReceipt {
	profile: string;
	accountKey: string;
	priorAuthDigest: string;
	installedAuthDigest: string;
	recoveryMaterialPath: string;
}
export interface CodexInstallResult {
	status:
		| "installed"
		| "probe_failed"
		| "stale_selection"
		| "candidate_conflict"
		| "identity_mismatch"
		| "install_uncertain";
	profilePersisted: boolean;
	canonicalDigest?: string;
	recoveryMaterialPath?: string;
}
export function installCodexQuotaCredential(options: {
	home: string;
	profilesRoot: string;
	profile: string;
	registry: CodexAccountRegistry;
	finalAuthPath: string;
	expectedProfileDigest: string;
	expectedCanonicalDigest: string;
	proof: {
		ok: boolean;
		profile: string;
		accountKey: string;
		authDigest: string;
		at: number;
	};
	now?: () => number;
	recordInstalling: (receipt: CodexInstallingReceipt) => void;
	afterCanonicalRename?: (receipt: CodexInstallingReceipt) => void;
	accountLease?: CodexAccountLease;
}): CodexInstallResult;

export function registerCodexCandidateWorkspace(
	lease: CodexAccountLease,
	workspace: { authPath: string; originalAuthDigest: string },
): void;
export function resolveCodexCandidateRecovery(
	lease: CodexAccountLease,
	persistedAuthPath: string,
): void;

export function markCodexCandidateProcess(
	lease: CodexAccountLease,
	processState: { state: "starting" | "running" | "stopped"; pid?: number },
): void;

export function assertCodexCandidateDrained(lease: CodexAccountLease): void;
export interface CodexCandidateRecoveryResult {
	status:
		| "recovered"
		| "no_pending"
		| "candidate_conflict"
		| "process_not_drained"
		| "identity_mismatch"
		| "recovery_uncertain";
	profilePersisted: boolean;
	recoveryMaterialPath?: string;
}
export function recoverCodexCandidateCredential(options: {
	profilesRoot: string;
	profile: string;
	registry: CodexAccountRegistry;
	accountKey: string;
}): CodexCandidateRecoveryResult;

export interface CodexCandidatePersistResult {
	status:
		| "persisted"
		| "candidate_conflict"
		| "process_not_drained"
		| "identity_mismatch"
		| "recovery_uncertain";
	profilePersisted: boolean;
	recoveryMaterialPath?: string;
}
export function persistCodexCandidateCredential(options: {
	profilesRoot: string;
	profile: string;
	registry: CodexAccountRegistry;
	accountKey: string;
	finalAuthPath: string;
	expectedProfileDigest: string;
	accountLease: CodexAccountLease;
}): CodexCandidatePersistResult;
