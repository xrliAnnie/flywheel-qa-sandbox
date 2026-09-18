import { createHash } from "node:crypto";
import { parseReportDocument } from "../contracts/daily-report.js";
import type { JsonValue } from "../operation-store.js";
import { assertDailyReportBody } from "./generator.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid report repository object");
	return v as Obj;
};
export const reportBlob = (document: string) =>
	createHash("sha1")
		.update(`blob ${Buffer.byteLength(document, "utf8")}\0`)
		.update(document)
		.digest("hex");
export function recordReportRepository(
	stage: string,
	material: Obj,
	result: Obj,
): { stage: string; material: Obj } {
	const date = obj(material.wake).localDate;
	if (
		result.repo !== "xrliAnnie/raya" ||
		result.ref !== "main" ||
		result.path !== `reports/${date}.md`
	)
		throw new Error("report repository binding mismatch");
	if (
		Object.keys(result).some(
			(key) =>
				![
					"action",
					"repo",
					"ref",
					"path",
					"status",
					"fileSha",
					"document",
					"reason",
				].includes(key),
		)
	)
		throw new Error("unknown report repository fields");
	const probing =
		["generated", "reconciling_file"].includes(stage) &&
		result.action === "probe";
	const creating = stage === "creating_file" && result.action === "create";
	if (!probing && !creating)
		throw new Error("report repository stage mismatch");
	const accepted = probing
		? ["exists", "absent", "unknown"]
		: ["created", "conflict", "unknown"];
	if (!accepted.includes(String(result.status)))
		throw new Error("invalid report repository status");
	if (result.status === "unknown" || result.status === "conflict")
		return {
			stage: "reconciling_file",
			material: { ...material, fileFailure: String(result.status) },
		};
	if (result.status === "absent")
		return {
			stage: "creating_file",
			material: { ...material, fileFailure: null },
		};
	const document =
		result.status === "created" ? material.document : result.document;
	if (
		typeof document !== "string" ||
		Buffer.byteLength(document, "utf8") > 512 * 1024
	)
		throw new Error("invalid report repository document");
	if (
		typeof result.fileSha !== "string" ||
		reportBlob(document) !== result.fileSha
	)
		throw new Error("report Git blob mismatch");
	if (
		result.status === "created" &&
		result.document !== undefined &&
		result.document !== material.document
	)
		throw new Error("created report content changed");
	const parsed = parseReportDocument(document, { date: String(date) });
	assertDailyReportBody(parsed.body);
	return {
		stage: "file_written",
		material: {
			...material,
			draftDocument: material.draftDocument ?? material.document,
			draftCitedSources:
				material.draftCitedSources ?? material.citedSources ?? [],
			citedSources:
				result.status === "created" ? (material.citedSources ?? []) : [],
			reportMeta: parsed.meta as unknown as JsonValue,
			adopted: result.status === "exists",
			fileSha: result.fileSha,
			document,
			body: parsed.body,
			bodySha256: parsed.meta.body_sha256,
			bodyBytes: parsed.meta.body_bytes,
			generatedAt: parsed.meta.generated_at,
			mainCommit: parsed.meta.main_commit,
			sources: parsed.meta.sources as unknown as JsonValue,
			silent: parsed.meta.silent as unknown as JsonValue,
			fileFailure: null,
		},
	};
}
