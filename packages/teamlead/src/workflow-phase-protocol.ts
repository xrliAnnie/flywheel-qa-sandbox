import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowNodeTypeId } from "flywheel-config";

const protocolFiles = {
	design: "design.md",
	implement: "implement.md",
	qa: "qa.md",
	generic: "generic.md",
	review: "review.md",
} as const;

/** Exact marked policy block shipped beside the workflow phase protocols. */
export function loadLocalTestPolicy(): string {
	const path = fileURLToPath(
		new URL("../phase-protocols/local-test-policy.md", import.meta.url),
	);
	const content = new TextDecoder("utf-8", { fatal: true }).decode(
		readFileSync(path),
	);
	const begin = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->";
	const end = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->";
	if (
		content.split(begin).length !== 2 ||
		content.split(end).length !== 2 ||
		!content.includes("local-test-policy/v1")
	) {
		throw new Error(
			"WORKFLOW_LOCAL_TEST_POLICY_UNAVAILABLE cause=invalid_block",
		);
	}
	return `${content.replace(/\n+$/, "")}\n`;
}

export function workflowPhaseProtocolError(
	nodeId: string,
	nodeType: string,
	cause: string,
): Error {
	return new Error(
		`WORKFLOW_PHASE_PROTOCOL_UNAVAILABLE node=${nodeId} type=${nodeType} cause=${cause}`,
	);
}

/** Package-owned assets only; each materialization takes one fresh copy per type. */
export function loadWorkflowPhaseProtocols(
	types: readonly WorkflowNodeTypeId[],
): ReadonlyMap<WorkflowNodeTypeId, string> {
	const protocols = new Map<WorkflowNodeTypeId, string>();
	for (const type of types) {
		if (type === "gate" || type === "land" || protocols.has(type)) continue;
		if (!Object.hasOwn(protocolFiles, type))
			throw workflowPhaseProtocolError("unresolved", type, "missing");
		const root = fileURLToPath(new URL("../phase-protocols/", import.meta.url));
		let content: string;
		try {
			const canonicalRoot = realpathSync(root);
			const target = realpathSync(
				new URL(
					`../phase-protocols/${protocolFiles[type as keyof typeof protocolFiles]}`,
					import.meta.url,
				),
			);
			const rel = relative(canonicalRoot, target);
			if (
				!rel ||
				rel.startsWith("..") ||
				isAbsolute(rel) ||
				!statSync(target).isFile()
			) {
				throw workflowPhaseProtocolError("unresolved", type, "unsafe_path");
			}
			content = new TextDecoder("utf-8", { fatal: true }).decode(
				readFileSync(target),
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("WORKFLOW_PHASE_PROTOCOL_UNAVAILABLE")
			)
				throw error;
			throw workflowPhaseProtocolError("unresolved", type, "missing");
		}
		if (!content.trim())
			throw workflowPhaseProtocolError("unresolved", type, "empty");
		if (content.includes("FLYWHEEL_PHASE_PROTOCOL:"))
			throw workflowPhaseProtocolError("unresolved", type, "invalid_block");
		protocols.set(type, content.replace(/\n+$/, "") + "\n");
	}
	return protocols;
}

/** Exact managed projections are stripped; stale or malformed projections fail closed. */
export function composeWorkflowPhaseAgent(input: {
	nodeId: string;
	nodeType: WorkflowNodeTypeId;
	protocol: string;
	source: string;
}): { content: string } {
	const { nodeId, nodeType, protocol, source } = input;
	const fail = (cause: string) =>
		workflowPhaseProtocolError(nodeId, nodeType, cause);
	if (!protocol.trim()) throw fail("empty");
	const normalized = protocol.replace(/\n+$/, "") + "\n";
	const block = `<!-- FLYWHEEL_PHASE_PROTOCOL:${nodeType}:BEGIN -->\n${normalized}<!-- FLYWHEEL_PHASE_PROTOCOL:${nodeType}:END -->`;
	let domain = source;
	if (source.includes("FLYWHEEL_PHASE_PROTOCOL:")) {
		if (!source.includes(block)) throw fail("invalid_block");
		domain = source.replace(block, "");
		if (domain.includes("FLYWHEEL_PHASE_PROTOCOL:"))
			throw fail("invalid_block");
	}
	if (!domain.trim())
		throw new Error("workflow agent content must be non-empty");
	const content = normalized.replace(/\n+$/, "") + "\n\n---\n\n" + domain;
	if (content.length > 40_000)
		throw fail(`oversize total=${content.length} limit=40000`);
	return { content };
}
