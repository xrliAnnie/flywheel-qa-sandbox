import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { identifyCodexAuth } from "./codex-account-core.mjs";

const digest = (raw) => createHash("sha256").update(raw).digest("hex");
const maxAuthBytes = 1024 * 1024;
function safeDir(path, create = false) {
	if (!isAbsolute(path)) throw new Error("codex_path_must_be_absolute");
	if (create) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
		}
	}
	const s = lstatSync(path);
	if (!s.isDirectory() || s.isSymbolicLink())
		throw new Error("codex_directory_unsafe");
}
function safeRead(path) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const s = fstatSync(fd);
		if (!s.isFile() || s.size > maxAuthBytes)
			throw new Error("codex_credential_unsafe");
		return readFileSync(fd, "utf8");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function replaceable(path) {
	try {
		const s = lstatSync(path);
		if (!s.isFile() || s.isSymbolicLink())
			throw new Error("codex_destination_unsafe");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
}
function syncDir(path) {
	const fd = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function atomicWrite(path, raw) {
	safeDir(dirname(path));
	replaceable(path);
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let fd;
	try {
		fd = openSync(
			temp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(fd, raw);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		replaceable(path);
		renameSync(temp, path);
		syncDir(dirname(path));
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temp, { force: true });
	}
}
function ownerRecord() {
	return {
		version: 1,
		pid: process.pid,
		processStartIdentity: null,
		nonce: randomUUID(),
		completed: false,
	};
}
function readOwner(path) {
	const owner = JSON.parse(safeRead(join(path, "owner.json")));
	if (
		owner.version !== 1 ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid < 1 ||
		!/^[0-9a-f-]{36}$/.test(owner.nonce) ||
		typeof owner.completed !== "boolean"
	)
		throw new Error("codex_install_locked");
	return owner;
}
function ownerStopped(owner) {
	if (owner.completed) return true;
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		return error.code === "ESRCH";
	}
}
// Elections retain their inode/path forever. A previous owner's election cannot
// accidentally authorize removal of a newly-created lock at the same pathname.
function electReclaimer(path, depth = 0) {
	if (depth > 16) throw new Error("codex_install_locked");
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		safeDir(path);
		const previous = readOwner(path);
		if (!ownerStopped(previous)) throw new Error("codex_install_locked");
		return electReclaimer(`${path}.next.${previous.nonce}`, depth + 1);
	}
	const owner = ownerRecord();
	atomicWrite(join(path, "owner.json"), JSON.stringify(owner));
	return () =>
		atomicWrite(
			join(path, "owner.json"),
			JSON.stringify({ ...owner, completed: true }),
		);
}
function reclaimDeadLock(path) {
	let original, owner;
	try {
		original = lstatSync(path);
		if (!original.isDirectory() || original.isSymbolicLink()) throw new Error();
		owner = readOwner(path);
	} catch {
		throw new Error("codex_install_locked");
	}
	if (!ownerStopped(owner)) throw new Error("codex_install_locked");
	const finish = electReclaimer(`${path}.reclaim.${owner.nonce}`);
	try {
		const current = lstatSync(path);
		if (
			current.ino !== original.ino ||
			current.dev !== original.dev ||
			readOwner(path).nonce !== owner.nonce
		)
			throw new Error("codex_install_locked");
		const deadPath = `${path}.dead.${randomUUID()}`;
		renameSync(path, deadPath);
		rmSync(deadPath, { recursive: true, force: true });
	} finally {
		finish();
	}
}
function acquireDirectoryLock(path) {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		reclaimDeadLock(path);
		mkdirSync(path, { mode: 0o700 });
	}
	const identity = lstatSync(path);
	let released = false;
	try {
		atomicWrite(join(path, "owner.json"), JSON.stringify(ownerRecord()));
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		throw error;
	}
	const assertHeld = () => {
		if (released) throw new Error("codex_lock_released");
		const current = lstatSync(path);
		if (
			current.ino !== identity.ino ||
			current.dev !== identity.dev ||
			!current.isDirectory() ||
			current.isSymbolicLink()
		)
			throw new Error("codex_lock_changed");
	};
	return {
		assertHeld,
		release() {
			if (released) return;
			assertHeld();
			rmSync(path, { recursive: true, force: true });
			released = true;
		},
	};
}
/** No age-based reclaim. Recovery must establish original PID/start identity is dead. */
export function withCodexInstallLock(home, callback) {
	safeDir(home);
	const lock = acquireDirectoryLock(join(home, ".codex-install.lock"));
	try {
		const value = callback();
		if (value && typeof value.then === "function")
			throw new Error("codex_install_callback_must_be_sync");
		return value;
	} finally {
		lock.release();
	}
}
const leases = new WeakSet();
export function acquireCodexAccountLease(profilesRoot, accountKey) {
	safeDir(profilesRoot);
	if (typeof accountKey !== "string" || !accountKey)
		throw new Error("codex_account_key_missing");
	const lockRoot = join(profilesRoot, ".codex-quota-account-locks");
	safeDir(lockRoot, true);
	const lock = acquireDirectoryLock(
		join(lockRoot, `${digest(accountKey)}.lock`),
	);
	const pendingPath = join(lockRoot, `${digest(accountKey)}.pending.json`);
	let orphanRecovery = null;
	try {
		orphanRecovery = JSON.parse(safeRead(pendingPath));
		if (
			orphanRecovery.version !== 1 ||
			orphanRecovery.accountKey !== accountKey ||
			typeof orphanRecovery.authPath !== "string" ||
			!isAbsolute(orphanRecovery.authPath) ||
			!/^[0-9a-f]{64}$/.test(orphanRecovery.originalAuthDigest)
		)
			throw new Error("codex_candidate_recovery_unknown");
	} catch (error) {
		if (error.code !== "ENOENT") {
			lock.release();
			throw new Error("codex_candidate_recovery_unknown");
		}
	}
	const lease = {
		pendingPath,
		orphanRecovery,
		profilesRoot: resolve(profilesRoot),
		accountKey,
		assertHeld: lock.assertHeld,
		release: lock.release,
	};
	leases.add(lease);
	return lease;
}
export function registerCodexCandidateWorkspace(lease, workspace) {
	validateLease(lease, lease.profilesRoot, lease.accountKey);
	if (lease.orphanRecovery)
		throw new Error("codex_candidate_recovery_required");
	if (
		!isAbsolute(workspace.authPath) ||
		!/^[0-9a-f]{64}$/.test(workspace.originalAuthDigest)
	)
		throw new Error("codex_candidate_recovery_unknown");
	const metadata = {
		version: 1,
		accountKey: lease.accountKey,
		authPath: workspace.authPath,
		originalAuthDigest: workspace.originalAuthDigest,
	};
	atomicWrite(lease.pendingPath, JSON.stringify(metadata));
	lease.orphanRecovery = metadata;
}
export function markCodexCandidateProcess(lease, processState) {
	validateLease(lease, lease.profilesRoot, lease.accountKey);
	if (!lease.orphanRecovery)
		throw new Error("codex_candidate_recovery_unknown");
	const metadata = { ...lease.orphanRecovery, process: processState };
	atomicWrite(lease.pendingPath, JSON.stringify(metadata));
	lease.orphanRecovery = metadata;
}
export function assertCodexCandidateDrained(lease) {
	validateLease(lease, lease.profilesRoot, lease.accountKey);
	const candidate = lease.orphanRecovery?.process;
	if (!candidate) return;
	if (candidate.state === "starting")
		throw new Error("codex_candidate_process_not_drained");
	if (candidate.state === "stopped" && candidate.pid === undefined) return;
	if (
		!Number.isSafeInteger(candidate.pid) ||
		candidate.pid < 1 ||
		!ownerStopped({ pid: candidate.pid, completed: false })
	)
		throw new Error("codex_candidate_process_not_drained");
	try {
		process.kill(-candidate.pid, 0);
		throw new Error("codex_candidate_process_not_drained");
	} catch (error) {
		if (error.code !== "ESRCH")
			throw new Error("codex_candidate_process_not_drained");
	}
}
export function resolveCodexCandidateRecovery(lease, persistedAuthPath) {
	validateLease(lease, lease.profilesRoot, lease.accountKey);
	if (!lease.orphanRecovery) return;
	assertCodexCandidateDrained(lease);
	if (resolve(persistedAuthPath) === resolve(lease.orphanRecovery.authPath))
		throw new Error("codex_candidate_recovery_not_persisted");
	if (
		digest(safeRead(persistedAuthPath)) !==
		digest(safeRead(lease.orphanRecovery.authPath))
	)
		throw new Error("codex_candidate_recovery_digest_mismatch");
	rmSync(lease.pendingPath);
	syncDir(dirname(lease.pendingPath));
	lease.orphanRecovery = null;
}
export function codexInstallAccountKey(identity) {
	return digest(`${identity.profile}:${identity.accountId ?? identity.email}`);
}
function validateLease(lease, profilesRoot, accountKey) {
	if (
		!leases.has(lease) ||
		lease.profilesRoot !== resolve(profilesRoot) ||
		lease.accountKey !== accountKey
	)
		throw new Error("codex_account_lease_mismatch");
	lease.assertHeld();
}
/** Final probe bytes are retained first; no path ever exports outgoing canonical to its old pool slot. */
export function installCodexQuotaCredential(options) {
	const { home, profilesRoot, profile, registry, proof, finalAuthPath } =
		options;
	const answer = {
		status: "probe_failed",
		profilePersisted: false,
		recoveryMaterialPath: finalAuthPath,
	};
	if (!proof?.ok) return answer;
	let finalRaw, finalDigest, identity, ownedLease;
	try {
		if (!["school", "personal", "business"].includes(profile))
			throw new Error("invalid_profile");
		safeDir(home);
		safeDir(profilesRoot);
		safeDir(join(profilesRoot, profile));
		safeDir(dirname(finalAuthPath));
		finalRaw = safeRead(finalAuthPath);
		finalDigest = digest(finalRaw);
		identity = identifyCodexAuth(finalRaw, registry);
		if (
			identity.profile !== profile ||
			proof.profile !== profile ||
			proof.authDigest !== finalDigest ||
			proof.accountKey !== codexInstallAccountKey(identity)
		) {
			answer.status = "identity_mismatch";
			return answer;
		}
		if (!options.accountLease)
			ownedLease = acquireCodexAccountLease(profilesRoot, proof.accountKey);
		const lease = options.accountLease ?? ownedLease;
		validateLease(lease, profilesRoot, proof.accountKey);
		assertCodexCandidateDrained(lease);
		finalRaw = safeRead(finalAuthPath);
		if (digest(finalRaw) !== finalDigest)
			throw new Error("codex_candidate_recovery_digest_mismatch");
		if (
			lease.orphanRecovery &&
			resolve(lease.orphanRecovery.authPath) !== resolve(finalAuthPath)
		)
			throw new Error("codex_candidate_recovery_required");
		return withCodexInstallLock(home, () => {
			const recoveryRoot = join(home, ".codex-quota-recovery");
			safeDir(recoveryRoot, true);
			const recoveryPath = join(recoveryRoot, `${finalDigest}.auth`);
			atomicWrite(recoveryPath, finalRaw);
			answer.recoveryMaterialPath = recoveryPath;
			const profilePath = join(profilesRoot, profile, "auth.json");
			const currentProfile = safeRead(profilePath);
			const currentProfileDigest = digest(currentProfile);
			if (
				currentProfileDigest !== options.expectedProfileDigest &&
				currentProfileDigest !== finalDigest
			) {
				answer.status = "candidate_conflict";
				return answer;
			}
			if (identifyCodexAuth(currentProfile, registry).profile !== profile) {
				answer.status = "identity_mismatch";
				return answer;
			}
			// A rotated token can no longer safely be discarded even if live auth changed or proof aged out.
			if (currentProfileDigest !== finalDigest)
				atomicWrite(profilePath, finalRaw);
			answer.profilePersisted = true;
			resolveCodexCandidateRecovery(lease, profilePath);
			const canonicalPath = join(home, "auth.json");
			const currentCanonical = safeRead(canonicalPath);
			const canonicalDigest = digest(currentCanonical);
			answer.canonicalDigest = canonicalDigest;
			const now = (options.now ?? Date.now)();
			if (
				canonicalDigest !== options.expectedCanonicalDigest ||
				!Number.isFinite(proof.at) ||
				proof.at > now ||
				now - proof.at > 90000
			) {
				answer.status = "stale_selection";
				return answer;
			}
			identifyCodexAuth(currentCanonical, registry);
			const receipt = {
				profile,
				accountKey: proof.accountKey,
				priorAuthDigest: canonicalDigest,
				installedAuthDigest: finalDigest,
				recoveryMaterialPath: recoveryPath,
			};
			if (typeof options.recordInstalling !== "function")
				throw new Error("codex_installing_receipt_required");
			const recorded = options.recordInstalling(receipt);
			if (recorded && typeof recorded.then === "function")
				throw new Error("codex_installing_receipt_must_be_sync");
			// Third-party writers need not honor the lock; compare immediately before rename too.
			lease.assertHeld();
			const installTime = (options.now ?? Date.now)();
			if (
				installTime < proof.at ||
				installTime - proof.at > 90000 ||
				digest(safeRead(canonicalPath)) !== canonicalDigest ||
				digest(safeRead(profilePath)) !== finalDigest
			) {
				answer.status = "stale_selection";
				return answer;
			}
			atomicWrite(canonicalPath, finalRaw);
			answer.canonicalDigest = finalDigest;
			options.afterCanonicalRename?.(receipt);
			answer.status = "installed";
			return answer;
		});
	} catch {
		answer.status = "install_uncertain";
		return answer;
	} finally {
		ownedLease?.release();
	}
}
/** Recovery-only target write: never reads or writes canonical/outgoing credentials. */
export function persistCodexCandidateCredential(options) {
	const {
		profilesRoot,
		profile,
		registry,
		accountKey,
		finalAuthPath,
		expectedProfileDigest,
		accountLease,
	} = options;
	const result = {
		status: "recovery_uncertain",
		profilePersisted: false,
		recoveryMaterialPath: finalAuthPath,
	};
	try {
		validateLease(accountLease, profilesRoot, accountKey);
		const pending = accountLease.orphanRecovery;
		if (
			!pending ||
			resolve(pending.authPath) !== resolve(finalAuthPath) ||
			pending.originalAuthDigest !== expectedProfileDigest
		)
			return result;
		if (
			!pending.process ||
			!Number.isSafeInteger(pending.process.pid) ||
			pending.process.pid < 1 ||
			pending.process.state === "starting"
		) {
			result.status = "process_not_drained";
			return result;
		}
		try {
			assertCodexCandidateDrained(accountLease);
		} catch {
			result.status = "process_not_drained";
			return result;
		}
		if (
			!["school", "personal", "business"].includes(profile) ||
			!registry.profiles.some((entry) => entry.name === profile)
		) {
			result.status = "identity_mismatch";
			return result;
		}
		safeDir(profilesRoot);
		safeDir(join(profilesRoot, profile));
		safeDir(dirname(finalAuthPath));
		const raw = safeRead(finalAuthPath);
		const finalIdentity = identifyCodexAuth(raw, registry);
		if (
			finalIdentity.profile !== profile ||
			codexInstallAccountKey(finalIdentity) !== accountKey
		) {
			result.status = "identity_mismatch";
			return result;
		}
		const profilePath = join(profilesRoot, profile, "auth.json");
		const existing = safeRead(profilePath);
		const existingDigest = digest(existing);
		const finalDigest = digest(raw);
		if (
			existingDigest !== expectedProfileDigest &&
			existingDigest !== finalDigest
		) {
			result.status = "candidate_conflict";
			return result;
		}
		const existingIdentity = identifyCodexAuth(existing, registry);
		if (
			existingIdentity.profile !== profile ||
			codexInstallAccountKey(existingIdentity) !== accountKey
		) {
			result.status = "identity_mismatch";
			return result;
		}
		accountLease.assertHeld();
		if (digest(safeRead(profilePath)) !== existingDigest) {
			result.status = "candidate_conflict";
			return result;
		}
		if (existingDigest !== finalDigest) atomicWrite(profilePath, raw);
		result.profilePersisted = true;
		resolveCodexCandidateRecovery(accountLease, profilePath);
		result.status = "persisted";
		return result;
	} catch {
		return result;
	}
}
export function recoverCodexCandidateCredential(options) {
	let lease;
	try {
		lease = acquireCodexAccountLease(options.profilesRoot, options.accountKey);
		const pending = lease.orphanRecovery;
		if (!pending) return { status: "no_pending", profilePersisted: false };
		const result = persistCodexCandidateCredential({
			...options,
			accountLease: lease,
			finalAuthPath: pending.authPath,
			expectedProfileDigest: pending.originalAuthDigest,
		});
		return {
			...result,
			status: result.status === "persisted" ? "recovered" : result.status,
		};
	} catch {
		return { status: "recovery_uncertain", profilePersisted: false };
	} finally {
		lease?.release();
	}
}
