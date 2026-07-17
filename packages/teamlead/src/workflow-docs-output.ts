export interface WorkflowDocsLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export const DEFAULT_WORKFLOW_DOCS_LIMITS: Readonly<WorkflowDocsLimits> = {
	maxFiles: 64,
	maxFileBytes: 128 * 1024,
	maxTotalBytes: 256 * 1024,
};

export type WorkflowDocsOperation =
	| { op: "write"; path: string; content: string }
	| { op: "delete"; path: string };

export interface WorkflowDocsOutput {
	kind: "docs_v1";
	operations: WorkflowDocsOperation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === [...expected].sort()[index])
	);
}

function isUnicodeScalarString(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function validatePath(path: string): void {
	if (
		path.length === 0 ||
		path !== path.normalize("NFC") ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0")
	) {
		throw new Error("docs_v1 path must be a canonical relative UTF-8 path");
	}
	const segments = path.split("/");
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		) ||
		segments.some((segment) => segment === ".git")
	) {
		throw new Error("docs_v1 path contains a forbidden segment");
	}
	const allowlisted =
		/^(?:doc|docs)\/.+/.test(path) || /^[a-z0-9][a-z0-9-]*\/doc\/.+/.test(path);
	if (!allowlisted) {
		throw new Error("docs_v1 path is outside the documentation allowlist");
	}
}

function assertLimits(limits: WorkflowDocsLimits): void {
	if (
		!Number.isSafeInteger(limits.maxFiles) ||
		!Number.isSafeInteger(limits.maxFileBytes) ||
		!Number.isSafeInteger(limits.maxTotalBytes) ||
		limits.maxFiles <= 0 ||
		limits.maxFileBytes <= 0 ||
		limits.maxTotalBytes <= 0 ||
		limits.maxFileBytes > limits.maxTotalBytes ||
		limits.maxTotalBytes > 262_144
	) {
		throw new Error("invalid docs_v1 limits");
	}
}

export function parseWorkflowDocsOutput(
	value: unknown,
	limits: WorkflowDocsLimits = DEFAULT_WORKFLOW_DOCS_LIMITS,
): WorkflowDocsOutput {
	assertLimits(limits);
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["kind", "operations"]) ||
		value.kind !== "docs_v1" ||
		!Array.isArray(value.operations) ||
		value.operations.length === 0
	) {
		throw new Error("invalid docs_v1 payload");
	}
	if (value.operations.length > limits.maxFiles) {
		throw new Error("docs_v1 file count limit exceeded");
	}

	const operations: WorkflowDocsOperation[] = [];
	const paths = new Set<string>();
	let totalBytes = 0;
	for (const raw of value.operations) {
		if (!isRecord(raw) || (raw.op !== "write" && raw.op !== "delete")) {
			throw new Error("invalid docs_v1 operation");
		}
		if (typeof raw.path !== "string" || !isUnicodeScalarString(raw.path)) {
			throw new Error("docs_v1 path must be valid UTF-8");
		}
		validatePath(raw.path);
		const foldedPath = raw.path.toLocaleLowerCase("en-US");
		if (paths.has(foldedPath)) {
			throw new Error(`duplicate docs_v1 path: ${raw.path}`);
		}
		paths.add(foldedPath);

		if (raw.op === "delete") {
			if (!hasExactKeys(raw, ["op", "path"])) {
				throw new Error("invalid docs_v1 delete operation");
			}
			operations.push({ op: "delete", path: raw.path });
			continue;
		}

		if (
			!hasExactKeys(raw, ["op", "path", "content"]) ||
			typeof raw.content !== "string"
		) {
			throw new Error("invalid docs_v1 write operation");
		}
		if (!isUnicodeScalarString(raw.content)) {
			throw new Error("docs_v1 content must be valid UTF-8");
		}
		const bytes = Buffer.byteLength(raw.content, "utf8");
		if (bytes > limits.maxFileBytes) {
			throw new Error("docs_v1 per-file byte limit exceeded");
		}
		totalBytes += bytes;
		if (totalBytes > limits.maxTotalBytes) {
			throw new Error("docs_v1 total byte limit exceeded");
		}
		operations.push({ op: "write", path: raw.path, content: raw.content });
	}

	operations.sort((left, right) =>
		left.path.localeCompare(right.path, "en-US"),
	);
	return { kind: "docs_v1", operations };
}
