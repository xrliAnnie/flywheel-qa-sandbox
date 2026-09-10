import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function read(path) {
	const rows = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(rows)) throw new Error("alert inventory must be array");
	const result = new Map();
	for (const row of rows) {
		if (
			!row ||
			typeof row.path !== "string" ||
			!/^(meta-alert|alert-deadletter)\/[^/]+$/.test(row.path) ||
			row.path.includes("\0") ||
			[".", ".."].includes(row.path.split("/")[1]) ||
			result.has(row.path) ||
			typeof row.content !== "string" ||
			createHash("sha256").update(row.content).digest("hex") !== row.sha256
		)
			throw new Error("invalid alert file evidence");
		let leadId = null,
			classification = "unparsed";
		if (!row.path.includes(".tmp.")) {
			if (row.path.startsWith("meta-alert/") && row.path.endsWith(".txt")) {
				const matches = [
					...row.content.matchAll(/(?:\(|, )lead=([^,)\n]*)(?=[,)])/g),
				].map((match) => match[1]);
				if (matches.length === 1) leadId = matches[0];
			} else {
				try {
					const value = JSON.parse(row.content);
					if (typeof value?.leadId === "string") leadId = value.leadId;
				} catch {
					/* Preserve only file identity for non-JSON production records. */
				}
			}
			if (leadId !== null)
				classification = /^flywheel-[a-z0-9-]+$/.test(leadId)
					? "managed"
					: "foreign";
		}
		result.set(row.path, {
			path: row.path,
			sha256: row.sha256,
			leadId,
			classification,
		});
	}
	return result;
}
export function alertDirsAttribution({ beforePath, afterPath, slotLead }) {
	try {
		if (!/^flywheel-test-\d+$/.test(slotLead))
			throw new Error("invalid slot lead");
		const before = read(beforePath),
			after = read(afterPath);
		const changed = [...after.values()].filter(
			(row) => before.get(row.path)?.sha256 !== row.sha256,
		);
		const baseline = [...before.values()].filter(
			(row) => row.leadId === slotLead,
		);
		const baselinePaths = new Set(baseline.map((row) => row.path));
		const pollution = [...after.values()].filter(
			(row) => row.leadId === slotLead && !baselinePaths.has(row.path),
		);
		const foreign = [...after.values()].filter(
			(row) => row.classification === "foreign",
		);
		const unparsed = [...after.values()].filter(
			(row) => row.classification === "unparsed",
		);
		const production = changed.filter(
			(row) => row.leadId !== null && row.leadId !== slotLead,
		);
		const unknown = changed.filter((row) => row.leadId === null);
		return {
			status: pollution.length
				? "fail"
				: unknown.length
					? "needs-attribution"
					: "pass",
			baselineHitCount: baseline.length,
			newHitCount: pollution.length,
			baseline,
			foreign,
			foreignCounts: [...new Set(foreign.map((row) => row.leadId))].map(
				(leadId) => ({
					leadId,
					count: foreign.filter((row) => row.leadId === leadId).length,
				}),
			),
			unparsed,
			unknown,
			pollution,
			production,
			removed: [...before.keys()].filter((path) => !after.has(path)),
		};
	} catch (error) {
		return { status: "fail", reason: error.message };
	}
}
