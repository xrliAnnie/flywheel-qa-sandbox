/**
 * FLY-1185 §2.8 — recovery-complete worktree quarantine.
 *
 * Before ANY forceful removal of a dirty worktree, its full recoverable
 * state is archived AND the archive is PROVEN restorable (restore-smoke).
 * Only a smoke-passed archive authorizes `--force` — a failed archive or a
 * failed smoke leaves the worktree untouched (fail-closed).
 *
 * Archived state:
 *   - staged.diff   (`git diff --cached --binary`)
 *   - tracked.diff  (`git diff --binary`, unstaged tracked changes)
 *   - untracked payload  (NUL-safe `ls-files --others --exclude-standard -z`)
 *   - ignored payload    (`ls-files --others --ignored --exclude-standard -z`)
 *     EXCEPT an exact, audit-visible regenerable allowlist (node_modules /
 *     dist / .venv / __pycache__ / .next / target — matched as a DIRECTORY
 *     component, never a filename), recorded in `manifest.skipped`;
 *   - manifest.json (+ manifest.sha256): per-file sha256/size/mode, symlink
 *     targets, HEAD sha, branch, full porcelain snapshot.
 *
 * Hard failure → retain:
 *   - submodule state changes (gitlink mode 160000 in the dirty set);
 *   - total payload+diff bytes > QUARANTINE_MAX_BYTES (2 GiB, hardcoded);
 *   - any probe/copy error;
 *   - restore-smoke mismatch.
 *
 * restore-smoke (fixed algorithm, plan §2.8): shared no-checkout clone →
 * detach at HEAD sha → `apply --cached staged.diff` → `checkout-index -a` →
 * `apply --check` + real replay of tracked.diff → restore untracked+ignored
 * payload → compare porcelain + per-file sha256 + symlink target/mode
 * against the manifest.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const QUARANTINE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB, no flag

/** Regenerable allowlist — matched as a directory COMPONENT of the path. */
export const QUARANTINE_REGENERABLE_DIRS: readonly string[] = [
	"node_modules",
	"dist",
	".venv",
	"__pycache__",
	".next",
	"target",
];

export function defaultQuarantineRoot(): string {
	return path.join(homedir(), ".flywheel", "archives", "worktree-quarantine");
}

/** True when the path (relative, /-separated) sits under a regenerable dir. */
export function isRegenerablePath(relPath: string): boolean {
	const parts = relPath.split("/");
	// Only DIRECTORY components count — the final segment is the file name.
	for (let i = 0; i < parts.length - 1; i++) {
		const comp = parts[i];
		if (comp && QUARANTINE_REGENERABLE_DIRS.includes(comp)) return true;
	}
	return false;
}

type ExecResult = { code: number; stdout: Buffer; stderr: string };

function gitRaw(
	args: string[],
	cwd: string,
	opts: { timeoutMs?: number } = {},
): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd,
				timeout: opts.timeoutMs ?? 60_000,
				encoding: "buffer",
				maxBuffer: 512 * 1024 * 1024,
			},
			(err, stdout, stderr) => {
				resolve({
					code: err ? ((err as { code?: number }).code ?? 1) : 0,
					stdout: stdout ?? Buffer.alloc(0),
					stderr: stderr ? stderr.toString("utf8") : "",
				});
			},
		);
	});
}

function sha256OfBuffer(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

async function sha256OfFile(p: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const h = createHash("sha256");
		const s = fs.createReadStream(p);
		s.on("data", (d) => h.update(d));
		s.on("error", reject);
		s.on("end", () => resolve(h.digest("hex")));
	});
}

export interface QuarantineFileEntry {
	path: string;
	type: "file" | "symlink";
	/** sha256 for files; absent for symlinks. */
	sha256?: string;
	size?: number;
	/** POSIX mode bits (e.g. 0o755) for files. */
	mode?: number;
	/** symlink target, verbatim. */
	linkTarget?: string;
	/** untracked | ignored — where the payload came from. */
	origin: "untracked" | "ignored";
}

export interface QuarantineManifest {
	version: 1;
	project: string;
	key: string;
	worktreePath: string;
	branch: string | null;
	headSha: string;
	createdAt: string;
	porcelain: string; // full `status --porcelain=v1 -z -uall` output (NUL kept)
	files: QuarantineFileEntry[];
	skipped: string[];
	stagedDiffSha256: string;
	trackedDiffSha256: string;
	totalBytes: number;
}

export type QuarantineResult =
	| { ok: true; archiveDir: string; manifest: QuarantineManifest }
	| { ok: false; reason: string; detail?: string };

function splitNul(buf: Buffer): string[] {
	return buf
		.toString("utf8")
		.split("\0")
		.filter((s) => s.length > 0);
}

/** Parse `status --porcelain=v1 -z` entries into changed paths (XY + path). */
function porcelainChangedPaths(porcelainZ: string): string[] {
	const out: string[] = [];
	const fields = porcelainZ.split("\0").filter((s) => s.length > 0);
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		if (!f || f.length < 4) continue;
		const xy = f.slice(0, 2);
		out.push(f.slice(3));
		// Rename entries (R / C in either column) carry the origin path as the
		// NEXT NUL field — consume it (also a changed path).
		if (xy.includes("R") || xy.includes("C")) {
			const orig = fields[i + 1];
			if (orig) {
				out.push(orig);
				i++;
			}
		}
	}
	return out;
}

/**
 * Quarantine one dirty worktree into `<root>/<project>-<key>-<stamp>/`.
 * NEVER removes anything — the caller force-removes only on `ok:true`.
 */
export async function quarantineWorktree(opts: {
	mainRepoPath: string;
	worktreePath: string;
	project: string;
	key: string;
	quarantineRoot?: string;
	maxBytes?: number;
	/** Injectable clock for deterministic archive names in tests. */
	nowMs?: number;
}): Promise<QuarantineResult> {
	const wt = opts.worktreePath;
	const maxBytes = opts.maxBytes ?? QUARANTINE_MAX_BYTES;
	const root = opts.quarantineRoot ?? defaultQuarantineRoot();

	try {
		// ── Probe base facts ──
		const headRes = await gitRaw(["-C", wt, "rev-parse", "HEAD"], wt);
		if (headRes.code !== 0) {
			return { ok: false, reason: "head_probe_failed", detail: headRes.stderr };
		}
		const headSha = headRes.stdout.toString("utf8").trim();

		const branchRes = await gitRaw(
			["-C", wt, "symbolic-ref", "--short", "-q", "HEAD"],
			wt,
		);
		const branch =
			branchRes.code === 0 ? branchRes.stdout.toString("utf8").trim() : null;

		const porcRes = await gitRaw(
			["-C", wt, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
			wt,
		);
		if (porcRes.code !== 0) {
			return {
				ok: false,
				reason: "porcelain_probe_failed",
				detail: porcRes.stderr,
			};
		}
		const porcelain = porcRes.stdout.toString("utf8");

		// ── Submodule change guard (gitlink 160000 in the dirty set → retain) ──
		const changed = porcelainChangedPaths(porcelain);
		if (changed.length > 0) {
			const lsRes = await gitRaw(
				["-C", wt, "ls-files", "-s", "-z", "--", ...changed],
				wt,
			);
			if (lsRes.code !== 0) {
				return {
					ok: false,
					reason: "submodule_probe_failed",
					detail: lsRes.stderr,
				};
			}
			for (const entry of splitNul(lsRes.stdout)) {
				if (entry.startsWith("160000 ")) {
					return { ok: false, reason: "submodule_change" };
				}
			}
		}

		// ── Diffs ──
		const stagedRes = await gitRaw(
			["-C", wt, "diff", "--cached", "--binary"],
			wt,
		);
		if (stagedRes.code !== 0) {
			return {
				ok: false,
				reason: "staged_diff_failed",
				detail: stagedRes.stderr,
			};
		}
		const trackedRes = await gitRaw(["-C", wt, "diff", "--binary"], wt);
		if (trackedRes.code !== 0) {
			return {
				ok: false,
				reason: "tracked_diff_failed",
				detail: trackedRes.stderr,
			};
		}

		// ── Payload inventories ──
		const untrackedRes = await gitRaw(
			["-C", wt, "ls-files", "--others", "--exclude-standard", "-z"],
			wt,
		);
		if (untrackedRes.code !== 0) {
			return {
				ok: false,
				reason: "untracked_list_failed",
				detail: untrackedRes.stderr,
			};
		}
		const ignoredRes = await gitRaw(
			[
				"-C",
				wt,
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"-z",
			],
			wt,
		);
		if (ignoredRes.code !== 0) {
			return {
				ok: false,
				reason: "ignored_list_failed",
				detail: ignoredRes.stderr,
			};
		}

		const untracked = splitNul(untrackedRes.stdout);
		const ignoredAll = splitNul(ignoredRes.stdout);
		const skipped: string[] = [];
		const ignoredKept: string[] = [];
		for (const rel of ignoredAll) {
			if (isRegenerablePath(rel)) skipped.push(rel);
			else ignoredKept.push(rel);
		}

		// ── Build archive dir ──
		const stamp = new Date(opts.nowMs ?? Date.now())
			.toISOString()
			.replace(/[:.]/g, "-");
		const safeKey = opts.key.replace(/[^A-Za-z0-9._-]/g, "_");
		const archiveDir = path.join(root, `${opts.project}-${safeKey}-${stamp}`);
		const payloadDir = path.join(archiveDir, "payload");
		fs.mkdirSync(payloadDir, { recursive: true, mode: 0o700 });

		let totalBytes = stagedRes.stdout.length + trackedRes.stdout.length;
		const files: QuarantineFileEntry[] = [];

		const copyOne = async (
			rel: string,
			origin: "untracked" | "ignored",
		): Promise<string | undefined> => {
			const src = path.join(wt, rel);
			const dst = path.join(payloadDir, rel);
			let st: fs.Stats;
			try {
				st = fs.lstatSync(src);
			} catch (err) {
				return `lstat_failed:${rel}:${(err as Error).message}`;
			}
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			if (st.isSymbolicLink()) {
				const target = fs.readlinkSync(src);
				fs.symlinkSync(target, dst);
				files.push({ path: rel, type: "symlink", linkTarget: target, origin });
				return undefined;
			}
			if (!st.isFile()) {
				// sockets/fifos/etc. are not recoverable content — fail-closed.
				return `unsupported_file_type:${rel}`;
			}
			totalBytes += st.size;
			if (totalBytes > maxBytes) return `over_budget:${rel}`;
			fs.copyFileSync(src, dst);
			fs.chmodSync(dst, st.mode & 0o7777);
			const sha = await sha256OfFile(dst);
			files.push({
				path: rel,
				type: "file",
				sha256: sha,
				size: st.size,
				mode: st.mode & 0o7777,
				origin,
			});
			return undefined;
		};

		for (const rel of untracked) {
			const err = await copyOne(rel, "untracked");
			if (err) {
				fs.rmSync(archiveDir, { recursive: true, force: true });
				return {
					ok: false,
					reason: err.startsWith("over_budget") ? "over_budget" : "copy_failed",
					detail: err,
				};
			}
		}
		for (const rel of ignoredKept) {
			const err = await copyOne(rel, "ignored");
			if (err) {
				fs.rmSync(archiveDir, { recursive: true, force: true });
				return {
					ok: false,
					reason: err.startsWith("over_budget") ? "over_budget" : "copy_failed",
					detail: err,
				};
			}
		}

		// ── Write diffs + manifest ──
		fs.writeFileSync(path.join(archiveDir, "staged.diff"), stagedRes.stdout);
		fs.writeFileSync(path.join(archiveDir, "tracked.diff"), trackedRes.stdout);

		const manifest: QuarantineManifest = {
			version: 1,
			project: opts.project,
			key: opts.key,
			worktreePath: wt,
			branch,
			headSha,
			createdAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
			porcelain,
			files,
			skipped,
			stagedDiffSha256: sha256OfBuffer(stagedRes.stdout),
			trackedDiffSha256: sha256OfBuffer(trackedRes.stdout),
			totalBytes,
		};
		const manifestJson = JSON.stringify(manifest, null, 2);
		fs.writeFileSync(path.join(archiveDir, "manifest.json"), manifestJson);
		fs.writeFileSync(
			path.join(archiveDir, "manifest.sha256"),
			sha256OfBuffer(Buffer.from(manifestJson)),
		);

		// ── restore-smoke ──
		const smoke = await restoreSmoke({
			mainRepoPath: opts.mainRepoPath,
			archiveDir,
			manifest,
		});
		if (!smoke.ok) {
			// Keep the (possibly partial) archive for forensics, but the caller
			// MUST NOT force-remove — signal failure.
			return {
				ok: false,
				reason: `restore_smoke_failed:${smoke.reason}`,
				detail: smoke.detail,
			};
		}

		return { ok: true, archiveDir, manifest };
	} catch (err) {
		return {
			ok: false,
			reason: "quarantine_exception",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * The fixed restore-smoke algorithm. Rebuilds the worktree state in a temp
 * clone and compares porcelain + payload hashes + symlink targets/modes
 * against the manifest. Read-only w.r.t. the original worktree.
 */
export async function restoreSmoke(opts: {
	mainRepoPath: string;
	archiveDir: string;
	manifest: QuarantineManifest;
}): Promise<{ ok: boolean; reason?: string; detail?: string }> {
	const { manifest, archiveDir } = opts;
	const tmp = fs.mkdtempSync(
		path.join(fs.realpathSync(tmpdir()), "fly1185-smoke-"),
	);
	try {
		// Shared no-checkout clone — same object store, HEAD sha reachable.
		const clone = await gitRaw(
			["clone", "--shared", "--no-checkout", "--quiet", opts.mainRepoPath, tmp],
			path.dirname(tmp),
		);
		if (clone.code !== 0) {
			return { ok: false, reason: "clone_failed", detail: clone.stderr };
		}
		const co = await gitRaw(
			["-C", tmp, "checkout", "--detach", "--quiet", manifest.headSha],
			tmp,
		);
		if (co.code !== 0) {
			return { ok: false, reason: "checkout_failed", detail: co.stderr };
		}

		// staged.diff → index only.
		const stagedPath = path.join(archiveDir, "staged.diff");
		if (fs.statSync(stagedPath).size > 0) {
			const ap = await gitRaw(
				["-C", tmp, "apply", "--cached", stagedPath],
				tmp,
			);
			if (ap.code !== 0) {
				return { ok: false, reason: "staged_apply_failed", detail: ap.stderr };
			}
			// Materialize the indexed state into the workdir (checkout-index -a -f).
			const ci = await gitRaw(["-C", tmp, "checkout-index", "-a", "-f"], tmp);
			if (ci.code !== 0) {
				return {
					ok: false,
					reason: "checkout_index_failed",
					detail: ci.stderr,
				};
			}
		}

		// tracked.diff → --check first, then real replay into the workdir.
		const trackedPath = path.join(archiveDir, "tracked.diff");
		if (fs.statSync(trackedPath).size > 0) {
			const check = await gitRaw(
				["-C", tmp, "apply", "--check", trackedPath],
				tmp,
			);
			if (check.code !== 0) {
				return {
					ok: false,
					reason: "tracked_check_failed",
					detail: check.stderr,
				};
			}
			const ap = await gitRaw(["-C", tmp, "apply", trackedPath], tmp);
			if (ap.code !== 0) {
				return { ok: false, reason: "tracked_apply_failed", detail: ap.stderr };
			}
		}

		// Payload restore.
		for (const f of manifest.files) {
			const src = path.join(archiveDir, "payload", f.path);
			const dst = path.join(tmp, f.path);
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			if (f.type === "symlink") {
				fs.symlinkSync(f.linkTarget ?? "", dst);
			} else {
				fs.copyFileSync(src, dst);
				if (f.mode !== undefined) fs.chmodSync(dst, f.mode);
			}
		}

		// ── Compare porcelain ──
		const porcRes = await gitRaw(
			["-C", tmp, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
			tmp,
		);
		if (porcRes.code !== 0) {
			return {
				ok: false,
				reason: "smoke_porcelain_failed",
				detail: porcRes.stderr,
			};
		}
		const gotPorcelain = porcRes.stdout.toString("utf8");
		// Ignored files are invisible to porcelain on BOTH sides; entries are
		// NUL-separated — compare as sorted sets (git emits a stable order, but
		// sorting removes any dependence on internal ordering details).
		const norm = (s: string) => s.split("\0").filter(Boolean).sort().join("\0");
		if (norm(gotPorcelain) !== norm(manifest.porcelain)) {
			return {
				ok: false,
				reason: "porcelain_mismatch",
				detail: `expected=${JSON.stringify(norm(manifest.porcelain))} got=${JSON.stringify(norm(gotPorcelain))}`,
			};
		}

		// ── Compare per-file hashes / symlink target+mode ──
		for (const f of manifest.files) {
			const dst = path.join(tmp, f.path);
			if (f.type === "symlink") {
				let target: string;
				try {
					target = fs.readlinkSync(dst);
				} catch (err) {
					return {
						ok: false,
						reason: "symlink_missing",
						detail: `${f.path}: ${(err as Error).message}`,
					};
				}
				if (target !== (f.linkTarget ?? "")) {
					return {
						ok: false,
						reason: "symlink_target_mismatch",
						detail: f.path,
					};
				}
			} else {
				const sha = await sha256OfFile(dst).catch(() => undefined);
				if (sha !== f.sha256) {
					return { ok: false, reason: "payload_sha_mismatch", detail: f.path };
				}
				if (f.mode !== undefined) {
					const mode = fs.lstatSync(dst).mode & 0o7777;
					if (mode !== f.mode) {
						return {
							ok: false,
							reason: "payload_mode_mismatch",
							detail: f.path,
						};
					}
				}
			}
		}

		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: "smoke_exception",
			detail: err instanceof Error ? err.message : String(err),
		};
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
