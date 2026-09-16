#!/usr/bin/env node
// Rollback preparation. Input is an explicit inventory of {threadId, tokenEnv}; never credentials.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function stripNeedsAnswer(name) {
	return name.replace(/^🔔要你答(?:\s+|$)/u, "");
}
export async function reconcileTargets(
	targets,
	{
		apply = false,
		fetchImpl = fetch,
		env = process.env,
		report = console.log,
	} = {},
) {
	if (!Array.isArray(targets) || targets.length > 5000)
		throw new Error("Expected at most 5000 explicit targets");
	const seen = new Set();
	for (const target of targets) {
		if (
			!target ||
			typeof target.threadId !== "string" ||
			typeof target.tokenEnv !== "string" ||
			!/^[1-9][0-9]{16,19}$/.test(target.threadId) ||
			!/^[A-Z_][A-Z0-9_]*$/.test(target.tokenEnv) ||
			seen.has(target.threadId)
		)
			throw new Error("Invalid or duplicate target");
		if (!env[target.tokenEnv])
			throw new Error(`Missing token environment: ${target.tokenEnv}`);
		seen.add(target.threadId);
	}
	for (const { threadId, tokenEnv } of targets) {
		const headers = {
			Authorization: `Bot ${env[tokenEnv]}`,
			"Content-Type": "application/json",
		};
		const url = `https://discord.com/api/v10/channels/${threadId}`;
		const response = await fetchImpl(url, { headers });
		if (!response.ok)
			throw new Error(
				`Thread read failed: ${threadId} HTTP ${response.status}`,
			);
		const thread = await response.json();
		if (typeof thread.name !== "string" || ![10, 11, 12].includes(thread.type))
			throw new Error(`Not a Discord thread: ${threadId}`);
		const next = stripNeedsAnswer(thread.name);
		if (next === thread.name) continue;
		if (!next) throw new Error(`Refusing empty title: ${threadId}`);
		if (apply) {
			const patched = await fetchImpl(url, {
				method: "PATCH",
				headers,
				body: JSON.stringify({ name: next }),
			});
			if (!patched.ok)
				throw new Error(
					`Thread patch failed: ${threadId} HTTP ${patched.status}`,
				);
		}
		report(
			JSON.stringify({
				threadId,
				before: thread.name,
				after: next,
				applied: apply,
			}),
		);
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const args = process.argv.slice(2);
		if (
			args.length < 2 ||
			args[0] !== "--input" ||
			(args.length > 2 && (args.length !== 3 || args[2] !== "--apply"))
		)
			throw new Error(
				"Usage: node scripts/fly-2597-strip-needs-answer.mjs --input inventory.json [--apply]",
			);
		await reconcileTargets(JSON.parse(await readFile(args[1], "utf8")), {
			apply: args.includes("--apply"),
		});
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
