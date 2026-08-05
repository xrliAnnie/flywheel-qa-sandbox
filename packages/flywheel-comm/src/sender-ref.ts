import type { MessageProvenance } from "./types.js";

interface ProtectedSenderRefV1 {
	v: 1;
	lease_key: string;
	generation: number;
	holder_pid?: number;
	holder_start?: string;
	writer_pid?: number;
	writer_start?: string;
}

interface UnprotectedSenderRefV1 {
	v: 1;
	authority: "unprotected";
	writer_pid?: number;
	writer_start?: string;
}

export type SenderRefV1 = ProtectedSenderRefV1 | UnprotectedSenderRefV1;

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`sender_ref ${field} must be a non-empty string`);
	}
	return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`sender_ref ${field} must be a positive safe integer`);
	}
	return value as number;
}

function optionalInteger(value: unknown, field: string): number | undefined {
	return value === undefined ? undefined : positiveSafeInteger(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : nonEmptyString(value, field);
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
	if (unexpected)
		throw new Error(`sender_ref contains unknown key ${unexpected}`);
}

export function decodeSenderRef(encoded: string): SenderRefV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
	} catch {
		throw new Error("sender_ref must be valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("sender_ref must be an object");
	}
	const value = parsed as Record<string, unknown>;
	if (value.v !== 1) throw new Error("sender_ref version is unsupported");

	if ("authority" in value) {
		assertExactKeys(value, ["v", "authority", "writer_pid", "writer_start"]);
		if (value.authority !== "unprotected") {
			throw new Error("sender_ref authority is unsupported");
		}
		const writerPid = optionalInteger(value.writer_pid, "writer_pid");
		const writerStart = optionalString(value.writer_start, "writer_start");
		if (writerStart !== undefined && writerPid === undefined) {
			throw new Error("sender_ref writer_start requires writer_pid");
		}
		return {
			v: 1,
			authority: "unprotected",
			...(writerPid === undefined ? {} : { writer_pid: writerPid }),
			...(writerStart === undefined ? {} : { writer_start: writerStart }),
		};
	}

	assertExactKeys(value, [
		"v",
		"lease_key",
		"generation",
		"holder_pid",
		"holder_start",
		"writer_pid",
		"writer_start",
	]);
	const leaseKey = nonEmptyString(value.lease_key, "lease_key");
	const generation = positiveSafeInteger(value.generation, "generation");
	const holderPid = optionalInteger(value.holder_pid, "holder_pid");
	const holderStart = optionalString(value.holder_start, "holder_start");
	const writerPid = optionalInteger(value.writer_pid, "writer_pid");
	const writerStart = optionalString(value.writer_start, "writer_start");
	if (holderStart !== undefined && holderPid === undefined) {
		throw new Error("sender_ref holder_start requires holder_pid");
	}
	if (writerStart !== undefined && writerPid === undefined) {
		throw new Error("sender_ref writer_start requires writer_pid");
	}
	return {
		v: 1,
		lease_key: leaseKey,
		generation,
		...(holderPid === undefined ? {} : { holder_pid: holderPid }),
		...(holderStart === undefined ? {} : { holder_start: holderStart }),
		...(writerPid === undefined ? {} : { writer_pid: writerPid }),
		...(writerStart === undefined ? {} : { writer_start: writerStart }),
	};
}

export function encodeSenderRef(provenance: MessageProvenance = {}): string {
	const leaseKey = provenance.senderLeaseKey ?? undefined;
	const generation = provenance.senderGeneration ?? undefined;
	if ((leaseKey === undefined) !== (generation === undefined)) {
		throw new Error("sender_ref lease_key and generation must be paired");
	}
	const candidate: SenderRefV1 =
		leaseKey === undefined
			? {
					v: 1,
					authority: "unprotected",
					...(provenance.writerPid == null
						? {}
						: { writer_pid: provenance.writerPid }),
					...(provenance.writerStart == null
						? {}
						: { writer_start: provenance.writerStart }),
				}
			: {
					v: 1,
					lease_key: leaseKey,
					generation: generation as number,
					...(provenance.senderHolderPid == null
						? {}
						: { holder_pid: provenance.senderHolderPid }),
					...(provenance.senderHolderStart == null
						? {}
						: { holder_start: provenance.senderHolderStart }),
					...(provenance.writerPid == null
						? {}
						: { writer_pid: provenance.writerPid }),
					...(provenance.writerStart == null
						? {}
						: { writer_start: provenance.writerStart }),
				};
	return JSON.stringify(decodeSenderRef(JSON.stringify(candidate)));
}

export function processedFenceFromSenderRef(
	encoded: string | null,
): Record<string, string | number> {
	if (encoded === null) return { authority: "lead_write_unprotected" };
	const sender = decodeSenderRef(encoded);
	if ("lease_key" in sender) {
		return {
			lease_key: sender.lease_key,
			lease_generation: sender.generation,
		};
	}
	if (sender.writer_pid !== undefined) return { writer_pid: sender.writer_pid };
	return { authority: "lead_write_unprotected" };
}

export function messageProvenanceFromSenderRef(
	encoded: string | null,
): MessageProvenance | undefined {
	if (encoded === null) return undefined;
	const sender = decodeSenderRef(encoded);
	if ("lease_key" in sender) {
		return {
			senderLeaseKey: sender.lease_key,
			senderGeneration: sender.generation,
			...(sender.holder_pid === undefined
				? {}
				: { senderHolderPid: sender.holder_pid }),
			...(sender.holder_start === undefined
				? {}
				: { senderHolderStart: sender.holder_start }),
			...(sender.writer_pid === undefined
				? {}
				: { writerPid: sender.writer_pid }),
			...(sender.writer_start === undefined
				? {}
				: { writerStart: sender.writer_start }),
		};
	}
	if (sender.writer_pid === undefined) return undefined;
	return {
		writerPid: sender.writer_pid,
		...(sender.writer_start === undefined
			? {}
			: { writerStart: sender.writer_start }),
	};
}
