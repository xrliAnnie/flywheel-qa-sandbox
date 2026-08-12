/**
 * Legacy repository identity normalizer.
 *
 * This intentionally preserves its historically permissive behavior. It is
 * suitable for reverse-compatible identity derivation, not endpoint trust.
 */
export function normalizeGitHubRepoSlug(remote: string): string {
	const withoutQuery = remote.split(/[?#]/, 1)[0] ?? remote;
	const pathPart = withoutQuery.includes("://")
		? new URL(withoutQuery).pathname
		: withoutQuery.replace(/^[^@/]+@[^:]+:/, "");
	const pieces = pathPart
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	if (pieces.length < 2) {
		throw new Error("repository origin cannot be normalized to owner/repo");
	}
	const owner = pieces.at(-2)!;
	const repo = pieces.at(-1)!;
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
		throw new Error("repository origin contains an invalid owner/repo");
	}
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

const INVALID_PUSH_ENDPOINT =
	"push endpoint must be an explicit github.com owner/repo remote";

function invalidPushEndpoint(): never {
	throw new Error(INVALID_PUSH_ENDPOINT);
}

function normalizePushSlug(owner: string, repository: string): string {
	const repo = repository.replace(/\.git$/i, "");
	const validSegment = (segment: string): boolean =>
		segment !== "." && segment !== ".." && /^[A-Za-z0-9_.-]+$/.test(segment);
	if (!validSegment(owner) || !validSegment(repo)) invalidPushEndpoint();
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Parse an attested GitHub push endpoint into its case-insensitive owner/repo
 * slug. Unlike normalizeGitHubRepoSlug, this is intentionally strict: it only
 * accepts explicit github.com HTTPS, SSH, or canonical git@ SCP endpoints.
 */
export function parseGitHubPushEndpoint(endpoint: string): string {
	const hasControlOrWhitespace = [...endpoint].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 32 || code === 127;
	});
	if (hasControlOrWhitespace) invalidPushEndpoint();

	const url = /^(https|ssh):\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(endpoint);
	if (url?.[0] === endpoint) {
		const protocol = url[1]!.toLowerCase();
		const authority = url[2]!;
		const isGitHubHttps =
			protocol === "https" && authority.toLowerCase() === "github.com";
		const isGitHubSsh =
			protocol === "ssh" &&
			(authority.toLowerCase() === "github.com" ||
				(authority.startsWith("git@") &&
					authority.slice("git@".length).toLowerCase() === "github.com"));
		if (!isGitHubHttps && !isGitHubSsh) invalidPushEndpoint();
		return normalizePushSlug(url[3]!, url[4]!);
	}

	const scp = /^git@([^/:]+):([^/]+)\/([^/]+)$/.exec(endpoint);
	if (scp?.[0] === endpoint && scp[1]!.toLowerCase() === "github.com") {
		return normalizePushSlug(scp[2]!, scp[3]!);
	}
	return invalidPushEndpoint();
}
