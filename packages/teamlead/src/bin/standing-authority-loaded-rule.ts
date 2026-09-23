import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	canonicalStandingJson,
	extractStandingAuthorityEntry,
	STANDING_AUTHORITY_ENTRY_IDS,
	type StandingAuthorityBackend,
	type StandingAuthorityEntryId,
} from "./standing-authority.js";

export interface StandingAuthorityLoadedRuleReceipt {
	leadIdentity: string;
	backend: StandingAuthorityBackend;
	instanceId: string;
	threadId: string;
	turnId: string;
	rulesDigest: string;
	entryDigest: string;
	observedAt: string;
	sourceReceiptId: string;
	entryId: StandingAuthorityEntryId;
}

const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function buildStandingAuthorityLoadedRuleReceipts(input: {
	baseInstructions: string;
	leadIdentity: string;
	backend: StandingAuthorityBackend;
	instanceId: string;
	threadId: string;
	turnId: string;
	observedAt: string;
}): StandingAuthorityLoadedRuleReceipt[] {
	const markerPresent = STANDING_AUTHORITY_ENTRY_IDS.map((entryId) =>
		input.baseInstructions.includes(`FLY-2654-ENTRY-BEGIN ${entryId}`),
	);
	if (markerPresent.every((present) => !present)) return [];
	if (!markerPresent.every(Boolean))
		throw new Error("standing-authority-loaded-rules-partial");
	for (const value of [
		input.leadIdentity,
		input.instanceId,
		input.threadId,
		input.turnId,
	]) {
		if (!safeId.test(value))
			throw new Error("standing-authority-loaded-receipt-shape");
	}
	if (!Number.isFinite(Date.parse(input.observedAt)))
		throw new Error("standing-authority-loaded-receipt-time");
	const bytes = Buffer.from(input.baseInstructions, "utf8");
	const rulesDigest = sha256(bytes);
	return STANDING_AUTHORITY_ENTRY_IDS.map((entryId) => {
		const identity = {
			leadIdentity: input.leadIdentity,
			backend: input.backend,
			instanceId: input.instanceId,
			threadId: input.threadId,
			turnId: input.turnId,
			rulesDigest,
			entryDigest: sha256(extractStandingAuthorityEntry(bytes, entryId)),
			observedAt: input.observedAt,
			entryId,
		};
		return {
			...identity,
			sourceReceiptId: sha256(canonicalStandingJson(identity)),
		};
	});
}

export function writeStandingAuthorityLoadedRuleReceipts(
	root: string,
	receipts: readonly StandingAuthorityLoadedRuleReceipt[],
): { archivePath: string; latestPath: string }[] {
	return receipts.map((receipt) => {
		const slug = receipt.entryId.replaceAll("/", "--");
		const dir = join(root, slug);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const bytes = `${canonicalStandingJson(receipt)}\n`;
		const archivePath = join(dir, `${receipt.sourceReceiptId}.json`);
		if (existsSync(archivePath)) {
			if (readFileSync(archivePath, "utf8") !== bytes)
				throw new Error("standing-authority-loaded-receipt-conflict");
		} else {
			writeFileSync(archivePath, bytes, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		}
		const latestPath = join(dir, "latest.json");
		const temporary = join(dir, `.latest.${process.pid}.${randomUUID()}.tmp`);
		writeFileSync(temporary, bytes, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, latestPath);
		return { archivePath, latestPath };
	});
}

export type StandingAuthorityLoadedRuleRecord =
	| { status: "recorded"; receipts: number }
	| { status: "skipped"; reason: string };

/**
 * Best-effort evidence recorder for a live Lead turn. The loaded-rule receipt
 * is an audit artifact, never an admission gate: a partial rules bundle (one
 * revoked entry removed), a full disk, or a conflicting archive must be
 * reported and skipped, not thrown into the turn executor after the backend
 * turn has already started.
 */
export function recordStandingAuthorityLoadedRuleReceipts(input: {
	root: string;
	input: Parameters<typeof buildStandingAuthorityLoadedRuleReceipts>[0];
	warn?: (message: string) => void;
}): StandingAuthorityLoadedRuleRecord {
	const warn = input.warn ?? ((message) => console.warn(message));
	try {
		const receipts = buildStandingAuthorityLoadedRuleReceipts(input.input);
		writeStandingAuthorityLoadedRuleReceipts(input.root, receipts);
		return { status: "recorded", receipts: receipts.length };
	} catch (error) {
		const reason =
			error instanceof Error && error.message
				? error.message
				: "standing-authority-loaded-receipt-unknown";
		warn(
			`[standing-authority] loaded-rule receipt skipped (${reason}) lead=${input.input.leadIdentity} turn=${input.input.turnId}`,
		);
		return { status: "skipped", reason };
	}
}
