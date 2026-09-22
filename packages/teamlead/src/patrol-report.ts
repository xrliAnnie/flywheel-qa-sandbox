/** Pure report closure validation; recorded receipts are evidence, never authority. */
type Fields = Record<string, string>;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const STEP = /^(?:[1-6]|DWELL)$/;
const PANE_EVIDENCE_FIELDS =
	"pane target owner exec capture_sha256 lines bytes state_sha256 last_change_epoch findings action result schema activity semantic_sha256 last_change_basis last_checked_epoch activity_evidence queue_request queue_position queue_wait_seconds note evidence_note".split(
		" ",
	);
const ACTIVITY_EVIDENCE_FIELDS =
	"id exec activation interval_start interval_end source ref_complete refs_sha256 semantic_sha256 coverage_since reason branch_activity queue_request queue_position queue_wait_seconds".split(
		" ",
	);
const FINDING_FIELDS =
	"id category step bridge_problem result evidence owner next epic epic_marker disposition repair_issue repair_receipt disposition_ref".split(
		" ",
	);
const DISPOSITION_FIELDS =
	"ref findingId mode reason issueIdentifier issueUuid issueUrl receiptUuid verifiedAt rootCause counterexample dedupEvidence linear_record".split(
		" ",
	);
function object(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function exactKeys(v: Record<string, unknown>, allowed: string[]): boolean {
	return (
		Object.keys(v).length === allowed.length &&
		Object.keys(v).every((k) => allowed.includes(k))
	);
}
function prose(v: unknown): v is string {
	return (
		typeof v === "string" &&
		[...v.trim()].length >= 10 &&
		!/\b(?:TODO|TBD|UNSET)\b/i.test(v)
	);
}
function validQueueEvidence(fields: Fields): boolean {
	return (
		(!Object.hasOwn(fields, "queue_request") ||
			TOKEN.test(fields.queue_request ?? "")) &&
		(!Object.hasOwn(fields, "queue_position") ||
			NONNEGATIVE_INTEGER.test(fields.queue_position ?? "")) &&
		(!Object.hasOwn(fields, "queue_wait_seconds") ||
			NONNEGATIVE_INTEGER.test(fields.queue_wait_seconds ?? ""))
	);
}
function validPaneAnnotations(fields: Fields): boolean {
	return ["note", "evidence_note"].every(
		(key) => !Object.hasOwn(fields, key) || TOKEN.test(fields[key] ?? ""),
	);
}
// JSON.parse validates syntax; this additional scan rejects ambiguous repeated keys,
// including escaped spellings and nested dedupEvidence fields.
function strictJson(text: string): unknown {
	const value: unknown = JSON.parse(text);
	const stack: Array<Set<string> | null> = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "{") stack.push(new Set());
		else if (c === "[") stack.push(null);
		else if (c === "}" || c === "]") stack.pop();
		else if (c === '"') {
			const start = i++;
			while (i < text.length) {
				if (text[i] === "\\") i += 2;
				else if (text[i] === '"') break;
				else i++;
			}
			let next = i + 1;
			while (/\s/.test(text[next] ?? "") && next < text.length) next++;
			if (text[next] === ":") {
				const key = JSON.parse(text.slice(start, i + 1)) as string;
				const keys = stack.at(-1);
				if (!keys || keys.has(key)) throw new Error("duplicate_json_key");
				keys.add(key);
			}
		}
	}
	return value;
}
export function validatePatrolReport(text: string): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	const fail = (reason: string) => {
		errors.push(reason);
	};
	const declarations = new Map<string, Fields>(),
		findings = new Map<string, Fields>(),
		dispositions = new Map<string, Record<string, unknown>>();
	const statuses = new Map<string, string>();
	const panes: Fields[] = [];
	const activities = new Map<string, Fields>();
	const activityRecords = new Map<string, Record<string, unknown>>();
	let schemas = 0,
		reviews = 0,
		review: Fields = {};
	function fields(line: string, allowed?: string[]): Fields {
		const result: Fields = {};
		for (const token of line.trim().split(/\s+/).slice(1)) {
			const index = token.indexOf("=");
			const key = token.slice(0, index),
				value = token.slice(index + 1);
			if (
				index < 1 ||
				!value ||
				Object.hasOwn(result, key) ||
				(allowed && !allowed.includes(key))
			)
				fail("invalid_or_duplicate_field");
			result[key] = value;
		}
		return result;
	}
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("patrol_schema")) {
			schemas++;
			if (line !== "patrol_schema=2") fail("report_schema_mismatch");
		} else if (line.startsWith("PANE_EVIDENCE")) {
			const p = fields(line, PANE_EVIDENCE_FIELDS);
			if (!validQueueEvidence(p)) fail("invalid_queue_evidence");
			if (!validPaneAnnotations(p)) fail("invalid_pane_evidence");
			panes.push(p);
		} else if (line.startsWith("ACTIVITY_EVIDENCE")) {
			const a = fields(line, ACTIVITY_EVIDENCE_FIELDS);
			if (!validQueueEvidence(a)) fail("invalid_queue_evidence");
			if (!HEX.test(a.id ?? "") || activities.has(a.id ?? ""))
				fail("invalid_activity_identity");
			activities.set(a.id ?? "", a);
		} else if (line.startsWith("ACTIVITY_RECORD")) {
			try {
				const r = strictJson(line.slice("ACTIVITY_RECORD ".length));
				if (
					!object(r) ||
					typeof r.id !== "string" ||
					!HEX.test(r.id) ||
					activityRecords.has(r.id)
				)
					fail("invalid_activity_record");
				else activityRecords.set(r.id, r);
			} catch {
				fail("invalid_activity_record");
			}
		} else if (line.startsWith("STEP ")) {
			const m =
				/^STEP ([1-6]|DWELL): (OK|FINDING|UNAVAILABLE\((?:transient|structural): [A-Za-z0-9._-]+\))$/.exec(
					line,
				);
			if (!m || statuses.has(m[1] ?? "")) fail("invalid_step");
			else statuses.set(m[1] ?? "", m[2] ?? "");
		} else if (line.startsWith("MECHANISM_REVIEW")) {
			reviews++;
			review = fields(line, ["result", "count"]);
			if (Object.keys(review).length !== 2) fail("invalid_review");
		} else if (line.startsWith("MECHANISM_DEFECT")) {
			const d = fields(line, [
				"id",
				"step",
				"class_key",
				"root_cause_ref",
				"counterexample_ref",
			]);
			if (
				Object.keys(d).length !== 5 ||
				!HEX.test(d.id ?? "") ||
				!HEX.test(d.class_key ?? "") ||
				!STEP.test(d.step ?? "") ||
				!TOKEN.test(d.root_cause_ref ?? "") ||
				!TOKEN.test(d.counterexample_ref ?? "") ||
				declarations.has(d.id ?? "")
			)
				fail("invalid_mechanism_declaration");
			declarations.set(d.id ?? "", d);
		} else if (line.startsWith("FINDING")) {
			const f = fields(line, FINDING_FIELDS);
			if (
				!HEX.test(f.id ?? "") ||
				findings.has(f.id ?? "") ||
				!["incident", "mechanism_defect"].includes(f.category ?? "")
			)
				fail("invalid_finding_identity");
			if (
				!STEP.test(f.step ?? "") ||
				!["yes", "no"].includes(f.bridge_problem ?? "") ||
				!["fixed", "advanced", "escalated-with-plan"].includes(
					f.result ?? "",
				) ||
				!TOKEN.test(f.evidence ?? "")
			)
				fail("invalid_finding");
			if (
				f.result === "escalated-with-plan"
					? !/^(?:founder|agent:[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(
							f.owner ?? "",
						) ||
						!/^(?:inspect|repair|authorize|route|file|retry):[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(
							f.next ?? "",
						)
					: f.owner !== "n/a" || f.next !== "n/a"
			)
				fail("invalid_finding_action");
			if (f.bridge_problem === "yes") {
				if (f.epic === "unavailable") {
					if (
						f.epic_marker !== "n/a" ||
						!text.includes(
							"UNAVAILABLE_CAUSE step=6 class=transient token=linear_epic_unavailable",
						)
					)
						fail("invalid_bridge_unavailable");
				} else if (
					!f.epic?.startsWith("FLY-2072#") ||
					!UUID.test(f.epic.slice(9)) ||
					!HEX.test(f.epic_marker ?? "")
				)
					fail("invalid_bridge_receipt");
			} else if (f.epic !== "n/a" || f.epic_marker !== "n/a")
				fail("invalid_incident_receipt");
			if (
				f.category === "incident" &&
				[
					"disposition",
					"repair_issue",
					"repair_receipt",
					"disposition_ref",
				].some((k) => Object.hasOwn(f, k))
			)
				fail("incident_disposition");
			findings.set(f.id ?? "", f);
		} else if (line.startsWith("MECHANISM_DISPOSITION")) {
			try {
				const d: unknown = strictJson(
					line.slice("MECHANISM_DISPOSITION ".length),
				);
				if (
					!object(d) ||
					!exactKeys(d, DISPOSITION_FIELDS) ||
					typeof d.ref !== "string" ||
					!TOKEN.test(d.ref) ||
					dispositions.has(d.ref)
				) {
					fail("invalid_disposition_json");
					continue;
				}
				dispositions.set(d.ref, d);
			} catch {
				fail("invalid_disposition_json");
			}
		}
	}
	for (const p of panes) {
		if (
			p.activity !== "STALLED_60M" &&
			!p.findings?.split(",").includes("STALLED_60M")
		)
			continue;
		const a = activities.get(p.activity_evidence ?? ""),
			r = activityRecords.get(p.activity_evidence ?? "");
		if (p.schema !== "2" || !a || !r) {
			fail("stalled_evidence_missing");
			continue;
		}
		const start = Number(a.interval_start),
			end = Number(a.interval_end),
			coverage = Number(a.coverage_since);
		if (
			a.exec !== p.exec ||
			a.ref_complete !== "yes" ||
			!HEX.test(a.refs_sha256 ?? "") ||
			!HEX.test(a.semantic_sha256 ?? "") ||
			!["remote_ref", "state", "baseline"].includes(a.source ?? "") ||
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			!Number.isSafeInteger(coverage) ||
			start < 0 ||
			coverage > start ||
			end - start < 3600
		)
			fail("stalled_evidence_incomplete");
		const e = r.entry;
		if (
			r.activity !== "STALLED_60M" ||
			r.interval_start !== start ||
			r.interval_end !== end ||
			typeof r.sampledAtMs !== "number" ||
			Math.floor(r.sampledAtMs / 1000) !== end ||
			!object(e) ||
			!object(e.identity) ||
			e.identity.executionId !== a.exec ||
			e.identity.activationId !== a.activation ||
			e.sourcesComplete !== true ||
			e.semanticDigest !== a.semantic_sha256 ||
			typeof e.coverageSinceMs !== "number" ||
			Math.floor(e.coverageSinceMs / 1000) !== coverage ||
			!Array.isArray(e.refs) ||
			e.refs.length === 0 ||
			!e.refs.every(
				(ref) =>
					object(ref) &&
					typeof ref.repoIdentity === "string" &&
					typeof ref.fullRef === "string" &&
					ref.fullRef.startsWith("refs/heads/") &&
					typeof ref.headSha === "string" &&
					/^[0-9a-f]{40}$/.test(ref.headSha),
			)
		)
			fail("stalled_record_mismatch");
	}

	if (schemas !== 1) fail("report_schema_mismatch");
	if (
		reviews !== 1 ||
		!/^(?:0|[1-9][0-9]*)$/.test(review.count ?? "") ||
		Number(review.count) !== declarations.size ||
		review.result !== (declarations.size === 0 ? "none" : "findings")
	)
		fail("mechanism_review_mismatch");
	const used = new Set<string>();
	for (const [id, f] of findings) {
		if (
			statuses.get(f.step ?? "") !== "FINDING" &&
			!(
				f.step === "DWELL" &&
				statuses.get(f.step ?? "")?.startsWith("UNAVAILABLE(")
			)
		)
			fail("finding_step_mismatch");
		if (f.category !== "mechanism_defect") continue;
		const declaration = declarations.get(id),
			d = dispositions.get(f.disposition_ref ?? "");
		if (
			!declaration ||
			declaration.step !== f.step ||
			!d ||
			used.has(f.disposition_ref ?? "")
		) {
			fail("mechanism_disposition_missing");
			continue;
		}
		used.add(f.disposition_ref ?? "");
		if (
			declaration.root_cause_ref !== f.disposition_ref ||
			declaration.counterexample_ref !== f.disposition_ref ||
			d.findingId !== id ||
			d.mode !== f.disposition ||
			!["existing", "created", "no_issue"].includes(f.disposition ?? "")
		)
			fail("disposition_reference_mismatch");
		if (!prose(d.reason) || !prose(d.rootCause) || !prose(d.counterexample))
			fail("disposition_prose_missing");
		if (d.mode === "no_issue" && d.linear_record === "not_applicable") {
			if (
				f.repair_issue !== "n/a" ||
				f.repair_receipt !== "n/a" ||
				[
					d.issueIdentifier,
					d.issueUuid,
					d.issueUrl,
					d.receiptUuid,
					d.verifiedAt,
					d.dedupEvidence,
				].some((v) => v !== null) ||
				typeof d.reason !== "string" ||
				!/(?:没有(?:相关)?|无相关|no (?:related )?)\s*Linear\s*(?:源\s*)?issue/i.test(
					d.reason,
				) ||
				/(?:不可用|暂时|稍后|memory|unavailable|later)/i.test(d.reason)
			)
				fail("invalid_no_issue_reason");
			continue;
		}
		if (
			!["issue", "comment"].includes(String(d.linear_record)) ||
			(d.mode === "no_issue" && d.linear_record !== "comment") ||
			typeof d.issueIdentifier !== "string" ||
			!/^FLY-[1-9][0-9]*$/.test(d.issueIdentifier) ||
			typeof d.issueUuid !== "string" ||
			!UUID.test(d.issueUuid) ||
			typeof d.receiptUuid !== "string" ||
			!UUID.test(d.receiptUuid) ||
			typeof d.verifiedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T/.test(d.verifiedAt) ||
			!Number.isFinite(Date.parse(d.verifiedAt))
		)
			fail("invalid_linear_receipt");
		if (
			typeof d.issueUrl !== "string" ||
			!new RegExp(
				`^https://linear\\.app/[A-Za-z0-9_-]+/issue/${d.issueIdentifier}(?:/[A-Za-z0-9%._~-]+)?$`,
			).test(d.issueUrl)
		)
			fail("invalid_linear_url");
		if (
			f.repair_receipt !== d.receiptUuid ||
			f.repair_issue !== (d.mode === "no_issue" ? "n/a" : d.issueIdentifier)
		)
			fail("repair_receipt_mismatch");
		const e = d.dedupEvidence;
		if (
			!object(e) ||
			!exactKeys(
				e,
				"complete includeArchived fullDescriptions beforeCount afterCount markerVerified classKey findingId scopeVerified".split(
					" ",
				),
			) ||
			e.complete !== true ||
			e.includeArchived !== true ||
			e.fullDescriptions !== true ||
			e.afterCount !== 1 ||
			e.beforeCount !== (d.mode === "created" ? 0 : 1) ||
			e.markerVerified !== true ||
			e.scopeVerified !== true ||
			e.classKey !== declaration.class_key ||
			e.findingId !== id
		)
			fail("dedup_or_readback_incomplete");
	}
	for (const id of declarations.keys())
		if (findings.get(id)?.category !== "mechanism_defect")
			fail("mechanism_finding_missing");
	for (const ref of dispositions.keys())
		if (!used.has(ref)) fail("orphan_disposition");
	return { valid: errors.length === 0, errors };
}
