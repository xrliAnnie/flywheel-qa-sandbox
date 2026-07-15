/**
 * FLY-709 P2 — the flag-toggle apply core (copy-paste-apply model).
 *
 * The mutation logic behind BOTH entry points (localhost console direct apply and
 * the CLI the Lead runs from a phone copy-paste). It is the in-process handler
 * the Bridge routes call after auth (loopback+confirmToken / Bearer). It is NOT
 * the FLY-247 detached bash engine — that engine mutates projects.json, but an
 * env flag toggle must mutate the RUNNING Bridge's own process.env (a detached
 * process can't), which is why this runs in-proc.
 *
 * Transaction (plan §4.2, Codex-approved):
 *  1. only a `direct`-toggleable flag (every read site call_time, non-governance)
 *     may be applied here; anything else is rejected.
 *  2. re-verify under the current file: `.env` SHA must equal the reviewed
 *     `fileSha` AND the live `process.env[envVar]` must equal the reviewed
 *     `rawFrom` — else DENY (something changed since review).
 *  3. persist to `.env` FIRST (atomic, via env-file-writer); if that fails, abort
 *     with NO live change (disk + live stay consistent).
 *  4. only then mutate `process.env` in-proc (live effect for the call-time read).
 *
 * A persist-succeeds-but-mutate-throws case cannot really happen (assignment),
 * but is handled: the caller is told the disk is written (restart makes it
 * consistent) and live is unchanged — never "live changed but not persisted".
 */

import { FEATURE_FLAGS, type FeatureFlagSpec } from "flywheel-config";
import {
	applyEnvChange,
	computeEnvSha,
	withEnvFileLock,
	writeEnvFileAtomic,
} from "./env-file-writer.js";

/** The reviewed canonical flag change (raw env values, not effective booleans). */
export interface FlagToggleChange {
	name: string;
	/** Reviewed baseline raw env value (null = the key was absent). */
	rawFrom: string | null;
	/** Target raw value (null = delete the key → back to default). */
	rawTo: string | null;
	/** Reviewed sha of the `.env` content at stage time. */
	fileSha: string;
}

export interface FlagToggleDeps {
	/** Path to ~/.flywheel/.env. */
	envPath: string;
	readFile: (path: string) => string;
	writeFile?: (path: string, content: string) => void;
	/** The live env to re-verify + mutate (defaults to process.env). */
	env?: Record<string, string | undefined>;
	/**
	 * Critical-section lock (plan §4.3). Defaults to a real cross-process file
	 * lock on `<envPath>.lock`; tests inject a pass-through. The read→check→
	 * persist→mutate runs inside it so a concurrent writer can't interleave.
	 */
	lock?: <T>(fn: () => T) => T;
}

export interface FlagToggleResult {
	ok: boolean;
	/** 0 ok; 400 bad request; 409 denied (changed since review); 500 io. */
	code: 0 | 400 | 409 | 500;
	reason?: string;
	/** Present when disk was written but live mutate did not apply (restart-consistent). */
	warn?: string;
}

/** Only flags read at call-time (live), non-governance, marked direct. */
export function isDirectToggleable(spec: FeatureFlagSpec): boolean {
	return (
		spec.source === "env" &&
		spec.scope === "bridge_global" &&
		spec.toggleable === "direct" &&
		spec.category !== "governance_gate" &&
		spec.readSites.length > 0 &&
		spec.readSites.every((s) => s.timing === "call_time")
	);
}

export function applyFlagToggle(
	deps: FlagToggleDeps,
	change: FlagToggleChange,
): FlagToggleResult {
	const env = deps.env ?? process.env;
	const write = deps.writeFile ?? writeEnvFileAtomic;
	const lock =
		deps.lock ?? (<T>(fn: () => T) => withEnvFileLock(deps.envPath, fn));

	const spec = FEATURE_FLAGS.find((f) => f.name === change.name);
	if (!spec)
		return { ok: false, code: 400, reason: `unknown flag: ${change.name}` };
	if (!spec.envVar) {
		return {
			ok: false,
			code: 400,
			reason: `${change.name} is not an env flag`,
		};
	}
	if (!isDirectToggleable(spec)) {
		return {
			ok: false,
			code: 400,
			reason: `${change.name} is not direct-toggleable (needs restart / governance-gated)`,
		};
	}
	const envVar = spec.envVar;

	// The read→check→persist→mutate is one critical section (plan §4.3): a
	// concurrent writer must not slip between our re-read and our atomic rename.
	// A lock-acquisition failure is surfaced as a 409 (try again) — never write
	// unguarded.
	try {
		return lock(() => {
			const content = deps.readFile(deps.envPath);

			// Re-verify the reviewed baseline: file unchanged AND live value unchanged.
			if (computeEnvSha(content) !== change.fileSha) {
				return { ok: false, code: 409, reason: ".env changed since review" };
			}
			const currentRaw = env[envVar] ?? null;
			if (currentRaw !== change.rawFrom) {
				return {
					ok: false,
					code: 409,
					reason: `${envVar} live value changed since review`,
				};
			}

			// Persist FIRST (atomic). A persist failure = zero change (disk + live consistent).
			const applied = applyEnvChange(content, envVar, change.rawTo);
			if (!applied.ok) return { ok: false, code: 400, reason: applied.reason };
			try {
				write(deps.envPath, applied.next as string);
			} catch (err) {
				return {
					ok: false,
					code: 500,
					reason: `persist .env failed (no live change): ${(err as Error).message}`,
				};
			}

			// Then mutate live process.env (call-time reads observe this immediately).
			try {
				if (change.rawTo === null) delete env[envVar];
				else env[envVar] = change.rawTo;
			} catch (err) {
				return {
					ok: true,
					code: 0,
					warn: `.env written but live mutate failed (${(err as Error).message}); restart makes it consistent`,
				};
			}

			return { ok: true, code: 0 };
		});
	} catch (err) {
		// The lock itself failed (couldn't read .env, or lock busy past timeout).
		const msg = (err as Error).message;
		const busy = /lock busy/.test(msg);
		return {
			ok: false,
			code: busy ? 409 : 500,
			reason: busy ? msg : `apply .env failed: ${msg}`,
		};
	}
}
