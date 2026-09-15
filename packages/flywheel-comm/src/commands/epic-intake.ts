import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { LeadNoteCliDeps } from "./lead-note.js";

async function readEvidence(path: string): Promise<unknown> {
	const file = await open(path, "r");
	try {
		if (!(await file.stat()).isFile()) throw new Error("invalid_file");
		const bytes = Buffer.alloc(16385);
		let length = 0;
		while (length < bytes.length) {
			const result = await file.read(
				bytes,
				length,
				bytes.length - length,
				null,
			);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		if (length > 16384) throw new Error("evidence_too_large");
		const value: unknown = JSON.parse(
			bytes.subarray(0, length).toString("utf8"),
		);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("invalid_evidence");
		return value;
	} finally {
		await file.close();
	}
}
export async function runEpicIntake(
	args: string[],
	deps: LeadNoteCliDeps = {},
): Promise<number> {
	const emit = (value: unknown) =>
		(deps.log ?? console.log)(JSON.stringify(value));
	const fail = (error: string) => {
		emit({ ok: false, error });
		return 1;
	};
	const command = args[0];
	if (command !== "show" && command !== "resolve")
		return fail("invalid_arguments");
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({
			args: args.slice(1),
			options: {
				project: { type: "string" },
				lead: { type: "string" },
				"event-uid": { type: "string" },
				"evidence-file": { type: "string" },
				"bridge-url": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
			tokens: true,
		});
		const names = parsed.tokens
			.filter((t) => t.kind === "option")
			.map((t) => t.name);
		if (new Set(names).size !== names.length) return fail("invalid_arguments");
		values = parsed.values;
	} catch {
		return fail("invalid_arguments");
	}
	const env = deps.env ?? process.env;
	const projectName = values.project ?? env.FLYWHEEL_PROJECT_NAME;
	const leadId = values.lead ?? env.FLYWHEEL_LEAD_ID ?? env.LEAD_ID;
	if (!projectName || !leadId) return fail("missing_identity");
	if (!env.TEAMLEAD_API_TOKEN) return fail("missing_token");
	if (
		command === "show" &&
		(values["event-uid"] !== undefined || values["evidence-file"] !== undefined)
	)
		return fail("invalid_arguments");
	let evidence: unknown;
	if (command === "resolve") {
		if (!values["event-uid"] || !values["evidence-file"])
			return fail("invalid_arguments");
		try {
			evidence = await readEvidence(values["evidence-file"]);
		} catch {
			return fail("invalid_evidence_file");
		}
	}
	const base = (
		values["bridge-url"] ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://localhost:9876"
	).replace(/\/+$/, "");
	try {
		const response = await (deps.fetchFn ?? fetch)(
			`${base}/api/epic-intake${command === "show" ? `?${new URLSearchParams({ projectName, leadId })}` : "/resolve"}`,
			{
				method: command === "show" ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}`,
					"Content-Type": "application/json",
				},
				...(command === "resolve"
					? {
							body: JSON.stringify({
								projectName,
								leadId,
								eventUid: values["event-uid"],
								evidence,
							}),
						}
					: {}),
			},
		);
		const result: unknown = await response.json();
		if (!response.ok) {
			emit({ ok: false, error: "bridge_rejected", status: response.status });
			return 1;
		}
		if (
			!result ||
			typeof result !== "object" ||
			!("ok" in result) ||
			result.ok !== true
		)
			return fail("invalid_bridge_response");
		emit(result);
		return 0;
	} catch {
		return fail(
			command === "resolve"
				? "result_unknown_check_show"
				: "bridge_unavailable",
		);
	}
}
