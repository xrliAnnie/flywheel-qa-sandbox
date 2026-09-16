import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LeadRuleSourceRecord } from "./rule-sources.js";

const INDEX_SHA256 =
	"e0b5156c7e3d391c8ba34ee3f9977acd927d69d55ff50c21724a18d93abd691c";
export const RESEARCH_SKILL_GAPS: Readonly<
	Record<
		string,
		"authenticated_research_not_available" | "research_provider_not_admitted"
	>
> = Object.freeze({
	"deep-research": "authenticated_research_not_available",
	last30days: "research_provider_not_admitted",
});
interface AdapterPin {
	name: string;
	sourceSha256: string;
	adapterSha256: string;
	resources: { source: string; sha256: string }[];
}
function bytes(path: string) {
	if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024)
		throw new Error("skill_adapter_unverified");
	return readFileSync(path);
}
const digest = (value: Buffer) =>
	createHash("sha256").update(value).digest("hex");
/** Deployment-pinned adapters; absence/drift stays a visible persona gap, never a raw-helper fallback. */
export function attachLeadSkillAdapters(
	records: readonly LeadRuleSourceRecord[],
	root: string,
): LeadRuleSourceRecord[] {
	let pins: AdapterPin[] = [];
	try {
		const index = bytes(join(root, "source-pins.json"));
		if (digest(index) !== INDEX_SHA256) throw new Error();
		pins = JSON.parse(index.toString("utf8"));
	} catch {
		/* Persona skills remain warn-and-continue. */
	}
	return records.map((record) => {
		const researchGap =
			RESEARCH_SKILL_GAPS[record.sourceId.replace(/^skill\//, "")];
		if (record.layer === "skill" && researchGap)
			return {
				...record,
				status: "missing",
				reason: researchGap,
				adapterPath: null,
				adapterSha256: null,
			};
		// Lead ruling 31ce91bb: these are Runner workflows, not Lead-side helpers.
		if (
			record.layer === "skill" &&
			[
				"skill/xiaohongshu-learning",
				"skill/xiaohongshu-deep-learning",
			].includes(record.sourceId)
		)
			return {
				...record,
				status: "missing",
				reason: "runner_workflow_not_lead_capability",
				adapterPath: null,
				adapterSha256: null,
			};
		if (record.layer !== "skill" || record.status !== "selected")
			return { ...record };
		try {
			const pin = pins.find((row) => `skill/${row.name}` === record.sourceId);
			if (!pin || pin.sourceSha256 !== record.sourceSha256) throw new Error();
			const adapterPath = join(root, pin.name, "SKILL.md");
			if (digest(bytes(adapterPath)) !== pin.adapterSha256) throw new Error();
			for (const resource of pin.resources)
				if (digest(bytes(resource.source)) !== resource.sha256)
					throw new Error();
			return { ...record, adapterPath, adapterSha256: pin.adapterSha256 };
		} catch {
			return {
				...record,
				status: "missing",
				reason: "skill_adapter_unverified",
				adapterPath: null,
				adapterSha256: null,
			};
		}
	});
}
