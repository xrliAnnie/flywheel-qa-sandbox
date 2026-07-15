import os from "node:os";
import type { Classification } from "./types.js";

/**
 * Known product projects. A CC working directory under ~/Dev/<project>[-<ISSUE>]
 * (or a lead-workspace) is attributed to one of these; anything else is bucketed
 * explicitly (never silently dropped) so "who burned tokens" hides no usage.
 */
export const PROJECTS = [
	"flywheel",
	"geoforge3d",
	"joycon",
	"sub",
	"tidal-echo",
	"growth",
] as const;

const PROJ_ALT = PROJECTS.join("|");
// Matches the FIRST path segment after /Dev/ : <project> | <project>-<ISSUE>[-role]
const PROJ_RE = new RegExp(
	`^(${PROJ_ALT})(?:-([A-Za-z]+-\\d+)(?:-([a-z]+))?)?$`,
	"i",
);
// Known-project prefix with a non-standard suffix (e.g. sub-<uuid> runner worktree)
const PROJ_PREFIX_RE = new RegExp(`^(${PROJ_ALT})-`, "i");

/**
 * Classify a CC log line's `cwd`.
 *
 * Only the FIRST path component after `/Dev/` is parsed, which deliberately
 * ignores nested `worktrees/<slug>` subdirectories (a runner may create its own
 * `git worktree add worktrees/...` inside its issue worktree).
 *
 * @param cwd      the `cwd` field from a CC jsonl line
 * @param homeDir  override for the user's home directory (test seam)
 */
export function classifyCwd(
	cwd: string | null | undefined,
	homeDir: string = os.homedir(),
): Classification {
	const s = cwd ?? "";

	// Lead sessions live under .../lead-workspace/<name>
	if (s.includes("/lead-workspace/")) {
		const after = s.split("/lead-workspace/")[1] ?? "";
		const who = after.replace(/\/.*$/, "").replace(/\/+$/, "") || s;
		return { kind: "lead", project: null, issue: null, role: null, who };
	}

	// QA sandboxes / test slots / scratchpads — excluded from project attribution
	if (
		s.includes("/scratchpad") ||
		s.includes("claude-501") ||
		s.includes("flywheel-test-slot")
	) {
		return {
			kind: "sandbox",
			project: null,
			issue: null,
			role: null,
			who: "sandbox",
		};
	}

	const segMatch = s.match(/\/Dev\/([^/]+)/);
	if (!segMatch || !segMatch[1]) {
		return {
			kind: "other",
			project: null,
			issue: null,
			role: null,
			who: nonDevBucket(s, homeDir),
		};
	}
	const seg = segMatch[1];

	const m = seg.match(PROJ_RE);
	if (m?.[1]) {
		const project = m[1].toLowerCase();
		const issue = m[2] ? m[2].toUpperCase() : null;
		if (issue) {
			const role = m[3] ?? "runner";
			return { kind: "runner", project, issue, role, who: issue };
		}
		return { kind: "main", project, issue: null, role: "main", who: "(main)" };
	}

	const pm = seg.match(PROJ_PREFIX_RE);
	if (pm?.[1]) {
		// e.g. sub-<uuid> runner worktree → attribute to the project, unknown issue
		return {
			kind: "runner",
			project: pm[1].toLowerCase(),
			issue: null,
			role: "runner",
			who: seg,
		};
	}

	// A genuine separate project dir (personal-assistant, joycon-typeless, vedic-astro-skills ...)
	return {
		kind: "main",
		project: seg.toLowerCase(),
		issue: null,
		role: "main",
		who: "(main)",
	};
}

/** Bucket a non-Dev, non-lead, non-sandbox absolute cwd. Never silently dropped. */
function nonDevBucket(cwd: string, homeDir: string): string {
	if (!cwd) return "unknown";
	if (cwd === homeDir || cwd === `${homeDir}/`) return "home-root";
	if (
		cwd.includes("/tmp/") ||
		cwd.startsWith("/tmp") ||
		cwd.startsWith("/private/tmp")
	)
		return "tmp";
	if (homeDir && cwd.startsWith(`${homeDir}/`)) return "home-other";
	return "unknown";
}
