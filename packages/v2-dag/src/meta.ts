import { FenceViolation, type ReadTx, type WriteTx } from "flywheel-v2-kernel";
import type { CanonicalValue } from "./digests.js";
import { canonicalJson } from "./digests.js";

export interface Envelope<T> {
	v: 1;
	revision: number;
	cutover_epoch: number;
	data: T;
}

interface MetaRow {
	value: string;
}

export function readCutoverEpoch(tx: ReadTx): number {
	const raw = tx.get<MetaRow>(
		"SELECT value FROM meta WHERE key='cutover_epoch'",
	)?.value;
	const epoch = raw === undefined ? Number.NaN : Number(raw);
	if (!Number.isSafeInteger(epoch) || epoch <= 0) {
		throw new FenceViolation("cutover_epoch is missing or malformed");
	}
	return epoch;
}

export function makeEnvelope<T>(
	epoch: number,
	data: T,
	revision = 1,
): Envelope<T> {
	return { v: 1, revision, cutover_epoch: epoch, data };
}

export function readEnvelope<T>(
	tx: ReadTx,
	key: string,
	epoch = readCutoverEpoch(tx),
): Envelope<T> | null {
	const raw = tx.get<MetaRow>("SELECT value FROM meta WHERE key=@key", {
		key,
	})?.value;
	if (raw === undefined) return null;
	let parsed: Envelope<T>;
	try {
		parsed = JSON.parse(raw) as Envelope<T>;
	} catch {
		throw new FenceViolation(`meta ${key} is malformed`);
	}
	if (
		parsed.v !== 1 ||
		!Number.isSafeInteger(parsed.revision) ||
		parsed.revision < 1 ||
		parsed.cutover_epoch !== epoch ||
		typeof parsed.data !== "object" ||
		parsed.data === null
	) {
		throw new FenceViolation(`meta ${key} has an invalid envelope`);
	}
	return parsed;
}

export function insertEnvelope<T>(
	tx: WriteTx,
	key: string,
	envelope: Envelope<T>,
	now: string,
): void {
	tx.run(`INSERT INTO meta(key,value,updated_at) VALUES(@key,@value,@now)`, {
		key,
		value: canonicalJson(envelope as unknown as CanonicalValue),
		now,
	});
}

export function updateEnvelope<T>(
	tx: WriteTx,
	key: string,
	current: Envelope<T>,
	data: T,
	now: string,
): Envelope<T> {
	const next = makeEnvelope(current.cutover_epoch, data, current.revision + 1);
	tx.cas(
		`UPDATE meta SET value=@value,updated_at=@now
		 WHERE key=@key
		   AND json_extract(value,'$.revision')=@revision
		   AND json_extract(value,'$.cutover_epoch')=@epoch`,
		{
			key,
			value: canonicalJson(next as unknown as CanonicalValue),
			now,
			revision: current.revision,
			epoch: current.cutover_epoch,
		},
	);
	return next;
}
