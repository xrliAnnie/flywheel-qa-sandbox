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
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid meeting artifact object");
	return v as Obj;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function root(workspace: string): string {
	const path = join(workspace, "state"),
		stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("unsafe meeting state directory");
	return path;
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
		if (!stat.isFile() || stat.size > 65536)
			throw new Error("invalid meeting artifact file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
export function prepareMeetingStart(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
	input: Obj,
	now: number,
): StoredOperation {
	const result = obj(input.result),
		material = obj(current.material),
		record = obj(material.record);
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		Object.keys(result).some(
			(k) => !["action", "meetingRevision"].includes(k),
		) ||
		result.meetingRevision !== material.meetingRevision ||
		current.stage !== "scheduled"
	)
		throw new Error("meeting start revision or stage mismatch");
	if (Date.parse(String(record.scheduledAt)) > now)
		throw new Error("meeting is not due");
	const existing = read(join(root(workspace), "meeting.json"));
	if (
		existing !== null &&
		JSON.stringify(JSON.parse(existing)) !== JSON.stringify(record)
	)
		throw new Error("trusted meeting slot occupied or changed");
	const starting = { ...record, status: "starting" },
		document = `${JSON.stringify(starting, null, 2)}\n`;
	return store.commit(
		{
			...current,
			stage: "starting",
			material: {
				...material,
				record: starting,
				startProjection: {
					previousHash: existing === null ? null : hash(existing),
					document,
					bodyHash: hash(document),
					meetingRevision: material.meetingRevision,
					projected: false,
				},
				receipts: [
					...(material.receipts as JsonValue[]),
					{
						tool: input.tool,
						callId: input.callId,
						action: "begin_start",
						meetingRevision: material.meetingRevision,
						recordedAt: now,
					},
				],
			},
		},
		current.revision,
	);
}
export function prepareMeetingArchive(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
	input: Obj,
	now: number,
): StoredOperation {
	const result = obj(input.result),
		material = obj(current.material),
		record = obj(material.record);
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		Object.keys(result).some(
			(k) => !["action", "meetingRevision"].includes(k),
		) ||
		result.meetingRevision !== material.meetingRevision ||
		!["ended", "cancelled", "missed"].includes(current.stage) ||
		record.status !== current.stage ||
		typeof record.endedAt !== "string" ||
		!Number.isFinite(Date.parse(record.endedAt))
	)
		throw new Error("terminal meeting archive revision or state mismatch");
	if (material.archive) return current;
	projectMeetingStart(store, workspace, current);
	const document = `${JSON.stringify(record, null, 2)}\n`;
	return store.commit(
		{
			...current,
			material: {
				...material,
				archive: { completed: false },
				startProjection: {
					document,
					bodyHash: hash(document),
					previousHash: null,
					meetingRevision: material.meetingRevision,
					projected: false,
				},
				receipts: [
					...(material.receipts as JsonValue[]),
					{
						tool: input.tool,
						callId: input.callId,
						action: "archive_terminal",
						meetingRevision: material.meetingRevision,
						recordedAt: now,
					},
				],
			},
		},
		current.revision,
	);
}
function archiveDirectory(directory: string, id: JsonValue): string {
	if (
		typeof id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			id,
		)
	)
		throw new Error("invalid meeting archive identity");
	let path = directory;
	for (const part of ["meetings", id]) {
		path = join(path, part);
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe meeting archive directory");
	}
	return path;
}
export function projectMeetingStart(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
): StoredOperation {
	const material = obj(current.material);
	if (material.startProjection === undefined) return current;
	const projection = obj(material.startProjection);
	if (
		typeof projection.document !== "string" ||
		hash(projection.document) !== projection.bodyHash ||
		projection.meetingRevision !== material.meetingRevision
	)
		throw new Error("meeting projection integrity mismatch");
	const directory = root(workspace),
		archive = material.archive !== undefined,
		targetDirectory = archive
			? archiveDirectory(directory, obj(material.record).id)
			: directory,
		path = join(targetDirectory, "meeting.json");
	if (projection.projected === true) {
		if (read(path) !== projection.document)
			throw new Error(
				"projected meeting changed; reconcile before voice action",
			);
		return current;
	}
	const lockPath = join(directory, ".meeting-write.lock"),
		nonce = randomUUID();
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				"meeting artifact locked; explicit owner recovery required",
			);
		throw error;
	}
	const temporary = join(directory, `.meeting.${nonce}.tmp`);
	let created = false;
	const errors: unknown[] = [];
	try {
		writeFileSync(lock, nonce);
		fsyncSync(lock);
		const existing = read(path);
		if (existing !== projection.document) {
			if (
				(existing === null ? null : hash(existing)) !== projection.previousHash
			)
				throw new Error("meeting artifact changed before projection");
			const fd = openSync(temporary, "wx", 0o600);
			created = true;
			try {
				writeFileSync(fd, projection.document);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			root(workspace);
			renameSync(temporary, path);
			created = false;
			const dir = openSync(
				directory,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
		}
		if (archive) {
			const slot = join(directory, "meeting.json"),
				existing = read(slot);
			if (existing !== null) {
				if (existing === projection.document) unlinkSync(slot);
				else if (obj(JSON.parse(existing)).id === obj(material.record).id)
					throw new Error("current meeting changed before archive cleanup");
			}
			for (const dirPath of [targetDirectory, directory]) {
				const fd = openSync(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			}
		}
	} catch (error) {
		errors.push(error);
	}
	if (created)
		try {
			unlinkSync(temporary);
		} catch (error) {
			errors.push(error);
		}
	try {
		closeSync(lock);
	} catch (error) {
		errors.push(error);
	}
	try {
		root(workspace);
		if (read(lockPath) !== nonce)
			throw new Error("meeting artifact lock ownership changed");
		unlinkSync(lockPath);
	} catch (error) {
		errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "meeting projection and cleanup failed");

	return store.commit(
		{
			...current,
			material: {
				...material,
				startProjection: { ...projection, projected: true },
				...(archive ? { archive: { completed: true } } : {}),
			},
		},
		current.revision,
	);
}
