import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

it("rollback strips only the owned prefix, defaults to read-only, and applies only after explicit opt-in", async () => {
	const script = fileURLToPath(
		new URL(
			"../../../../../scripts/fly-2597-strip-needs-answer.mjs",
			import.meta.url,
		),
	);
	const { stripNeedsAnswer, reconcileTargets } = await import(
		pathToFileURL(script).href
	);
	expect(stripNeedsAnswer("🔔要你答 [GPT] [TEST-1] Decide")).toBe(
		"[GPT] [TEST-1] Decide",
	);
	for (const title of [
		"🔔 ⏳待批 [TEST-1] Ship",
		"🔔 personal title",
		"Needs 🔔要你答",
	])
		expect(stripNeedsAnswer(title)).toBe(title);
	const fetchImpl = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({ type: 11, name: "🔔要你答 [TEST-1] Decide" }),
	}));
	const options = {
		fetchImpl,
		env: { TEST_TOKEN: "fixture" },
		report: vi.fn(),
	};
	const inventory = [
		{ threadId: "123456789012345678", tokenEnv: "TEST_TOKEN" },
	];
	await reconcileTargets(inventory, options);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	await reconcileTargets(inventory, { ...options, apply: true });
	expect(fetchImpl.mock.calls.at(-1)?.[1]).toMatchObject({
		method: "PATCH",
		body: JSON.stringify({ name: "[TEST-1] Decide" }),
	});
});

it.each([
	{ threadId: JSON.parse("123456789012345678"), tokenEnv: "TEST_TOKEN" },
	{ threadId: ["123456789012345678"], tokenEnv: "TEST_TOKEN" },
	{ threadId: "123456789012345678", tokenEnv: ["TEST_TOKEN"] },
])(
	"rejects coerced inventory fields before any network read: %j",
	async (target) => {
		const script = fileURLToPath(
			new URL(
				"../../../../../scripts/fly-2597-strip-needs-answer.mjs",
				import.meta.url,
			),
		);
		const { reconcileTargets } = await import(pathToFileURL(script).href);
		const fetchImpl = vi.fn();
		await expect(
			reconcileTargets([target], { fetchImpl, env: { TEST_TOKEN: "fixture" } }),
		).rejects.toThrow("Invalid or duplicate target");
		expect(fetchImpl).not.toHaveBeenCalled();
	},
);
