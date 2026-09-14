import { parseArgs } from "node:util";

export async function runReleaseBugTag(
	args: string[],
	deps: {
		env?: NodeJS.ProcessEnv;
		fetchFn?: typeof fetch;
		log?: (message: string) => void;
	} = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	try {
		const { values, tokens } = parseArgs({
			args,
			allowPositionals: false,
			tokens: true,
			options: {
				issue: { type: "string" },
				"resolve-intent": { type: "string" },
				abandon: { type: "boolean" },
				reason: { type: "string" },
				commit: { type: "string" },
				"base-version": { type: "string" },
				reporter: { type: "string" },
			},
		});
		const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
		const resolving = values["resolve-intent"] !== undefined;
		if (
			new Set(names).size !== names.length ||
			(resolving && !values["resolve-intent"]?.trim()) ||
			(values.abandon
				? !resolving ||
					!!values.issue ||
					!values.reason?.trim() ||
					values.reason.length > 200
				: !values.issue || values.reason !== undefined) ||
			(resolving &&
				(values.commit !== undefined ||
					values["base-version"] !== undefined ||
					values.reporter !== undefined)) ||
			(values.commit === undefined) !== (values["base-version"] === undefined)
		)
			throw new Error("invalid arguments");
		const env = deps.env ?? process.env;
		if (!env.TEAMLEAD_API_TOKEN) throw new Error("master token required");
		const body = values.abandon
			? { abandon: true, reason: values.reason }
			: {
					issueIdentifier: values.issue,
					...(values.commit === undefined
						? {}
						: {
								sourceCommit: values.commit,
								baseVersion: values["base-version"],
							}),
					...(values.reporter === undefined
						? {}
						: { reporter: values.reporter }),
				};
		const root = (
			env.FLYWHEEL_BRIDGE_URL ??
			env.BRIDGE_URL ??
			"http://localhost:9876"
		).replace(/\/+$/, "");
		const path = resolving
			? `bug-intent/${encodeURIComponent(values["resolve-intent"]!)}/resolve`
			: "bug-report";
		const response = await (deps.fetchFn ?? fetch)(
			`${root}/api/release-readiness/${path}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			},
		);
		log(JSON.stringify(await response.json()));
		return response.ok ? 0 : 1;
	} catch (error) {
		log(
			JSON.stringify({
				ok: false,
				error: error instanceof Error ? error.message : "request failed",
			}),
		);
		return 1;
	}
}
