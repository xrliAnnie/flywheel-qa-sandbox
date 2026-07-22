const ISSUE_IDENTIFIER = /^[A-Z]+-\d+$/;

/**
 * Return founder design HTML files that belong to one canonical issue doc
 * folder. Invalid boundary input fails closed and never throws.
 */
export function findDesignHtmlPaths(
	paths: unknown,
	issueIdentifier: unknown,
): string[] {
	if (
		typeof issueIdentifier !== "string" ||
		!ISSUE_IDENTIFIER.test(issueIdentifier)
	) {
		return [];
	}
	if (
		!Array.isArray(paths) ||
		!paths.every((path) => typeof path === "string")
	) {
		return [];
	}
	const issueDocFolder = new RegExp(`(^|/)doc/${issueIdentifier}(?:-[^/]+)?/`);
	return paths.filter(
		(path) => /\.html$/i.test(path) && issueDocFolder.test(path),
	);
}

export type DesignHtmlEvidence = {
	version: 1;
	issueIdentifier: string;
	paths: string[];
	headSha: string;
};

export type DesignHtmlEvidenceParseResult =
	| ({ ok: true } & Omit<DesignHtmlEvidence, "version">)
	| { ok: false; reason: string };

/** Strictly parse the completion attestation carried across process boundaries. */
export function parseDesignHtmlEvidence(
	value: unknown,
): DesignHtmlEvidenceParseResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, reason: "attestation must be an object" };
	}
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1) {
		return { ok: false, reason: "unsupported attestation version" };
	}
	if (
		typeof raw.issueIdentifier !== "string" ||
		!ISSUE_IDENTIFIER.test(raw.issueIdentifier)
	) {
		return { ok: false, reason: "invalid issueIdentifier" };
	}
	if (
		!Array.isArray(raw.paths) ||
		raw.paths.length === 0 ||
		!raw.paths.every((path) => typeof path === "string")
	) {
		return { ok: false, reason: "paths must be a non-empty string array" };
	}
	if (typeof raw.headSha !== "string" || !/^[0-9a-f]{40}$/.test(raw.headSha)) {
		return { ok: false, reason: "headSha must be a lowercase 40-hex SHA" };
	}
	return {
		ok: true,
		issueIdentifier: raw.issueIdentifier,
		paths: raw.paths,
		headSha: raw.headSha,
	};
}
