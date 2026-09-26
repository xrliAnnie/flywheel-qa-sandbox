import { describe, expect, it } from "vitest";
import {
	DEFAULT_LEAD_BACKEND,
	isPaneBasedLeadBackend,
	normalizeLeadBackend,
	partitionLeadsForPaneWatchdog,
} from "../lead-backend.js";

describe("normalizeLeadBackend", () => {
	it("recognizes codex-app-server; everything else → claude default", () => {
		expect(normalizeLeadBackend("codex-app-server")).toBe("codex-app-server");
		expect(normalizeLeadBackend("claude-code")).toBe("claude-code");
		expect(normalizeLeadBackend(undefined)).toBe(DEFAULT_LEAD_BACKEND);
		expect(normalizeLeadBackend(null)).toBe("claude-code");
		expect(normalizeLeadBackend("garbage")).toBe("claude-code");
		expect(normalizeLeadBackend("")).toBe("claude-code");
	});
});

describe("isPaneBasedLeadBackend", () => {
	it("true only for the Claude pane backend (default for unset)", () => {
		expect(isPaneBasedLeadBackend("claude-code")).toBe(true);
		expect(isPaneBasedLeadBackend(undefined)).toBe(true); // byte-compat default
		expect(isPaneBasedLeadBackend(null)).toBe(true);
		expect(isPaneBasedLeadBackend("unknown")).toBe(true); // unknown → claude path
		expect(isPaneBasedLeadBackend("codex-app-server")).toBe(false);
	});
});

describe("partitionLeadsForPaneWatchdog", () => {
	type P = { name: string; backend?: string };
	const resolve = (p: P) => p.backend;

	it("byte-compat: all-Claude/default → paneWatched is identical order, none excluded", () => {
		const projects: P[] = [
			{ name: "a", backend: "claude-code" },
			{ name: "b" }, // unset → default claude
			{ name: "c", backend: "claude-code" },
		];
		const { paneWatched, excluded } = partitionLeadsForPaneWatchdog(
			projects,
			resolve,
		);
		expect(paneWatched).toEqual(projects); // same elements, same order
		expect(excluded).toEqual([]);
	});

	it("excludes codex-app-server leads; keeps Claude ones in order", () => {
		const projects: P[] = [
			{ name: "claude1", backend: "claude-code" },
			{ name: "codexA", backend: "codex-app-server" },
			{ name: "claude2" }, // unset → claude
			{ name: "codexB", backend: "codex-app-server" },
		];
		const { paneWatched, excluded } = partitionLeadsForPaneWatchdog(
			projects,
			resolve,
		);
		expect(paneWatched.map((p) => p.name)).toEqual(["claude1", "claude2"]);
		expect(excluded.map((p) => p.name)).toEqual(["codexA", "codexB"]);
	});

	it("all-Codex → none pane-watched (watchdog gets an empty list, no false alarms)", () => {
		const projects: P[] = [
			{ name: "x", backend: "codex-app-server" },
			{ name: "y", backend: "codex-app-server" },
		];
		const { paneWatched, excluded } = partitionLeadsForPaneWatchdog(
			projects,
			resolve,
		);
		expect(paneWatched).toEqual([]);
		expect(excluded.length).toBe(2);
	});

	it("empty input → empty partitions", () => {
		const { paneWatched, excluded } = partitionLeadsForPaneWatchdog(
			[] as P[],
			resolve,
		);
		expect(paneWatched).toEqual([]);
		expect(excluded).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FLY-247 WI-1: effectiveLeadBackend — shared desired-backend precedence
// (explicit leads[].backend > legacy roles/env > claude default). One function
// consumed by Dashboard, watchdog partition, and (via conformance fixtures)
// the fleet CLI — so all consumers give the same answer.
// ─────────────────────────────────────────────────────────────────────────────
import { effectiveLeadBackend } from "../lead-backend.js";

describe("FLY-247 effectiveLeadBackend", () => {
	it("explicit backend wins over legacy", () => {
		expect(effectiveLeadBackend("codex-app-server", "claude-code")).toEqual({
			backend: "codex-app-server",
			source: "explicit",
		});
	});

	it("legacy used when explicit absent", () => {
		expect(effectiveLeadBackend(undefined, "codex-app-server")).toEqual({
			backend: "codex-app-server",
			source: "legacy",
		});
	});

	it("legacy unknown string normalizes to claude-code but keeps legacy source", () => {
		expect(effectiveLeadBackend(undefined, "weird-backend")).toEqual({
			backend: "claude-code",
			source: "legacy",
		});
	});

	it("default claude-code when both absent", () => {
		expect(effectiveLeadBackend(undefined, undefined)).toEqual({
			backend: "claude-code",
			source: "default",
		});
		expect(effectiveLeadBackend(undefined, null)).toEqual({
			backend: "claude-code",
			source: "default",
		});
		expect(effectiveLeadBackend(undefined, "")).toEqual({
			backend: "claude-code",
			source: "default",
		});
	});
});
