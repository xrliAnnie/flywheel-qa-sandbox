import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import type { BusinessRoundView } from "./business-round.js";
import type { Meeting } from "./meeting.js";
import {
	type MeetingRecordOptions,
	toMeetingRecord,
} from "./meeting-record.js";
import { source as meetingSource } from "./meeting-round.js";
import { validateMeeting } from "./meeting-store.js";
import {
	type JsonValue,
	OperationStore,
	type StoredOperation,
} from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function directory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe legacy meeting directory");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
function read(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 32 * 1024)
			throw new Error("invalid legacy meeting file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
function inventory(workspace: string) {
	const root = realpathSync(workspace),
		base = join(root, "state/meetings");
	if (!directory(join(root, "state")) || !directory(base)) return [];
	const paths = ["state/meetings/current.json"];
	if (directory(join(base, "archive"))) {
		const names = readdirSync(join(base, "archive")).sort();
		if (names.length > 1000)
			throw new Error("legacy meeting inventory too large");
		for (const name of names) {
			if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5)))
				throw new Error("unknown legacy meeting archive entry");
			paths.push(`state/meetings/archive/${name}`);
		}
	}
	const entries: {
		path: string;
		raw: string;
		meeting: ReturnType<typeof validateMeeting>;
	}[] = [];
	let total = 0;
	for (const path of paths) {
		const raw = read(join(root, path));
		if (raw === null) {
			if (path.endsWith("/current.json")) continue;
			throw new Error("legacy meeting archive changed");
		}
		total += Buffer.byteLength(raw);
		if (total > 256 * 1024)
			throw new Error("legacy meeting inventory too large");
		const parsed = JSON.parse(raw);
		const meeting = validateMeeting(parsed);
		if (
			Object.keys(parsed).some(
				(key) =>
					![
						"meetingId",
						"revision",
						"title",
						"startsAt",
						"participants",
						"status",
						"calendarEventId",
						"outboundMessageId",
						"mailboxDeliveryId",
						"notification",
					].includes(key),
			)
		)
			throw new Error("unknown legacy meeting schema");
		for (const key of [
			"calendarEventId",
			"outboundMessageId",
			"mailboxDeliveryId",
		]) {
			if (
				parsed[key] !== undefined &&
				(typeof parsed[key] !== "string" || !parsed[key].trim())
			)
				throw new Error("invalid legacy meeting receipt identity");
		}
		if (
			!meeting.participants.every(
				(lead) =>
					typeof lead.project === "string" &&
					!!lead.project.trim() &&
					typeof lead.leadId === "string" &&
					!!lead.leadId.trim(),
			)
		)
			throw new Error("invalid legacy meeting participant");
		if (
			!["scheduled", "rescheduled", "cancelled"].includes(
				String(meeting.status),
			)
		)
			throw new Error("unknown legacy meeting status");
		if (
			path.includes("/archive/") &&
			(path !== `state/meetings/archive/${meeting.meetingId}.json` ||
				meeting.status !== "cancelled")
		)
			throw new Error("legacy meeting archive identity or terminal mismatch");
		const old = entries.find(
			(entry) => entry.meeting.meetingId === meeting.meetingId,
		);
		if (old && hash(old.meeting) !== hash(meeting))
			throw new Error("legacy meeting identity conflict");
		entries.push({ path, raw, meeting });
	}
	return entries;
}
export function planLegacyMeetings(workspace: string) {
	const entries = inventory(workspace);
	return {
		schemaVersion: 1,
		kind: "legacy_meetings_migration",
		digest: hash(entries),
		meetings: entries.map(({ path, meeting }) => ({
			path,
			meetingId: meeting.meetingId,
			revision: meeting.revision,
			action:
				meeting.status === "cancelled" ? "preserve_terminal" : "reconcile",
		})),
	};
}
export function applyLegacyMeetings(
	workspace: string,
	digest: string,
	identity: { flywheelSha: string; rayaSha: string },
) {
	if (
		!/^[a-f0-9]{64}$/.test(digest) ||
		Object.keys(identity).length !== 2 ||
		![identity.flywheelSha, identity.rayaSha].every((sha) =>
			/^[a-f0-9]{40}$/.test(sha),
		)
	)
		throw new Error("legacy meeting digest and paired SHAs required");
	const entries = inventory(workspace);
	if (hash(entries) !== digest)
		throw new Error("legacy meeting inventory changed");
	if (!entries.length) return { digest, operations: [] };
	const store = new OperationStore(workspace),
		binding = hash({ digest, ...identity }),
		backupId = `legacy-meetings-backup:${binding}`;
	const unique = [
		...new Map(
			entries.map((entry) => [entry.meeting.meetingId, entry.meeting]),
		).values(),
	];
	for (const meeting of unique) {
		const old = store.read(`legacy-meeting:${meeting.meetingId}`);
		if (old && (old.kind !== "legacy_meeting" || old.inputDigest !== binding))
			throw new Error("legacy meeting target conflict");
		const standard = store.read(`meeting:${meeting.meetingId}`);
		if (
			standard &&
			(standard.kind !== "meeting" ||
				(standard.material as Obj).legacyMigration === undefined ||
				((standard.material as Obj).legacyMigration as Obj).binding !== binding)
		)
			throw new Error(
				"legacy meeting already has a standard operation; reconcile before import",
			);
	}
	const material = {
		entries: entries as unknown as JsonValue,
		digest,
		identity,
	};
	const backup = store.read(backupId);
	if (backup) {
		if (
			backup.kind !== "migration_backup" ||
			backup.inputDigest !== binding ||
			hash(backup.material) !== hash(material)
		)
			throw new Error("legacy meeting backup conflict");
	} else
		store.commit(
			{
				operationId: backupId,
				kind: "migration_backup",
				inputDigest: binding,
				stage: "complete",
				sourceRefs: entries.map((entry) => entry.path),
				material,
			},
			0,
		);
	const operations = [];
	for (const meeting of unique) {
		if (hash(inventory(workspace)) !== digest)
			throw new Error("legacy meeting source changed after backup");
		const operationId = `legacy-meeting:${meeting.meetingId}`;
		operations.push(operationId);
		const old = store.read(operationId);
		if (old) {
			if (old.kind !== "legacy_meeting" || old.inputDigest !== binding)
				throw new Error("legacy meeting target conflict");
			continue;
		}
		store.commit(
			{
				operationId,
				kind: "legacy_meeting",
				inputDigest: binding,
				stage:
					meeting.status === "cancelled"
						? "cancelled"
						: "legacy_reconciliation",
				sourceRefs: entries
					.filter((entry) => entry.meeting.meetingId === meeting.meetingId)
					.map((entry) => entry.path),
				material: {
					legacy: meeting as unknown as JsonValue,
					backupId,
					receipts: [{ action: "import_legacy_meeting", digest, identity }],
				},
			},
			0,
		);
	}
	return { digest, operations };
}
export function legacyMeetingView(
	current: StoredOperation,
	store?: OperationStore,
): BusinessRoundView {
	const material = current.material as Obj,
		legacy = material.legacy as Obj,
		pending = current.stage === "legacy_reconciliation";
	const child = store?.read(`meeting:${legacy.meetingId}`);
	if (
		child &&
		child.kind === "meeting" &&
		(child.material as Obj).legacyMigration &&
		((child.material as Obj).legacyMigration as Obj).operationId ===
			current.operationId
	)
		return {
			schemaVersion: 2,
			operationId: current.operationId,
			revision: current.revision,
			stage: "adopted",
			needsReconciliation: false,
			receipts: material.receipts as Obj[],
			material,
			next: {
				tool: "current_turn",
				arguments: { action: "resume", operationId: child.operationId },
			},
		};
	return {
		schemaVersion: 2,
		operationId: current.operationId,
		revision: current.revision,
		stage: current.stage,
		needsReconciliation: pending,
		receipts: material.receipts as Obj[],
		material,
		next: pending
			? {
					tool: "current_turn",
					arguments: {
						action: "reconcile_legacy_meeting",
						meetingId: legacy.meetingId,
						backupId: material.backupId,
						instructions:
							"Preserve UUID, revision and calendar identity. Obtain original requester, duration and source evidence; reconcile trusted meeting.json and public voice status before mapping to v2. Mailbox delivery is not Discord delivery or a live voice session. Do not replace trusted records or replay old drivers.",
					},
				}
			: null,
	};
}

export function adoptLegacyMeeting(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
	input: Obj,
): StoredOperation {
	const material = current.material as Obj,
		meeting = material.legacy as unknown as Meeting;
	const result = input.result as Obj;
	if (
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		result.action !== "adopt_legacy_meeting" ||
		current.stage !== "legacy_reconciliation"
	)
		throw new Error("invalid legacy meeting adoption");
	if (
		Object.keys(result).some(
			(key) =>
				![
					"action",
					"metadataSourceRef",
					"source",
					"founderUserId",
					"durationMinutes",
					"directory",
					"continuesFrom",
					"trustedRecordSha256",
				].includes(key),
		) ||
		typeof result.metadataSourceRef !== "string" ||
		!result.metadataSourceRef.trim()
	)
		throw new Error("legacy meeting original metadata required");
	const source = meetingSource(result.source, result.founderUserId);
	const options = {
		directory: result.directory,
		durationMinutes: result.durationMinutes,
		requestedBy: source.authorId,
		requestedAt: new Date(Number(source.observedAt)).toISOString(),
		...(result.continuesFrom === undefined
			? {}
			: { continuesFrom: result.continuesFrom }),
	};
	let record = toMeetingRecord(
		meeting,
		options as unknown as MeetingRecordOptions,
	);
	const operationId = `meeting:${meeting.meetingId}`,
		inputDigest = hash({ binding: current.inputDigest, result });
	const old = store.read(operationId);
	if (old) {
		if (old.kind !== "meeting" || old.inputDigest !== inputDigest)
			throw new Error("legacy meeting adoption binding conflict");
		return old;
	}
	const root = realpathSync(workspace);
	if (!directory(join(root, "state")))
		throw new Error("legacy meeting state missing");

	const trusted = read(join(root, "state/meeting.json"));
	const archiveDir = join(root, "state/meetings", meeting.meetingId);
	const archived = directory(archiveDir)
		? read(join(archiveDir, "meeting.json"))
		: null;
	let projection: Obj | undefined,
		voice: Obj | undefined,
		voiceCall: Obj | undefined;
	if (result.trustedRecordSha256 !== undefined) {
		const raw = archived ?? trusted;
		if (
			raw === null ||
			typeof result.trustedRecordSha256 !== "string" ||
			createHash("sha256").update(raw).digest("hex") !==
				result.trustedRecordSha256
		)
			throw new Error("trusted meeting observation changed");
		const observed = JSON.parse(raw) as Obj;
		if (
			!observed ||
			typeof observed !== "object" ||
			Array.isArray(observed) ||
			Object.keys(observed).some(
				(key) =>
					![
						"schemaVersion",
						"id",
						"leadId",
						"topic",
						"scheduledAt",
						"durationMinutes",
						"requestedBy",
						"requestedAt",
						"continuesFrom",
						"status",
						"voice",
						"endedAt",
						"endReason",
					].includes(key),
			) ||
			Object.entries(record).some(
				([key, value]) => key !== "status" && observed[key] !== value,
			) ||
			observed.continuesFrom !== record.continuesFrom
		)
			throw new Error("trusted meeting original identity mismatch");
		const terminal = ["ended", "cancelled", "missed"].includes(
			String(observed.status),
		);
		if (
			![
				"scheduled",
				"starting",
				"live",
				"interrupted",
				"ended",
				"cancelled",
				"missed",
			].includes(String(observed.status)) ||
			(archived !== null && !terminal) ||
			(terminal &&
				(typeof observed.endedAt !== "string" ||
					!Number.isFinite(Date.parse(observed.endedAt)))) ||
			(!terminal &&
				(observed.endedAt !== undefined || observed.endReason !== undefined))
		)
			throw new Error("invalid trusted meeting status");
		if (observed.voice !== undefined) {
			const v = observed.voice as Obj;
			if (
				!v ||
				typeof v !== "object" ||
				Array.isArray(v) ||
				typeof v.sessionId !== "string" ||
				!/^[A-Za-z0-9_-]{1,200}$/.test(v.sessionId)
			)
				throw new Error("trusted voice session identity missing");
			voice = {
				sessionId: v.sessionId,
				meetingRevision: meeting.revision,
				status: "unverified",
			};
		}
		if (!terminal && observed.status !== "scheduled" && !voice)
			throw new Error("trusted active voice session identity missing");
		if (!terminal && (voice || observed.status !== "scheduled"))
			voiceCall = { command: "status", inFlight: false, outcome: "unknown" };
		record = observed as unknown as typeof record;
		projection = {
			document: raw,
			bodyHash: result.trustedRecordSha256,
			meetingRevision: meeting.revision,
			projected: true,
		};
	} else if (
		archived !== null ||
		(trusted !== null && hash(JSON.parse(trusted)) !== hash(record))
	)
		throw new Error(
			"trusted meeting slot occupied or changed; original record observation required",
		);
	const notification = meeting.notification as unknown as Obj | undefined;
	const unavailable =
		notification?.status === "unavailable" &&
		notification.reason === "lead_transport_not_available" &&
		!meeting.outboundMessageId &&
		!meeting.mailboxDeliveryId;
	return store.commit(
		{
			operationId,
			inputDigest,
			kind: "meeting",
			stage: record.status,
			sourceRefs: [
				current.operationId,
				...current.sourceRefs,
				result.metadataSourceRef,
			],
			material: {
				source,
				founderUserId: result.founderUserId,
				meeting: meeting as unknown as JsonValue,
				record: record as unknown as JsonValue,
				options,
				meetingRevision: meeting.revision,
				...(projection ? { startProjection: projection } : {}),
				...(archived !== null ? { archive: { completed: true } } : {}),
				...(voice ? { voice } : {}),
				...(voiceCall ? { voiceCall } : {}),
				history: [],
				changes: {},
				calendar: {
					status: "unknown",
					meetingRevision: meeting.revision,
					...(meeting.calendarEventId === undefined
						? {}
						: { eventId: meeting.calendarEventId }),
				},
				notification: {
					status: unavailable ? "unavailable" : "legacy_unknown",
					meetingRevision: meeting.revision,
				},
				legacyMigration: {
					operationId: current.operationId,
					binding: current.inputDigest,
					backupId: material.backupId,
				},
				receipts: [
					{ tool: input.tool, callId: input.callId, result: input.result },
				],
			},
		},
		0,
	);
}
