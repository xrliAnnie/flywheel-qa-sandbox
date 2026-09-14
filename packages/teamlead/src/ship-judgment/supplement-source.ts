import { posix } from "node:path";
import { type DefaultTreeAdapterMap, parse, serialize } from "parse5";
import type { SupplementalSource } from "./collect.js";
import { canonicalDigest, prFileInventorySchema } from "./contract.js";
import type { FrozenGitReader } from "./git-input.js";
import {
	type ReviewedPlanReference,
	readReviewedPlanSource,
} from "./plan-source.js";
import { frozenSourceText } from "./source-text.js";

function documentLinks(
	body: string,
	format: "text" | "html",
): { label: string; location: string }[] {
	const links: { label: string; location: string }[] = [];
	if (format === "html") {
		const nodes: DefaultTreeAdapterMap["node"][] = [parse(body)];
		while (nodes.length) {
			const node = nodes.pop()!;
			if (
				"tagName" in node &&
				["script", "style", "template", "noscript"].includes(node.tagName)
			)
				continue;
			if ("tagName" in node && node.tagName === "a") {
				const href = node.attrs.find((attr) => attr.name === "href")?.value;
				if (href)
					links.push({
						label: frozenSourceText(serialize(node), "html").text,
						location: href,
					});
			}
			if ("childNodes" in node) nodes.push(...node.childNodes);
		}
	} else {
		for (const match of body.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g))
			links.push({ label: match[1]!, location: match[2]! });
		const definitions = new Map(
			[...body.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(\S+)\s*$/gm)].map(
				(match) => [match[1]!.toLowerCase(), match[2]!],
			),
		);
		for (const match of body.matchAll(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g))
			links.push({
				label: match[1]!,
				location: definitions.get((match[2] || match[1])!.toLowerCase()) ?? "",
			});
	}
	return links;
}

/** Follow local product-document links in the pinned plan, never fetch a model-provided location. */
export async function readReviewedSupplements(
	reference: ReviewedPlanReference | undefined,
	head: string,
	reader: Pick<FrozenGitReader, "readText" | "listTextFiles">,
	signal: AbortSignal,
): Promise<SupplementalSource[]> {
	signal.throwIfAborted();
	const plan = await readReviewedPlanSource(reference, head, reader);
	if (!reference || !plan) throw new Error("supplement_plan_missing");
	const directory = posix.dirname(reference.path);
	const paths = new Set<string>();
	for (const { label, location } of documentLinks(plan.body, plan.format)) {
		const relevant =
			/prd|产品|规格|founder.?design/i.test(label) ||
			location.includes("product/doc/");
		if (!relevant) continue;
		const raw = location.split("#")[0]!;
		if (!raw || /[:?%\\\s]/.test(raw) || raw.startsWith("/"))
			throw new Error("supplement_reference_unsupported");
		const path = posix.normalize(posix.join(directory, raw));
		if (
			!prFileInventorySchema.shape.files.element.shape.path.safeParse(path)
				.success ||
			!/\.(?:md|html)$/.test(path)
		)
			throw new Error("supplement_reference_unsupported");
		paths.add(path);
	}
	signal.throwIfAborted();
	const companions = await reader.listTextFiles(
		head,
		directory === "." ? "" : directory,
	);
	for (const path of companions)
		if (posix.basename(path) === "founder-design.html") paths.add(path);
	if (paths.size > 100) throw new Error("source_budget_exceeded");
	const sources: SupplementalSource[] = [];
	for (const path of [...paths].sort()) {
		signal.throwIfAborted();
		try {
			const blob = await reader.readText(head, path);
			sources.push({
				sourceId: `prd:${canonicalDigest(path)}`,
				kind: "prd",
				body: blob.text,
				format: path.endsWith(".html") ? "html" : "text",
				revision: JSON.stringify({
					review: reference.requestId,
					path,
					head,
					blob: blob.blobSha,
				}),
			});
		} catch {
			throw new Error("supplement_source_missing");
		}
	}
	signal.throwIfAborted();
	return sources;
}
