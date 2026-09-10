import { parseArgs } from "node:util";

export interface LeadNoteCliDeps {
	env?: Record<string, string | undefined>;
	fetchFn?: (
		url: string,
		init: { method: string; headers: Record<string, string>; body?: string },
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
}

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const validNote = (value: unknown) =>
	object(value) &&
	Object.keys(value).length === 3 &&
	typeof value.text === "string" &&
	value.text.length > 0 &&
	typeof value.role === "string" &&
	value.role.length > 0 &&
	typeof value.written_at === "string" &&
	Number.isFinite(Date.parse(value.written_at)) &&
	new Date(value.written_at).toISOString() === value.written_at;

export async function runLeadNote(
	args: string[],
	deps: LeadNoteCliDeps = {},
): Promise<number> {
	const emit = (value: unknown) =>
		(deps.log ?? console.log)(JSON.stringify(value));
	const fail = (error: string, diagnostic: string, status?: number) => {
		emit({ ok: false, error, ...(status === undefined ? {} : { status }) });
		(deps.errorLog ?? console.error)(`lead-note: ${diagnostic}`);
		return 1;
	};
	const command = args[0];
	const usage =
		"use set|show|clear --project <project> --issue <ID> [--role <role>] [--text <text>]";
	if (command !== "set" && command !== "show" && command !== "clear")
		return fail("invalid_arguments", usage);
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({
			args: args.slice(1),
			options: {
				project: { type: "string" },
				issue: { type: "string" },
				role: { type: "string" },
				text: { type: "string" },
				"bridge-url": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
			tokens: true,
		});
		const names = parsed.tokens
			.filter((token) => token.kind === "option")
			.map((token) => token.name);
		if (new Set(names).size !== names.length)
			return fail("invalid_arguments", usage);
		values = parsed.values;
	} catch {
		return fail("invalid_arguments", usage);
	}
	if (
		!values.issue ||
		(command !== "show" && !values.role) ||
		(command === "set" ? values.text === undefined : values.text !== undefined)
	)
		return fail("invalid_arguments", usage);
	const env = deps.env ?? process.env;
	const projectName = values.project ?? env.FLYWHEEL_PROJECT_NAME;
	if (!projectName) return fail("missing_project", "project is required");
	if (!env.TEAMLEAD_API_TOKEN)
		return fail("missing_token", "token is required");
	const body = {
		projectName,
		issue: values.issue,
		...(values.role === undefined ? {} : { role: values.role }),
		...(values.text === undefined ? {} : { text: values.text }),
	};
	const url = (
		values["bridge-url"] ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://localhost:9876"
	).replace(/\/+$/, "");
	const checkFirst =
		command === "show"
			? "read failed"
			: "write result unknown; run lead-note show before retrying";
	let response: Awaited<ReturnType<NonNullable<LeadNoteCliDeps["fetchFn"]>>>;
	try {
		response = await (deps.fetchFn ?? fetch)(
			`${url}/api/lead-note/${command}${command === "show" ? `?${new URLSearchParams(body)}` : ""}`,
			command === "show"
				? {
						method: "GET",
						headers: { Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}` },
					}
				: {
						method: "POST",
						headers: {
							Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					},
		);
	} catch {
		return fail("network_error", checkFirst);
	}
	let result: unknown;
	try {
		result = await response.json();
	} catch {
		return fail("invalid_response", checkFirst);
	}
	if (!response.ok) {
		const error =
			object(result) &&
			typeof result.error === "string" &&
			/^[a-z][a-z_]{0,63}$/.test(result.error)
				? result.error
				: "http_error";
		return fail(
			error,
			response.status >= 500 ? checkFirst : "request rejected",
			response.status,
		);
	}
	if (
		!object(result) ||
		result.ok !== true ||
		result.command !== command ||
		result.project !== projectName ||
		result.issue !== values.issue ||
		typeof result.issue_uuid !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			result.issue_uuid,
		)
	)
		return fail("invalid_response", checkFirst);
	const base = {
		ok: true,
		command,
		project: projectName,
		issue: values.issue,
		issue_uuid: result.issue_uuid,
	};
	if (command === "show") {
		if (!Array.isArray(result.notes) || !result.notes.every(validNote))
			return fail("invalid_response", checkFirst);
		emit({ ...base, notes: result.notes });
	} else if (command === "set") {
		if (
			!validNote(result.note) ||
			!object(result.note) ||
			result.note.role !== values.role ||
			!["invoked", "unavailable"].includes(String(result.refresh))
		)
			return fail("invalid_response", checkFirst);
		emit({ ...base, note: result.note, refresh: result.refresh });
	} else {
		if (
			result.role !== values.role ||
			typeof result.changed !== "boolean" ||
			!(result.changed ? ["invoked", "unavailable"] : ["unchanged"]).includes(
				String(result.refresh),
			)
		)
			return fail("invalid_response", checkFirst);
		emit({
			...base,
			role: result.role,
			changed: result.changed,
			refresh: result.refresh,
		});
	}
	return 0;
}
