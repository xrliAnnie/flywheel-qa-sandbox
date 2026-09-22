import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sanitizeDiscordText } from "../formatting/discord-text.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "../operation-store.js";
import { dailyReportEventId } from "./delivery.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown) => v as Obj;
const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");
function directories(workspace: string): string {
	const state = join(workspace, "state"),
		root = join(state, "daily-report");
	for (const path of [state, root]) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe report artifact directory");
	}
	return root;
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
		if (!stat.isFile() || stat.size > 1024 * 1024)
			throw new Error("invalid report artifact");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
function immutable(workspace: string, name: string, text: string): void {
	const root = directories(workspace),
		path = join(root, name);
	const prior = read(path);
	if (prior !== null) {
		if (prior !== text) throw new Error("report artifact binding conflict");
		return;
	}
	const temporary = join(root, `.${name}.${randomUUID()}.tmp`),
		fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		directories(workspace);
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (read(path) !== text)
				throw new Error("report artifact binding conflict");
		}
	} finally {
		unlinkSync(temporary);
	}
	const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}
function deliveryBody(material: Obj): string {
	const urls = (material.sources as Obj[]).map(
		(source) =>
			`https://github.com/xrliAnnie/raya/blob/${source.head}/${String(source.path).split("/").map(encodeURIComponent).join("/")}`,
	);
	const placeholders = new Map<string, string>();
	let body = String(material.body);
	for (const [index, url] of urls.entries()) {
		const placeholder = `RAYASOURCEURL${index}END`;
		if (body.includes(placeholder))
			throw new Error("report citation placeholder conflict");
		if (body.includes(url)) {
			placeholders.set(placeholder, url);
			body = body.split(url).join(placeholder);
		}
	}
	body = sanitizeDiscordText(body);
	for (const [placeholder, url] of placeholders)
		body = body.split(placeholder).join(url);
	return body;
}
/** UTF-16 bounded chunks; never separates the two units of a surrogate pair. */
function split(text: string): string[] {
	const chunks: string[] = [];
	let chunk = "";
	for (const point of text) {
		if (chunk.length + point.length > 1800) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += point;
	}
	if (chunk) chunks.push(chunk);
	return chunks;
}
export function projectDailyReportArtifacts(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
): StoredOperation {
	const material = obj(current.material);
	if (typeof material.body !== "string") return current;
	const date = String(obj(material.wake).localDate);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		digest(material.body) !== material.bodySha256 ||
		Buffer.byteLength(material.body) !== material.bodyBytes
	)
		throw new Error("report artifact body integrity mismatch");
	const bodyFile = `${date}.body.${material.bodySha256}.md`;
	immutable(workspace, bodyFile, material.body);
	let updated: Obj = { ...material, bodyFile },
		stage = current.stage;
	if (typeof material.fileSha === "string") {
		const texts = [
			{ kind: "title" as const, text: `Raya 日报 · ${date}` },
			...split(deliveryBody(material)).map((text) => ({
				kind: "body" as const,
				text,
			})),
			{
				kind: "footer" as const,
				text: `完整日报：https://github.com/xrliAnnie/raya/blob/main/reports/${date}.md\n对今天的判断有什么补充？可以直接回复任一段。`,
			},
		];
		const chunks = texts.map((chunk, index) => ({
			...chunk,
			index,
			eventId: dailyReportEventId(
				date,
				material.fileSha as string,
				chunk.kind,
				index,
			),
			sha256: digest(chunk.text),
		}));
		const context = {
			schemaVersion: 2,
			operationId: current.operationId,
			date,
			repo: "xrliAnnie/raya",
			ref: "main",
			path: `reports/${date}.md`,
			fileSha: material.fileSha,
			bodyFile,
			bodySha256: material.bodySha256,
			bodyBytes: material.bodyBytes,
			chunks,
		};
		const contextFile = `${date}.context.json`;
		immutable(workspace, contextFile, `${JSON.stringify(context, null, 2)}\n`);
		updated = { ...updated, contextFile, context };
		if (stage === "file_written") stage = "context_ready";
	}
	if (
		stage === current.stage &&
		JSON.stringify(updated) === JSON.stringify(material)
	)
		return current;
	return store.commit(
		{ ...current, stage, material: updated },
		current.revision,
	);
}
