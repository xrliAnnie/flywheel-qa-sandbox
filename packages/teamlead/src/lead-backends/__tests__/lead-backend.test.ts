import { effectiveLeadBackend as sharedEffectiveLeadBackend } from "flywheel-comm/canonical-lead";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// FLY-247 WI-1: effectiveLeadBackend — shared desired-backend precedence
// (explicit leads[].backend > legacy roles/env > claude default). One function
// consumed by Dashboard and (via conformance fixtures) the fleet CLI.
// ─────────────────────────────────────────────────────────────────────────────
import { effectiveLeadBackend } from "../lead-backend.js";

describe("FLY-247 effectiveLeadBackend", () => {
	it("consumes the shared flywheel-comm implementation instead of a second copy", () => {
		expect(effectiveLeadBackend).toBe(sharedEffectiveLeadBackend);
	});

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
