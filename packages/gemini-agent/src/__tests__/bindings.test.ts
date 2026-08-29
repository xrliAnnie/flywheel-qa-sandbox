import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import {
	defaultBindingsPath,
	loadBindings,
	parseBindings,
} from "../discord/bindings.js";

function doc(bindings: unknown[]): string {
	return JSON.stringify({ bindings });
}

const VALID = {
	channelId: "123456",
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
};

describe("parseBindings (fail-closed startup validation)", () => {
	it("parses a valid binding with optional fields", () => {
		const out = parseBindings(
			doc([
				{
					...VALID,
					identityPath: "/abs/identity.md",
					contextNote: "eng channel",
				},
			]),
			"cfg",
		);
		expect(out).toEqual([
			{
				channelId: "123456",
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
				identityPath: "/abs/identity.md",
				contextNote: "eng channel",
			},
		]);
	});

	it("rejects invalid JSON", () => {
		expect(() => parseBindings("{nope", "cfg")).toThrow(ConfigError);
	});

	it("rejects a missing/empty bindings array", () => {
		expect(() => parseBindings("{}", "cfg")).toThrow(/non-empty array/);
		expect(() => parseBindings(doc([]), "cfg")).toThrow(/non-empty array/);
	});

	it("rejects a missing channelId", () => {
		expect(() =>
			parseBindings(doc([{ ...VALID, channelId: undefined }]), "cfg"),
		).toThrow(/channelId is required/);
	});

	it("rejects a MISSING leadId (Codex R4 parser case)", () => {
		expect(() =>
			parseBindings(doc([{ ...VALID, leadId: undefined }]), "cfg"),
		).toThrow(/leadId is required/);
	});

	it("rejects a BLANK leadId (Codex R4 parser case)", () => {
		expect(() =>
			parseBindings(doc([{ ...VALID, leadId: "   " }]), "cfg"),
		).toThrow(/leadId is required/);
	});

	it("rejects a missing projectName", () => {
		expect(() =>
			parseBindings(doc([{ ...VALID, projectName: "" }]), "cfg"),
		).toThrow(/projectName is required/);
	});

	it("rejects duplicate channelIds", () => {
		expect(() => parseBindings(doc([VALID, { ...VALID }]), "cfg")).toThrow(
			/duplicate channelId "123456"/,
		);
	});

	// FLY-1060 QA F2: optional department label — auto-applied to created
	// issues so dispatch passes the Bridge dept-scope admission gate.
	it("parses an optional deptLabel (trimmed)", () => {
		const out = parseBindings(
			doc([{ ...VALID, deptLabel: " Firmware " }]),
			"cfg",
		);
		expect(out[0]?.deptLabel).toBe("Firmware");
	});

	it("omits deptLabel when not configured (byte-compat)", () => {
		const out = parseBindings(doc([VALID]), "cfg");
		expect("deptLabel" in (out[0] ?? {})).toBe(false);
	});

	it("rejects a blank deptLabel when present", () => {
		expect(() =>
			parseBindings(doc([{ ...VALID, deptLabel: "  " }]), "cfg"),
		).toThrow(/deptLabel/);
	});

	it("rejects a blank identityPath when present", () => {
		expect(() =>
			parseBindings(doc([{ ...VALID, identityPath: " " }]), "cfg"),
		).toThrow(/identityPath/);
	});
});

describe("loadBindings", () => {
	it("fails closed when the file is unreadable", () => {
		expect(() =>
			loadBindings("/nope/gemini-agent.json", {
				readFileSync: () => {
					throw new Error("ENOENT");
				},
				existsSync: () => false,
			} as never),
		).toThrow(/bindings config not readable/);
	});

	it("fails at startup when an identityPath does not exist", () => {
		expect(() =>
			loadBindings("/cfg.json", {
				readFileSync: () =>
					doc([{ ...VALID, identityPath: "/missing/identity.md" }]),
				existsSync: () => false,
			} as never),
		).toThrow(/identityPath does not exist/);
	});

	it("returns bindings when identityPath exists", () => {
		const out = loadBindings("/cfg.json", {
			readFileSync: () => doc([{ ...VALID, identityPath: "/ok/identity.md" }]),
			existsSync: () => true,
		} as never);
		expect(out[0]?.identityPath).toBe("/ok/identity.md");
	});

	it("defaultBindingsPath honors the env override", () => {
		expect(
			defaultBindingsPath({ FLYWHEEL_GEMINI_AGENT_CONFIG: "/custom/x.json" }),
		).toBe("/custom/x.json");
		expect(defaultBindingsPath({})).toContain(".flywheel/gemini-agent.json");
	});
});
