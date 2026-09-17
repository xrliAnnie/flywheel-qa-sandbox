import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	buildProofFetchArgs,
	buildProofGitEnv,
} from "./land-head-refresh-proof.js";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const MAX_PROOF_FILES = 10_000;
const REGULAR_MODES = new Set(["100644", "100755"]);

export interface ApprovedContentFileFingerprint {
	path: string;
	status: "A" | "D" | "M";
	oldMode: string;
	newMode: string;
	hunkDigests: string[];
}

export interface ApprovedContentFingerprint {
	schemaVersion: 1;
	mergeBase: string;
	approvedHead: string;
	files: ApprovedContentFileFingerprint[];
	rootDigest: string;
}

export type ContentContinuityProof =
	| {
			ok: true;
			proofKind: "content_bound_merge_v2";
			rootDigest: string;
			approvedHead: string;
			mergeBase: string;
			priorHead: string;
			baseOid: string;
			candidateHead: string;
			candidateTreeOid: string;
			conflictFiles: string[];
			conflictProofDigest: string;
			requiresFreshQa: boolean;
	  }
	| {
			ok: false;
			reason:
				| "invalid_content_proof_input"
				| "content_proof_object_unavailable"
				| "content_proof_root_mismatch"
				| "content_proof_merge_base_changed"
				| "candidate_parent_identity_mismatch"
				| "approved_file_set_changed"
				| "unsupported_content_structure"
				| "ambiguous_protected_content"
				| "protected_content_changed"
				| "candidate_contains_conflict_markers";
	  };

interface RawDiffEntry {
	path: string;
	status: "A" | "D" | "M";
	oldMode: string;
	newMode: string;
}

interface MergeFileResult {
	status: number;
	stdout: Buffer;
	stderr: string;
}

function digestParts(parts: Array<string | Buffer>): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		const value = Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8");
		const length = Buffer.allocUnsafe(8);
		length.writeBigUInt64BE(BigInt(value.length));
		hash.update(length);
		hash.update(value);
	}
	return hash.digest("hex");
}

async function gitText(repoRoot: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: MAX_PROOF_BYTES + 1024 * 1024,
		env: buildProofGitEnv(process.env),
	});
	return result.stdout;
}

function gitBuffer(repoRoot: string, args: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{
				cwd: repoRoot,
				encoding: "buffer",
				maxBuffer: MAX_PROOF_BYTES + 1024 * 1024,
				env: buildProofGitEnv(process.env),
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout as Buffer);
			},
		);
	});
}

async function rawDiffEntries(
	repoRoot: string,
	from: string,
	to: string,
): Promise<RawDiffEntry[]> {
	const raw = await gitText(repoRoot, [
		"-c",
		"core.quotepath=false",
		"diff",
		"--raw",
		"--no-abbrev",
		"--no-renames",
		"-z",
		from,
		to,
	]);
	const tokens = raw.split("\0");
	const entries: RawDiffEntry[] = [];
	for (let index = 0; index < tokens.length; ) {
		const header = tokens[index++];
		if (!header) continue;
		const path = tokens[index++];
		const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ADM])$/.exec(header);
		if (
			!match ||
			path === undefined ||
			path.length === 0 ||
			path.includes("\0")
		) {
			throw new Error("unsupported_content_structure");
		}
		entries.push({
			path,
			oldMode: match[1]!,
			newMode: match[2]!,
			status: match[3] as RawDiffEntry["status"],
		});
	}
	if (entries.length > MAX_PROOF_FILES) throw new Error("proof_resource_limit");
	return entries.sort((left, right) =>
		Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
	);
}

function splitLinesKeepingEndings(value: string): string[] {
	return value.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function hunkPayloads(diff: string): Buffer[] {
	if (/^(?:GIT binary patch|Binary files )/m.test(diff)) {
		throw new Error("unsupported_content_structure");
	}
	const hunks: Buffer[] = [];
	let current: string[] | undefined;
	for (const line of splitLinesKeepingEndings(diff)) {
		if (line.startsWith("@@ ")) {
			if (current) hunks.push(Buffer.from(current.join(""), "utf8"));
			current = [];
			continue;
		}
		if (current && /^(?:diff --git |index |--- |\+\+\+ )/.test(line)) {
			hunks.push(Buffer.from(current.join(""), "utf8"));
			current = undefined;
			continue;
		}
		if (current && (/^[+-]/.test(line) || line.startsWith("\\ No newline"))) {
			current.push(line);
		}
	}
	if (current) hunks.push(Buffer.from(current.join(""), "utf8"));
	return hunks;
}

export function approvedContentFingerprintRoot(
	files: ApprovedContentFileFingerprint[],
): string {
	const parts: Array<string | Buffer> = ["flywheel-approved-content-v1"];
	for (const file of files) {
		parts.push(file.path, file.status, file.oldMode, file.newMode);
		for (const digest of file.hunkDigests) parts.push(digest);
	}
	return digestParts(parts);
}

export async function fingerprintApprovedContent(input: {
	repoRoot: string;
	mergeBase: string;
	approvedHead: string;
}): Promise<ApprovedContentFingerprint> {
	const mergeBase = input.mergeBase.trim().toLowerCase();
	const approvedHead = input.approvedHead.trim().toLowerCase();
	if (
		!input.repoRoot ||
		!FULL_SHA.test(mergeBase) ||
		!FULL_SHA.test(approvedHead)
	) {
		throw new Error("invalid_content_proof_input");
	}
	await Promise.all(
		[mergeBase, approvedHead].map((oid) =>
			gitText(input.repoRoot, ["cat-file", "-e", `${oid}^{commit}`]),
		),
	);
	const rawFiles = await rawDiffEntries(
		input.repoRoot,
		mergeBase,
		approvedHead,
	);
	const files: ApprovedContentFileFingerprint[] = [];
	for (const file of rawFiles) {
		const diff = await gitText(input.repoRoot, [
			"-c",
			"core.quotepath=false",
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--unified=0",
			"--binary",
			mergeBase,
			approvedHead,
			"--",
			file.path,
		]);
		if (Buffer.byteLength(diff) > MAX_PROOF_BYTES) {
			throw new Error("proof_resource_limit");
		}
		files.push({
			...file,
			hunkDigests: hunkPayloads(diff).map((payload) =>
				digestParts(["flywheel-approved-hunk-v1", payload]),
			),
		});
	}
	return {
		schemaVersion: 1,
		mergeBase,
		approvedHead,
		files,
		rootDigest: approvedContentFingerprintRoot(files),
	};
}

async function blobAt(
	repoRoot: string,
	commit: string,
	path: string,
): Promise<Buffer | undefined> {
	try {
		const value = await gitBuffer(repoRoot, ["show", `${commit}:${path}`]);
		if (value.length > MAX_PROOF_BYTES) throw new Error("proof_resource_limit");
		return value;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			/does not exist|exists on disk, but not in|Path .* does not exist/i.test(
				message,
			)
		) {
			return undefined;
		}
		throw error;
	}
}

function runMergeFile(input: {
	ours: Buffer;
	base: Buffer;
	theirs: Buffer;
}): Promise<MergeFileResult> {
	const root = mkdtempSync(join(tmpdir(), "flywheel-content-merge-"));
	const oursPath = join(root, "ours");
	const basePath = join(root, "base");
	const theirsPath = join(root, "theirs");
	writeFileSync(oursPath, input.ours);
	writeFileSync(basePath, input.base);
	writeFileSync(theirsPath, input.theirs);
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[
				"merge-file",
				"--stdout",
				"--diff3",
				"-L",
				"FLYWHEEL_OURS",
				"-L",
				"FLYWHEEL_BASE",
				"-L",
				"FLYWHEEL_THEIRS",
				oursPath,
				basePath,
				theirsPath,
			],
			{
				encoding: "buffer",
				maxBuffer: MAX_PROOF_BYTES + 1024 * 1024,
				env: buildProofGitEnv(process.env),
			},
			(error, stdout, stderr) => {
				rmSync(root, { recursive: true, force: true });
				const status = (error as NodeJS.ErrnoException & { code?: number })
					?.code;
				// merge-file returns the conflict count, truncated to 127; only a
				// status outside that documented range is an execution failure.
				const isConflictResult =
					typeof status === "number" && status >= 1 && status <= 127;
				if (error && !isConflictResult) {
					reject(error);
					return;
				}
				resolve({
					status: error ? status! : 0,
					stdout: stdout as Buffer,
					stderr: Buffer.isBuffer(stderr)
						? stderr.toString("utf8")
						: String(stderr),
				});
			},
		);
	});
}

function hasMarkerShapedLine(value: string): boolean {
	return /^(?:<{7} FLYWHEEL_OURS|\|{7} FLYWHEEL_BASE|={7}|>{7} FLYWHEEL_THEIRS)\r?$/m.test(
		value,
	);
}

function decodeText(value: Buffer): string | undefined {
	if (value.includes(0)) return undefined;
	const decoded = value.toString("utf8");
	return Buffer.from(decoded, "utf8").equals(value) ? decoded : undefined;
}

function parseDiff3(value: string):
	| {
			protectedSpans: string[];
			conflicts: Array<{ ours: string; base: string; theirs: string }>;
	  }
	| undefined {
	type Mode = "protected" | "ours" | "base" | "theirs";
	let mode: Mode = "protected";
	let protectedText = "";
	let ours = "";
	let base = "";
	let theirs = "";
	const protectedSpans: string[] = [];
	const conflicts: Array<{ ours: string; base: string; theirs: string }> = [];
	for (const line of splitLinesKeepingEndings(value)) {
		const marker = line.replace(/\r?\n$/, "");
		if (marker === "<<<<<<< FLYWHEEL_OURS") {
			if (mode !== "protected") return undefined;
			protectedSpans.push(protectedText);
			protectedText = "";
			mode = "ours";
			continue;
		}
		if (marker === "||||||| FLYWHEEL_BASE") {
			if (mode !== "ours") return undefined;
			mode = "base";
			continue;
		}
		if (marker === "=======") {
			if (mode !== "base") return undefined;
			mode = "theirs";
			continue;
		}
		if (marker === ">>>>>>> FLYWHEEL_THEIRS") {
			if (mode !== "theirs") return undefined;
			conflicts.push({ ours, base, theirs });
			ours = "";
			base = "";
			theirs = "";
			mode = "protected";
			continue;
		}
		if (mode === "protected") protectedText += line;
		else if (mode === "ours") ours += line;
		else if (mode === "base") base += line;
		else theirs += line;
	}
	if (mode !== "protected" || conflicts.length === 0) return undefined;
	protectedSpans.push(protectedText);
	return { protectedSpans, conflicts };
}

function verifyProtectedSpans(
	candidate: string,
	spans: string[],
): { ok: true; replacements: string[] } | { ok: false; ambiguous: boolean } {
	if (spans.length < 2) return { ok: false, ambiguous: true };
	const positions: number[] = [];
	for (let index = 0; index < spans.length; index += 1) {
		const span = spans[index]!;
		if (span.length === 0) {
			positions.push(index === 0 ? 0 : candidate.length);
			continue;
		}
		const first = candidate.indexOf(span);
		const last = candidate.lastIndexOf(span);
		if (first < 0) return { ok: false, ambiguous: false };
		if (first !== last) return { ok: false, ambiguous: true };
		positions.push(first);
	}
	if (spans[0] && positions[0] !== 0) return { ok: false, ambiguous: false };
	const lastIndex = spans.length - 1;
	if (
		spans[lastIndex] &&
		positions[lastIndex] !== candidate.length - spans[lastIndex]!.length
	) {
		return { ok: false, ambiguous: false };
	}
	const replacements: string[] = [];
	for (let index = 0; index < spans.length - 1; index += 1) {
		const start = positions[index]! + spans[index]!.length;
		const end = positions[index + 1]!;
		if (end < start) return { ok: false, ambiguous: false };
		replacements.push(candidate.slice(start, end));
	}
	return { ok: true, replacements };
}

interface LineEdit {
	start: number;
	end: number;
	replacement: string[];
}

function lineEdits(base: string[], variant: string[]): LineEdit[] | undefined {
	if (base.length > 2_000 || variant.length > 2_000) return undefined;
	const rows = base.length + 1;
	const columns = variant.length + 1;
	const lcs = new Uint16Array(rows * columns);
	const at = (row: number, column: number) => row * columns + column;
	for (let row = base.length - 1; row >= 0; row -= 1) {
		for (let column = variant.length - 1; column >= 0; column -= 1) {
			lcs[at(row, column)] =
				base[row] === variant[column]
					? lcs[at(row + 1, column + 1)]! + 1
					: Math.max(lcs[at(row + 1, column)]!, lcs[at(row, column + 1)]!);
		}
	}
	const edits: LineEdit[] = [];
	let row = 0;
	let column = 0;
	while (row < base.length || column < variant.length) {
		if (
			row < base.length &&
			column < variant.length &&
			base[row] === variant[column]
		) {
			row += 1;
			column += 1;
			continue;
		}
		const start = row;
		const replacement: string[] = [];
		while (row < base.length || column < variant.length) {
			if (
				row < base.length &&
				column < variant.length &&
				base[row] === variant[column]
			) {
				break;
			}
			if (
				column < variant.length &&
				(row >= base.length ||
					lcs[at(row, column + 1)]! > lcs[at(row + 1, column)]!)
			) {
				replacement.push(variant[column]!);
				column += 1;
			} else if (row < base.length) {
				row += 1;
			}
		}
		const edit = { start, end: row, replacement };
		const removed = edit.end - edit.start;
		if (removed === edit.replacement.length && removed > 1) {
			for (let offset = 0; offset < removed; offset += 1) {
				edits.push({
					start: edit.start + offset,
					end: edit.start + offset + 1,
					replacement: [edit.replacement[offset]!],
				});
			}
		} else {
			edits.push(edit);
		}
	}
	return edits;
}

function editsOverlap(left: LineEdit, right: LineEdit): boolean {
	const leftInsertion = left.start === left.end;
	const rightInsertion = right.start === right.end;
	if (leftInsertion && rightInsertion) return left.start === right.start;
	if (leftInsertion) return left.start > right.start && left.start < right.end;
	if (rightInsertion) return right.start > left.start && right.start < left.end;
	return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

/**
 * Git can group an adjacent ours-only edit into a textual conflict. Split the
 * conflict back into line atoms and preserve every edit that did not overlap a
 * main edit. This prevents a broad conflict marker from becoming a whole-file
 * (or whole-marker) exception.
 */
function deriveProtectedConflictPieces(conflict: {
	ours: string;
	base: string;
	theirs: string;
}): string[] | undefined {
	const base = splitLinesKeepingEndings(conflict.base);
	const ours = lineEdits(base, splitLinesKeepingEndings(conflict.ours));
	const theirs = lineEdits(base, splitLinesKeepingEndings(conflict.theirs));
	if (!ours || !theirs) return undefined;
	const oursOverlaps = new Set<number>();
	const theirsOverlaps = new Set<number>();
	for (let oursIndex = 0; oursIndex < ours.length; oursIndex += 1) {
		for (let theirsIndex = 0; theirsIndex < theirs.length; theirsIndex += 1) {
			if (editsOverlap(ours[oursIndex]!, theirs[theirsIndex]!)) {
				oursOverlaps.add(oursIndex);
				theirsOverlaps.add(theirsIndex);
			}
		}
	}
	const changedBaseLines = new Set<number>();
	for (const edit of [...ours, ...theirs]) {
		for (let index = edit.start; index < edit.end; index += 1) {
			changedBaseLines.add(index);
		}
	}
	const pieces: Array<{ position: number; text: string }> = [];
	for (let index = 0; index < base.length; index += 1) {
		if (!changedBaseLines.has(index)) {
			pieces.push({ position: index, text: base[index]! });
		}
	}
	ours.forEach((edit, index) => {
		if (!oursOverlaps.has(index) && edit.replacement.length > 0) {
			pieces.push({ position: edit.start, text: edit.replacement.join("") });
		}
	});
	theirs.forEach((edit, index) => {
		if (!theirsOverlaps.has(index) && edit.replacement.length > 0) {
			pieces.push({ position: edit.start, text: edit.replacement.join("") });
		}
	});
	return pieces
		.sort((left, right) => left.position - right.position)
		.map((piece) => piece.text)
		.filter(Boolean);
}

function verifyProtectedPieces(
	candidate: string,
	pieces: string[],
): {
	ok: boolean;
	ambiguous: boolean;
} {
	let cursor = 0;
	for (const piece of pieces) {
		const first = candidate.indexOf(piece, cursor);
		if (first < 0) return { ok: false, ambiguous: false };
		if (candidate.indexOf(piece, first + 1) >= 0) {
			return { ok: false, ambiguous: true };
		}
		cursor = first + piece.length;
	}
	return { ok: true, ambiguous: false };
}

export function isTrustedTestOnlyPath(path: string): boolean {
	if (path.startsWith(".github/") || path.startsWith("scripts/")) return false;
	return (
		/(?:^|\/)(?:__tests__|tests?|testdata|fixtures)\//.test(path) ||
		/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path)
	);
}

function sameFileSet(
	fingerprint: ApprovedContentFileFingerprint[],
	candidate: RawDiffEntry[],
): boolean {
	return (
		fingerprint.length === candidate.length &&
		fingerprint.every((file, index) => {
			const compared = candidate[index];
			return (
				compared?.path === file.path &&
				compared.status === file.status &&
				compared.oldMode === file.oldMode &&
				compared.newMode === file.newMode
			);
		})
	);
}

export async function proveApprovedContentContinuity(input: {
	repoRoot: string;
	fingerprint: ApprovedContentFingerprint;
	approvedHead: string;
	mergeBase: string;
	priorHead: string;
	baseOid: string;
	candidateHead: string;
}): Promise<ContentContinuityProof> {
	const approvedHead = input.approvedHead.trim().toLowerCase();
	const mergeBase = input.mergeBase.trim().toLowerCase();
	const priorHead = input.priorHead.trim().toLowerCase();
	const baseOid = input.baseOid.trim().toLowerCase();
	const candidateHead = input.candidateHead.trim().toLowerCase();
	if (
		!input.repoRoot ||
		input.fingerprint.schemaVersion !== 1 ||
		![approvedHead, mergeBase, priorHead, baseOid, candidateHead].every(
			(value) => FULL_SHA.test(value),
		)
	) {
		return { ok: false, reason: "invalid_content_proof_input" };
	}
	if (
		input.fingerprint.approvedHead !== approvedHead ||
		input.fingerprint.mergeBase !== mergeBase
	) {
		return { ok: false, reason: "content_proof_merge_base_changed" };
	}
	try {
		const observed = await fingerprintApprovedContent({
			repoRoot: input.repoRoot,
			mergeBase,
			approvedHead,
		});
		if (
			observed.rootDigest !== input.fingerprint.rootDigest ||
			approvedContentFingerprintRoot(input.fingerprint.files) !==
				input.fingerprint.rootDigest
		) {
			return { ok: false, reason: "content_proof_root_mismatch" };
		}
		const mergeBases = (
			await gitText(input.repoRoot, [
				"merge-base",
				"--all",
				approvedHead,
				baseOid,
			])
		)
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((value) => value.toLowerCase());
		if (mergeBases.length !== 1 || mergeBases[0] !== mergeBase) {
			return { ok: false, reason: "content_proof_merge_base_changed" };
		}
		const parentLine = (
			await gitText(input.repoRoot, [
				"rev-list",
				"--parents",
				"-n",
				"1",
				candidateHead,
			])
		).trim();
		const parents = parentLine.split(/\s+/).slice(1);
		if (
			parents.length !== 2 ||
			parents[0] !== priorHead ||
			parents[1] !== baseOid
		) {
			return { ok: false, reason: "candidate_parent_identity_mismatch" };
		}
		const candidateFiles = await rawDiffEntries(
			input.repoRoot,
			baseOid,
			candidateHead,
		);
		if (!sameFileSet(input.fingerprint.files, candidateFiles)) {
			return { ok: false, reason: "approved_file_set_changed" };
		}

		const conflictFiles: string[] = [];
		const conflictParts: Array<string | Buffer> = [
			"flywheel-conflict-proof-v1",
		];
		for (const file of input.fingerprint.files) {
			if (file.status === "A") {
				if (file.oldMode !== "000000" || !REGULAR_MODES.has(file.newMode)) {
					return { ok: false, reason: "unsupported_content_structure" };
				}
				const [base, ours, theirs, candidate] = await Promise.all([
					blobAt(input.repoRoot, mergeBase, file.path),
					blobAt(input.repoRoot, approvedHead, file.path),
					blobAt(input.repoRoot, baseOid, file.path),
					blobAt(input.repoRoot, candidateHead, file.path),
				]);
				if (
					base ||
					theirs ||
					!ours ||
					!candidate ||
					decodeText(ours) === undefined ||
					decodeText(candidate) === undefined
				) {
					return { ok: false, reason: "unsupported_content_structure" };
				}
				if (!ours.equals(candidate)) {
					return { ok: false, reason: "protected_content_changed" };
				}
				continue;
			}
			if (file.status === "D") {
				if (!REGULAR_MODES.has(file.oldMode) || file.newMode !== "000000") {
					return { ok: false, reason: "unsupported_content_structure" };
				}
				const [base, ours, theirs, candidate] = await Promise.all([
					blobAt(input.repoRoot, mergeBase, file.path),
					blobAt(input.repoRoot, approvedHead, file.path),
					blobAt(input.repoRoot, baseOid, file.path),
					blobAt(input.repoRoot, candidateHead, file.path),
				]);
				if (
					!base ||
					ours ||
					!theirs ||
					candidate ||
					decodeText(base) === undefined ||
					decodeText(theirs) === undefined
				) {
					return { ok: false, reason: "unsupported_content_structure" };
				}
				if (!base.equals(theirs)) {
					return { ok: false, reason: "protected_content_changed" };
				}
				continue;
			}
			if (
				!REGULAR_MODES.has(file.oldMode) ||
				!REGULAR_MODES.has(file.newMode)
			) {
				return { ok: false, reason: "unsupported_content_structure" };
			}
			const [base, ours, theirs, candidate] = await Promise.all([
				blobAt(input.repoRoot, mergeBase, file.path),
				blobAt(input.repoRoot, approvedHead, file.path),
				blobAt(input.repoRoot, baseOid, file.path),
				blobAt(input.repoRoot, candidateHead, file.path),
			]);
			if (!base || !ours || !theirs || !candidate) {
				return { ok: false, reason: "unsupported_content_structure" };
			}
			const texts = [base, ours, theirs, candidate].map(decodeText);
			if (texts.some((value) => value === undefined)) {
				return { ok: false, reason: "unsupported_content_structure" };
			}
			if (texts.slice(0, 3).some((value) => hasMarkerShapedLine(value!))) {
				return { ok: false, reason: "unsupported_content_structure" };
			}
			if (hasMarkerShapedLine(texts[3]!)) {
				return { ok: false, reason: "candidate_contains_conflict_markers" };
			}
			const merged = await runMergeFile({ base, ours, theirs });
			if (merged.status === 0) {
				if (!merged.stdout.equals(candidate)) {
					return { ok: false, reason: "protected_content_changed" };
				}
				continue;
			}
			const mergeText = decodeText(merged.stdout);
			const parsed =
				mergeText === undefined ? undefined : parseDiff3(mergeText);
			if (!parsed)
				return { ok: false, reason: "unsupported_content_structure" };
			const verified = verifyProtectedSpans(texts[3]!, parsed.protectedSpans);
			if (!verified.ok) {
				return {
					ok: false,
					reason: verified.ambiguous
						? "ambiguous_protected_content"
						: "protected_content_changed",
				};
			}
			if (verified.replacements.length !== parsed.conflicts.length) {
				return { ok: false, reason: "unsupported_content_structure" };
			}
			for (let index = 0; index < parsed.conflicts.length; index += 1) {
				const pieces = deriveProtectedConflictPieces(parsed.conflicts[index]!);
				if (!pieces) {
					return { ok: false, reason: "unsupported_content_structure" };
				}
				const internal = verifyProtectedPieces(
					verified.replacements[index]!,
					pieces,
				);
				if (!internal.ok) {
					return {
						ok: false,
						reason: internal.ambiguous
							? "ambiguous_protected_content"
							: "protected_content_changed",
					};
				}
			}
			conflictFiles.push(file.path);
			conflictParts.push(file.path);
			for (const conflict of parsed.conflicts) {
				conflictParts.push(
					digestParts([conflict.ours]),
					digestParts([conflict.base]),
					digestParts([conflict.theirs]),
				);
			}
			for (const replacement of verified.replacements) {
				conflictParts.push(digestParts([replacement]));
			}
		}
		const candidateTreeOid = (
			await gitText(input.repoRoot, ["rev-parse", `${candidateHead}^{tree}`])
		)
			.trim()
			.toLowerCase();
		return {
			ok: true,
			proofKind: "content_bound_merge_v2",
			rootDigest: input.fingerprint.rootDigest,
			approvedHead,
			mergeBase,
			priorHead,
			baseOid,
			candidateHead,
			candidateTreeOid,
			conflictFiles,
			conflictProofDigest: digestParts(conflictParts),
			requiresFreshQa: conflictFiles.some(
				(path) => !isTrustedTestOnlyPath(path),
			),
		};
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "unsupported_content_structure" ||
				error.message === "proof_resource_limit")
		) {
			return { ok: false, reason: "unsupported_content_structure" };
		}
		return { ok: false, reason: "content_proof_object_unavailable" };
	}
}

/**
 * Production adapter: every fingerprint/proof runs in a disposable bare clone
 * populated from immutable PR/base refs. No runner worktree configuration or
 * uncommitted state participates in the authority decision.
 */
export class GitLandContentProver {
	constructor(
		private readonly projectRootFor: (
			projectName: string,
		) => string | undefined,
	) {}

	private async remoteUrl(projectName: string): Promise<string | undefined> {
		const projectRoot = this.projectRootFor(projectName);
		if (!projectRoot) return undefined;
		try {
			return (
				await gitText(projectRoot, ["remote", "get-url", "origin"])
			).trim();
		} catch {
			return undefined;
		}
	}

	private async withFetchedPr<T>(input: {
		projectName: string;
		prNumber: number;
		extraOids: string[];
		run: (repoRoot: string) => Promise<T>;
	}): Promise<T> {
		const remoteUrl = await this.remoteUrl(input.projectName);
		if (
			!remoteUrl ||
			!Number.isInteger(input.prNumber) ||
			input.prNumber < 1 ||
			!input.extraOids.every((oid) => FULL_SHA.test(oid))
		) {
			throw new Error("invalid_content_proof_input");
		}
		const proofRoot = mkdtempSync(join(tmpdir(), "flywheel-content-proof-"));
		try {
			await gitText(proofRoot, ["init", "--bare"]);
			await gitText(proofRoot, [
				...buildProofFetchArgs(remoteUrl),
				"fetch",
				"--no-tags",
				"--force",
				"--",
				remoteUrl,
				`+refs/pull/${input.prNumber}/head:refs/flywheel/candidate`,
				...input.extraOids,
			]);
			return await input.run(proofRoot);
		} finally {
			rmSync(proofRoot, { recursive: true, force: true });
		}
	}

	async fingerprint(input: {
		projectName: string;
		prNumber: number;
		approvedHead: string;
		baseOid: string;
	}): Promise<ApprovedContentFingerprint> {
		const approvedHead = input.approvedHead.trim().toLowerCase();
		const baseOid = input.baseOid.trim().toLowerCase();
		return this.withFetchedPr({
			projectName: input.projectName,
			prNumber: input.prNumber,
			extraOids: [approvedHead, baseOid],
			run: async (repoRoot) => {
				const mergeBases = (
					await gitText(repoRoot, [
						"merge-base",
						"--all",
						approvedHead,
						baseOid,
					])
				)
					.trim()
					.split(/\s+/)
					.filter(Boolean);
				if (mergeBases.length !== 1 || !FULL_SHA.test(mergeBases[0]!)) {
					throw new Error("content_proof_merge_base_changed");
				}
				return fingerprintApprovedContent({
					repoRoot,
					mergeBase: mergeBases[0]!,
					approvedHead,
				});
			},
		});
	}

	async prove(input: {
		projectName: string;
		prNumber: number;
		fingerprint: ApprovedContentFingerprint;
		priorHead: string;
		baseOid: string;
		candidateHead: string;
	}): Promise<ContentContinuityProof> {
		const priorHead = input.priorHead.trim().toLowerCase();
		const baseOid = input.baseOid.trim().toLowerCase();
		const candidateHead = input.candidateHead.trim().toLowerCase();
		try {
			return await this.withFetchedPr({
				projectName: input.projectName,
				prNumber: input.prNumber,
				extraOids: [
					input.fingerprint.approvedHead,
					input.fingerprint.mergeBase,
					priorHead,
					baseOid,
					candidateHead,
				],
				run: (repoRoot) =>
					proveApprovedContentContinuity({
						repoRoot,
						fingerprint: input.fingerprint,
						approvedHead: input.fingerprint.approvedHead,
						mergeBase: input.fingerprint.mergeBase,
						priorHead,
						baseOid,
						candidateHead,
					}),
			});
		} catch (error) {
			return {
				ok: false,
				reason:
					error instanceof Error &&
					error.message === "invalid_content_proof_input"
						? "invalid_content_proof_input"
						: "content_proof_object_unavailable",
			};
		}
	}
}
