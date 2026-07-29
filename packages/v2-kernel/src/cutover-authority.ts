import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { defaultCutoverAuthorityPaths } from "./paths.js";

export type CutoverAuthorityState = "pre" | "cutover" | "live";

export interface RollbackReceiptRef {
	path: string;
	digest: string;
}

export interface CutoverAuthority {
	v: 1;
	window_id: string;
	epoch: number;
	state: CutoverAuthorityState;
	revision: number;
	issued_at: string;
	rollback_receipt?: RollbackReceiptRef;
}

interface ArmedMarker {
	v: 1;
	window_id: string;
	epoch: number;
	state: CutoverAuthorityState;
	revision: number;
	authority_digest: string;
}

interface AuthorityTransitionJournal {
	v: 1;
	window_id: string;
	epoch: number;
	from_state: CutoverAuthorityState;
	from_revision: number;
	from_authority_digest: string;
	to_authority: CutoverAuthority;
	to_marker: ArmedMarker;
}

interface RollbackReceipt {
	v: 1;
	window_id: string;
	epoch: number;
	from_revision: number;
	to_revision: number;
	issued_at: string;
	nonce: string;
}

export interface CutoverAuthorityPaths {
	authorityPath: string;
	armedPath: string;
}

export interface ReadCutoverAuthorityOptions extends CutoverAuthorityPaths {
	expectedWindowId?: string;
	expectedEpoch?: number;
}

export type CutoverAuthorityRead =
	| { mode: "legacy" }
	| { mode: "armed"; authority: CutoverAuthority };

interface TransitionOptions extends CutoverAuthorityPaths {
	windowId: string;
	epoch: number;
	nowIso: string;
}

interface RollbackTransitionOptions extends TransitionOptions {
	rollbackReceiptPath: string;
}

function authorityFailure(message: string): Error {
	return new Error(`cutover authority fail closed: ${message}`);
}

function requireAbsolutePath(path: string, name: string): void {
	if (!isAbsolute(path)) {
		throw new TypeError(`${name} must be an absolute path`);
	}
}

function requireNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty`);
	}
}

function requireEpoch(epoch: number): void {
	if (!Number.isSafeInteger(epoch) || epoch <= 0) {
		throw new TypeError("epoch must be a positive safe integer");
	}
}

function requireRevision(revision: number): void {
	if (!Number.isSafeInteger(revision) || revision < 0) {
		throw authorityFailure("revision is malformed");
	}
}

function requireCanonicalIso(value: string, name: string): void {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError(`${name} must be canonical UTC ISO-8601`);
	}
}

function validatePaths(paths: CutoverAuthorityPaths): void {
	requireAbsolutePath(paths.authorityPath, "authorityPath");
	requireAbsolutePath(paths.armedPath, "armedPath");
	if (paths.authorityPath === paths.armedPath) {
		throw new TypeError("authorityPath and armedPath must differ");
	}
}

function stableJson(value: object): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function atomicWrite(path: string, bytes: Buffer): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	const tempPath = join(parent, `.${randomUUID()}.tmp`);
	const fd = openSync(tempPath, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tempPath, path);
	chmodSync(path, 0o600);
	fsyncDirectory(parent);
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

function parseObject(bytes: Buffer, name: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeError(`${name} is not an object`);
		}
		return value as Record<string, unknown>;
	} catch (error) {
		throw authorityFailure(
			`${name} is malformed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseAuthority(bytes: Buffer): CutoverAuthority {
	const value = parseObject(bytes, "authority");
	if (
		!exactKeys(
			value,
			["v", "window_id", "epoch", "state", "revision", "issued_at"],
			["rollback_receipt"],
		) ||
		value.v !== 1 ||
		typeof value.window_id !== "string" ||
		value.window_id.length === 0 ||
		typeof value.epoch !== "number" ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch <= 0 ||
		!["pre", "cutover", "live"].includes(String(value.state)) ||
		typeof value.revision !== "number" ||
		typeof value.issued_at !== "string"
	) {
		throw authorityFailure("authority is malformed");
	}
	requireRevision(value.revision);
	try {
		requireCanonicalIso(value.issued_at, "authority.issued_at");
	} catch (error) {
		throw authorityFailure(
			error instanceof Error ? error.message : String(error),
		);
	}
	let rollbackReceipt: RollbackReceiptRef | undefined;
	if (value.rollback_receipt !== undefined) {
		const ref = value.rollback_receipt;
		if (
			typeof ref !== "object" ||
			ref === null ||
			Array.isArray(ref) ||
			!exactKeys(ref as Record<string, unknown>, ["path", "digest"]) ||
			typeof (ref as Record<string, unknown>).path !== "string" ||
			typeof (ref as Record<string, unknown>).digest !== "string"
		) {
			throw authorityFailure("rollback receipt reference is malformed");
		}
		rollbackReceipt = ref as unknown as RollbackReceiptRef;
	}
	return {
		v: 1,
		window_id: value.window_id,
		epoch: value.epoch,
		state: value.state as CutoverAuthorityState,
		revision: value.revision,
		issued_at: value.issued_at,
		...(rollbackReceipt ? { rollback_receipt: rollbackReceipt } : {}),
	};
}

function parseMarker(bytes: Buffer): ArmedMarker {
	const value = parseObject(bytes, "armed marker");
	if (
		!exactKeys(value, [
			"v",
			"window_id",
			"epoch",
			"state",
			"revision",
			"authority_digest",
		]) ||
		value.v !== 1 ||
		typeof value.window_id !== "string" ||
		value.window_id.length === 0 ||
		typeof value.epoch !== "number" ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch <= 0 ||
		!["pre", "cutover", "live"].includes(String(value.state)) ||
		typeof value.revision !== "number" ||
		typeof value.authority_digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.authority_digest)
	) {
		throw authorityFailure("armed marker is malformed");
	}
	requireRevision(value.revision);
	return value as unknown as ArmedMarker;
}

function parseTransitionJournal(bytes: Buffer): AuthorityTransitionJournal {
	const value = parseObject(bytes, "authority transition journal");
	if (
		!exactKeys(value, [
			"v",
			"window_id",
			"epoch",
			"from_state",
			"from_revision",
			"from_authority_digest",
			"to_authority",
			"to_marker",
		]) ||
		value.v !== 1 ||
		typeof value.window_id !== "string" ||
		value.window_id.length === 0 ||
		typeof value.epoch !== "number" ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch <= 0 ||
		!["pre", "cutover", "live"].includes(String(value.from_state)) ||
		typeof value.from_revision !== "number" ||
		typeof value.from_authority_digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.from_authority_digest) ||
		typeof value.to_authority !== "object" ||
		value.to_authority === null ||
		Array.isArray(value.to_authority) ||
		typeof value.to_marker !== "object" ||
		value.to_marker === null ||
		Array.isArray(value.to_marker)
	) {
		throw authorityFailure("authority transition journal is malformed");
	}
	requireRevision(value.from_revision);
	const toAuthority = parseAuthority(
		stableJson(value.to_authority as Record<string, unknown>),
	);
	const toAuthorityBytes = stableJson(toAuthority);
	const toMarker = parseMarker(
		stableJson(value.to_marker as Record<string, unknown>),
	);
	const fromState = value.from_state as CutoverAuthorityState;
	const legalTransition =
		(fromState === "pre" &&
			value.from_revision === 0 &&
			toAuthority.state === "cutover" &&
			toAuthority.revision === 1) ||
		(fromState === "cutover" &&
			toAuthority.state === "live" &&
			toAuthority.revision === value.from_revision + 1) ||
		((fromState === "cutover" || fromState === "live") &&
			toAuthority.state === "pre" &&
			toAuthority.revision === value.from_revision + 1);
	if (
		!legalTransition ||
		toAuthority.window_id !== value.window_id ||
		toAuthority.epoch !== value.epoch ||
		toMarker.window_id !== toAuthority.window_id ||
		toMarker.epoch !== toAuthority.epoch ||
		toMarker.state !== toAuthority.state ||
		toMarker.revision !== toAuthority.revision ||
		toMarker.authority_digest !== digest(toAuthorityBytes)
	) {
		throw authorityFailure("authority transition journal is inconsistent");
	}
	return {
		v: 1,
		window_id: value.window_id,
		epoch: value.epoch,
		from_state: fromState,
		from_revision: value.from_revision,
		from_authority_digest: value.from_authority_digest,
		to_authority: toAuthority,
		to_marker: toMarker,
	};
}

function parseRollbackReceipt(bytes: Buffer): RollbackReceipt {
	const value = parseObject(bytes, "rollback receipt");
	if (
		!exactKeys(value, [
			"v",
			"window_id",
			"epoch",
			"from_revision",
			"to_revision",
			"issued_at",
			"nonce",
		]) ||
		value.v !== 1 ||
		typeof value.window_id !== "string" ||
		value.window_id.length === 0 ||
		typeof value.epoch !== "number" ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch <= 0 ||
		typeof value.from_revision !== "number" ||
		typeof value.to_revision !== "number" ||
		typeof value.issued_at !== "string" ||
		typeof value.nonce !== "string" ||
		value.nonce.length === 0
	) {
		throw authorityFailure("rollback receipt is malformed");
	}
	requireRevision(value.from_revision);
	requireRevision(value.to_revision);
	if (value.to_revision !== value.from_revision + 1) {
		throw authorityFailure("rollback receipt revision is not monotonic");
	}
	try {
		requireCanonicalIso(value.issued_at, "rollback receipt issued_at");
	} catch (error) {
		throw authorityFailure(
			error instanceof Error ? error.message : String(error),
		);
	}
	return value as unknown as RollbackReceipt;
}

function markerFor(
	authority: CutoverAuthority,
	authorityBytes: Buffer,
): ArmedMarker {
	return {
		v: 1,
		window_id: authority.window_id,
		epoch: authority.epoch,
		state: authority.state,
		revision: authority.revision,
		authority_digest: digest(authorityBytes),
	};
}

function transitionJournalPath(paths: CutoverAuthorityPaths): string {
	return `${paths.armedPath}.transition`;
}

function removeTransitionJournal(paths: CutoverAuthorityPaths): void {
	const path = transitionJournalPath(paths);
	if (!existsSync(path)) return;
	unlinkSync(path);
	fsyncDirectory(dirname(path));
}

function persistTransitionJournal(
	paths: CutoverAuthorityPaths,
	fromAuthority: CutoverAuthority,
	fromAuthorityBytes: Buffer,
	toAuthority: CutoverAuthority,
	toAuthorityBytes: Buffer,
): void {
	const journal: AuthorityTransitionJournal = {
		v: 1,
		window_id: fromAuthority.window_id,
		epoch: fromAuthority.epoch,
		from_state: fromAuthority.state,
		from_revision: fromAuthority.revision,
		from_authority_digest: digest(fromAuthorityBytes),
		to_authority: toAuthority,
		to_marker: markerFor(toAuthority, toAuthorityBytes),
	};
	atomicWrite(transitionJournalPath(paths), stableJson(journal));
}

function recoverPendingTransition(
	options: ReadCutoverAuthorityOptions,
): CutoverAuthority | undefined {
	const journalPath = transitionJournalPath(options);
	if (!existsSync(journalPath)) return undefined;
	let journal: AuthorityTransitionJournal;
	try {
		journal = parseTransitionJournal(readFileSync(journalPath));
	} catch (error) {
		throw authorityFailure(
			`pending transition cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		(options.expectedWindowId !== undefined &&
			journal.window_id !== options.expectedWindowId) ||
		(options.expectedEpoch !== undefined &&
			journal.epoch !== options.expectedEpoch)
	) {
		throw authorityFailure("pending transition window or epoch mismatch");
	}

	let authorityBytes: Buffer;
	try {
		authorityBytes = readFileSync(options.authorityPath);
	} catch (error) {
		throw authorityFailure(
			`pending transition authority cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const authority = parseAuthority(authorityBytes);
	const toAuthorityBytes = stableJson(journal.to_authority);
	const authorityIsSource =
		digest(authorityBytes) === journal.from_authority_digest &&
		authority.window_id === journal.window_id &&
		authority.epoch === journal.epoch &&
		authority.state === journal.from_state &&
		authority.revision === journal.from_revision;
	const authorityIsTarget = authorityBytes.equals(toAuthorityBytes);
	if (!authorityIsSource && !authorityIsTarget) {
		throw authorityFailure(
			"pending transition authority is neither source nor target",
		);
	}

	const toMarkerBytes = stableJson(journal.to_marker);
	let markerIsSource = false;
	let markerIsTarget = false;
	if (existsSync(options.armedPath)) {
		const markerBytes = readFileSync(options.armedPath);
		const marker = parseMarker(markerBytes);
		markerIsSource =
			marker.window_id === journal.window_id &&
			marker.epoch === journal.epoch &&
			marker.state === journal.from_state &&
			marker.revision === journal.from_revision &&
			marker.authority_digest === journal.from_authority_digest;
		markerIsTarget = markerBytes.equals(toMarkerBytes);
	} else {
		markerIsSource =
			journal.from_state === "pre" && journal.from_revision === 0;
	}
	if (!markerIsSource && !markerIsTarget) {
		throw authorityFailure(
			"pending transition marker is neither source nor target",
		);
	}

	if (
		journal.from_state === "pre" &&
		journal.to_authority.state === "cutover"
	) {
		atomicWrite(options.armedPath, toMarkerBytes);
		atomicWrite(options.authorityPath, toAuthorityBytes);
	} else {
		atomicWrite(options.authorityPath, toAuthorityBytes);
		atomicWrite(options.armedPath, toMarkerBytes);
	}
	removeTransitionJournal(options);
	return journal.to_authority;
}

function validateExpected(
	authority: CutoverAuthority,
	options: ReadCutoverAuthorityOptions,
): void {
	if (
		options.expectedWindowId !== undefined &&
		authority.window_id !== options.expectedWindowId
	) {
		throw authorityFailure(
			`window mismatch: expected ${options.expectedWindowId}, found ${authority.window_id}`,
		);
	}
	if (
		options.expectedEpoch !== undefined &&
		authority.epoch !== options.expectedEpoch
	) {
		throw authorityFailure(
			`epoch mismatch: expected ${options.expectedEpoch}, found ${authority.epoch}`,
		);
	}
}

function validateRollback(authority: CutoverAuthority): void {
	if (authority.state !== "pre") return;
	const ref = authority.rollback_receipt;
	if (!ref || !isAbsolute(ref.path)) {
		throw authorityFailure("rollback receipt is required for armed pre state");
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(ref.path);
	} catch (error) {
		throw authorityFailure(
			`rollback receipt is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (digest(bytes) !== ref.digest) {
		throw authorityFailure("rollback receipt digest mismatch");
	}
	const receipt = parseRollbackReceipt(bytes);
	if (
		receipt.window_id !== authority.window_id ||
		receipt.epoch !== authority.epoch ||
		receipt.to_revision !== authority.revision
	) {
		throw authorityFailure("rollback receipt does not bind this authority");
	}
}

export function readCutoverAuthority(
	options: ReadCutoverAuthorityOptions,
): CutoverAuthorityRead {
	validatePaths(options);
	if (!existsSync(options.armedPath)) {
		return { mode: "legacy" };
	}
	let markerBytes: Buffer;
	let authorityBytes: Buffer;
	try {
		markerBytes = readFileSync(options.armedPath);
		authorityBytes = readFileSync(options.authorityPath);
	} catch (error) {
		throw authorityFailure(
			`armed state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const marker = parseMarker(markerBytes);
	const authority = parseAuthority(authorityBytes);
	if (
		marker.authority_digest !== digest(authorityBytes) ||
		marker.window_id !== authority.window_id ||
		marker.epoch !== authority.epoch ||
		marker.state !== authority.state ||
		marker.revision !== authority.revision
	) {
		throw authorityFailure("stale authority digest or revision");
	}
	validateExpected(authority, options);
	validateRollback(authority);
	return { mode: "armed", authority };
}

export function requireLegacyWriterAllowed(
	options: CutoverAuthorityPaths,
): CutoverAuthorityRead {
	const result = readCutoverAuthority(options);
	if (result.mode === "armed" && result.authority.state !== "pre") {
		throw authorityFailure(
			`legacy writer is frozen for window ${result.authority.window_id} in ${result.authority.state} state`,
		);
	}
	return result;
}

export function requireLegacyWriterAllowedFromEnvironment(
	env: Record<string, string | undefined> = process.env,
): CutoverAuthorityRead {
	return requireLegacyWriterAllowed(defaultCutoverAuthorityPaths(env));
}

export function seedPreCutoverAuthority(
	options: TransitionOptions,
): CutoverAuthority {
	validatePaths(options);
	requireNonEmpty(options.windowId, "windowId");
	requireEpoch(options.epoch);
	requireCanonicalIso(options.nowIso, "nowIso");
	if (existsSync(options.armedPath)) {
		throw authorityFailure("cannot seed pre authority after arming");
	}
	const authority: CutoverAuthority = {
		v: 1,
		window_id: options.windowId,
		epoch: options.epoch,
		state: "pre",
		revision: 0,
		issued_at: options.nowIso,
	};
	const bytes = stableJson(authority);
	if (existsSync(options.authorityPath)) {
		const existing = parseAuthority(readFileSync(options.authorityPath));
		if (JSON.stringify(existing) !== JSON.stringify(authority)) {
			throw authorityFailure("existing pre authority conflicts with seed");
		}
		return existing;
	}
	atomicWrite(options.authorityPath, bytes);
	return authority;
}

export function armCutoverAuthority(
	options: TransitionOptions,
): CutoverAuthority {
	validatePaths(options);
	requireNonEmpty(options.windowId, "windowId");
	requireEpoch(options.epoch);
	requireCanonicalIso(options.nowIso, "nowIso");
	const recovered = recoverPendingTransition({
		...options,
		expectedWindowId: options.windowId,
		expectedEpoch: options.epoch,
	});
	if (recovered && recovered.state !== "cutover") {
		throw authorityFailure("pending transition did not arm cutover authority");
	}
	if (existsSync(options.armedPath)) {
		const existing = readCutoverAuthority({
			...options,
			expectedWindowId: options.windowId,
			expectedEpoch: options.epoch,
		});
		if (
			existing.mode === "armed" &&
			existing.authority.state === "cutover" &&
			existing.authority.revision === 1
		) {
			return existing.authority;
		}
		throw authorityFailure("authority is already armed in another state");
	}
	if (!existsSync(options.authorityPath)) {
		throw authorityFailure("pre authority must be seeded before arming");
	}
	const previous = parseAuthority(readFileSync(options.authorityPath));
	if (
		previous.window_id !== options.windowId ||
		previous.epoch !== options.epoch ||
		previous.state !== "pre" ||
		previous.revision !== 0
	) {
		throw authorityFailure("pre authority does not match arm request");
	}
	const authority: CutoverAuthority = {
		v: 1,
		window_id: options.windowId,
		epoch: options.epoch,
		state: "cutover",
		revision: 1,
		issued_at: options.nowIso,
	};
	const authorityBytes = stableJson(authority);
	persistTransitionJournal(
		options,
		previous,
		readFileSync(options.authorityPath),
		authority,
		authorityBytes,
	);
	atomicWrite(
		options.armedPath,
		stableJson(markerFor(authority, authorityBytes)),
	);
	atomicWrite(options.authorityPath, authorityBytes);
	removeTransitionJournal(options);
	return authority;
}

export function publishLiveCutoverAuthority(
	options: TransitionOptions,
): CutoverAuthority {
	validatePaths(options);
	requireNonEmpty(options.windowId, "windowId");
	requireEpoch(options.epoch);
	requireCanonicalIso(options.nowIso, "nowIso");
	recoverPendingTransition({
		...options,
		expectedWindowId: options.windowId,
		expectedEpoch: options.epoch,
	});
	const current = readCutoverAuthority({
		...options,
		expectedWindowId: options.windowId,
		expectedEpoch: options.epoch,
	});
	if (current.mode !== "armed") {
		throw authorityFailure("authority must be armed before live publication");
	}
	if (current.authority.state === "live") return current.authority;
	if (current.authority.state !== "cutover") {
		throw authorityFailure("only cutover authority can advance to live");
	}
	const authority: CutoverAuthority = {
		v: 1,
		window_id: options.windowId,
		epoch: options.epoch,
		state: "live",
		revision: current.authority.revision + 1,
		issued_at: options.nowIso,
	};
	const authorityBytes = stableJson(authority);
	persistTransitionJournal(
		options,
		current.authority,
		readFileSync(options.authorityPath),
		authority,
		authorityBytes,
	);
	atomicWrite(options.authorityPath, authorityBytes);
	atomicWrite(
		options.armedPath,
		stableJson(markerFor(authority, authorityBytes)),
	);
	removeTransitionJournal(options);
	return authority;
}

export function writeRollbackReceipt(options: {
	path: string;
	windowId: string;
	epoch: number;
	fromRevision: number;
	toRevision: number;
	nowIso: string;
	nonce: string;
}): RollbackReceipt {
	requireAbsolutePath(options.path, "path");
	requireNonEmpty(options.windowId, "windowId");
	requireEpoch(options.epoch);
	requireRevision(options.fromRevision);
	requireRevision(options.toRevision);
	requireCanonicalIso(options.nowIso, "nowIso");
	requireNonEmpty(options.nonce, "nonce");
	if (options.toRevision !== options.fromRevision + 1) {
		throw new TypeError("rollback receipt revision must advance by one");
	}
	const receipt: RollbackReceipt = {
		v: 1,
		window_id: options.windowId,
		epoch: options.epoch,
		from_revision: options.fromRevision,
		to_revision: options.toRevision,
		issued_at: options.nowIso,
		nonce: options.nonce,
	};
	atomicWrite(options.path, stableJson(receipt));
	return receipt;
}

export function publishRollbackCutoverAuthority(
	options: RollbackTransitionOptions,
): CutoverAuthority {
	validatePaths(options);
	requireNonEmpty(options.windowId, "windowId");
	requireEpoch(options.epoch);
	requireCanonicalIso(options.nowIso, "nowIso");
	requireAbsolutePath(options.rollbackReceiptPath, "rollbackReceiptPath");
	const recovered = recoverPendingTransition({
		...options,
		expectedWindowId: options.windowId,
		expectedEpoch: options.epoch,
	});
	if (
		recovered?.state === "pre" &&
		recovered.rollback_receipt?.path !== options.rollbackReceiptPath
	) {
		throw authorityFailure(
			"pending rollback transition used another receipt path",
		);
	}
	const current = readCutoverAuthority({
		...options,
		expectedWindowId: options.windowId,
		expectedEpoch: options.epoch,
	});
	if (current.mode !== "armed" || current.authority.state === "pre") {
		if (
			current.mode === "armed" &&
			current.authority.state === "pre" &&
			current.authority.rollback_receipt?.path === options.rollbackReceiptPath
		) {
			return current.authority;
		}
		throw authorityFailure("rollback requires cutover or live authority");
	}
	const receiptBytes = readFileSync(options.rollbackReceiptPath);
	const receipt = parseRollbackReceipt(receiptBytes);
	if (
		receipt.window_id !== options.windowId ||
		receipt.epoch !== options.epoch ||
		receipt.from_revision !== current.authority.revision ||
		receipt.to_revision !== current.authority.revision + 1
	) {
		throw authorityFailure("rollback receipt does not match current authority");
	}
	const authority: CutoverAuthority = {
		v: 1,
		window_id: options.windowId,
		epoch: options.epoch,
		state: "pre",
		revision: receipt.to_revision,
		issued_at: options.nowIso,
		rollback_receipt: {
			path: options.rollbackReceiptPath,
			digest: digest(receiptBytes),
		},
	};
	const authorityBytes = stableJson(authority);
	persistTransitionJournal(
		options,
		current.authority,
		readFileSync(options.authorityPath),
		authority,
		authorityBytes,
	);
	atomicWrite(options.authorityPath, authorityBytes);
	atomicWrite(
		options.armedPath,
		stableJson(markerFor(authority, authorityBytes)),
	);
	removeTransitionJournal(options);
	return authority;
}
