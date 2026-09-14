import { expect, it, vi } from "vitest";
import { readReviewedSupplements } from "../supplement-source.js";

it("resolves product references and companion design only from the reviewed tree with stable provenance", async () => {
	const head = "a".repeat(40);
	const path = "engineering/doc/FLY-2399-x/plan.md";
	const bodies: Record<string, string> = {
		[path]:
			"[产品规格](../../../product/doc/FLY-2399-x/proposal.md)\n[重复](../../../product/doc/FLY-2399-x/proposal.md#R1)",
		"product/doc/FLY-2399-x/proposal.md": "R1: implement",
		"engineering/doc/FLY-2399-x/founder-design.html": "<p>Accepted design</p>",
	};
	const reader = {
		readText: vi.fn(async (_sha: string, path: string) => {
			if (!(path in bodies)) throw new Error("missing");
			return { text: bodies[path]!, blobSha: "b".repeat(40) };
		}),
		listTextFiles: vi.fn(async () => [
			"engineering/doc/FLY-2399-x/founder-design.html",
		]),
	};
	const result = await readReviewedSupplements(
		{ requestId: "review", path },
		head,
		reader,
		new AbortController().signal,
	);
	expect(result).toHaveLength(2);
	expect(result.map((source) => source.body)).toEqual([
		"<p>Accepted design</p>",
		"R1: implement",
	]);
	expect(result[0]?.revision).toContain("review");
	expect(result[0]?.revision).toContain("b".repeat(40));
	expect(new Set(result.map((source) => source.sourceId)).size).toBe(2);
	for (const call of reader.readText.mock.calls) expect(call[0]).toBe(head);
	bodies[path] =
		"[产品规格][spec]\n\n[spec]: ../../../product/doc/FLY-2399-x/proposal.md";
	expect(
		await readReviewedSupplements(
			{ requestId: "review", path },
			head,
			reader,
			new AbortController().signal,
		),
	).toHaveLength(2);
	const htmlPath = "engineering/doc/FLY-2399-x/plan.html";
	bodies[htmlPath] =
		'<a href="../../../product/doc/FLY-2399-x/proposal.md">产品规格</a>';
	expect(
		await readReviewedSupplements(
			{ requestId: "review", path: htmlPath },
			head,
			reader,
			new AbortController().signal,
		),
	).toHaveLength(2);
	bodies[path] = "[产品规格](../../../product/doc/missing.md)";
	await expect(
		readReviewedSupplements(
			{ requestId: "review", path },
			head,
			reader,
			new AbortController().signal,
		),
	).rejects.toThrow("supplement_source_missing");
	bodies[path] = "[PRD](https://untrusted.test/spec.md)";
	await expect(
		readReviewedSupplements(
			{ requestId: "review", path },
			head,
			reader,
			new AbortController().signal,
		),
	).rejects.toThrow("supplement_reference_unsupported");
	bodies[path] = "[PRD](../../../../outside.md)";
	await expect(
		readReviewedSupplements(
			{ requestId: "review", path },
			head,
			reader,
			new AbortController().signal,
		),
	).rejects.toThrow("supplement_reference_unsupported");
});
