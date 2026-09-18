import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parsePersonaProjection,
	resolvePersonaStateRoot,
} from "../persona-projection.js";

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);

function pin(overrides: Record<string, unknown> = {}) {
	return {
		commit: COMMIT,
		personaBlobDigest: SHA,
		approval: {
			channelId: "12345678901234567",
			messageId: "22345678901234567",
			contentSha256: "c".repeat(64),
		},
		...overrides,
	};
}

function contract(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		enabled: true,
		leadId: "raya",
		repo: "xrliAnnie/raya",
		path: ".lead/raya/identity.md",
		pin: pin(),
		lastKnownGood: pin({ commit: "d".repeat(40) }),
		...overrides,
	};
}

describe("persona projection contract", () => {
	it("keeps an absent contract dormant", () => {
		expect(
			parsePersonaProjection(undefined, {
				projectName: "raya",
				projectRepo: "xrliAnnie/raya",
			}),
		).toEqual({ kind: "absent" });
	});

	it("accepts only the exact Raya contract and returns a stable digest", () => {
		const parsed = parsePersonaProjection(contract(), {
			projectName: "raya",
			projectRepo: "xrliAnnie/raya",
		});
		expect(parsed).toMatchObject({
			kind: "valid",
			value: {
				leadId: "raya",
				repo: "xrliAnnie/raya",
				path: ".lead/raya/identity.md",
			},
		});
		if (parsed.kind !== "valid") throw new Error("expected valid contract");
		expect(parsed.contractDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(
			parsePersonaProjection(JSON.parse(JSON.stringify(contract())), {
				projectName: "raya",
				projectRepo: "xrliAnnie/raya",
			}),
		).toEqual(parsed);
	});

	it.each([
		["enabled false", contract({ enabled: false })],
		["short commit", contract({ pin: pin({ commit: "main" }) })],
		["uppercase commit", contract({ pin: pin({ commit: "B".repeat(40) }) })],
		["path traversal", contract({ path: "../identity.md" })],
		["unknown field", contract({ surprise: true })],
		["unknown pin field", contract({ pin: pin({ ref: "main" }) })],
		[
			"unknown approval field",
			contract({
				pin: pin({ approval: { ...pin().approval, approved: true } }),
			}),
		],
		["missing projectRepo", contract()],
		["wrong lead", contract({ leadId: "other" })],
		["wrong repo", contract({ repo: "xrliAnnie/other" })],
		["null", null],
	])("marks %s invalid without treating it as absent", (name, value) => {
		const parsed = parsePersonaProjection(value, {
			projectName: "raya",
			...(name === "missing projectRepo"
				? {}
				: { projectRepo: "xrliAnnie/raya" }),
		});
		expect(parsed.kind).toBe("invalid");
		if (parsed.kind !== "invalid") throw new Error("expected invalid contract");
		expect(parsed.reason).toBeTruthy();
	});

	it("rejects opt-in on any non-Raya project", () => {
		expect(
			parsePersonaProjection(contract(), {
				projectName: "flywheel",
				projectRepo: "xrliAnnie/flywheel",
			}),
		).toMatchObject({ kind: "invalid" });
	});
});

describe("resolvePersonaStateRoot", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("requires the explicit canonical host state root and appends state once", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2696-home-"));
		dirs.push(homeDir);
		const root = join(homeDir, ".flywheel");
		mkdirSync(root);
		expect(resolvePersonaStateRoot({ FLYWHEEL_STATE_DIR: root }, homeDir)).toBe(
			join(realpathSync.native(root), "state", "lead-persona", "raya", "raya"),
		);
	});

	it("rejects missing or non-canonical state roots", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2696-home-"));
		dirs.push(homeDir);
		mkdirSync(join(homeDir, ".flywheel"));
		expect(() => resolvePersonaStateRoot({}, homeDir)).toThrow(
			/FLYWHEEL_STATE_DIR/,
		);
		expect(() =>
			resolvePersonaStateRoot(
				{ FLYWHEEL_STATE_DIR: join(homeDir, ".flywheel", "state") },
				homeDir,
			),
		).toThrow(/canonical host root/);
	});
});
