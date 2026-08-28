import { describe, expect, it } from "vitest";
import {
	deriveLeadAddress,
	deriveLeadSocketPath,
	leadAddressFromManifest,
} from "../lead-address.js";
import { parseAndValidateProjects } from "../ProjectConfig.js";

function projectWith(overrides: Record<string, unknown> = {}) {
	return [
		{
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leads: [
				{
					agentId: "eng-lead",
					summaryRole: "producer",
					chatChannel: "1",
					match: { labels: ["Engineering"] },
					...overrides,
				},
			],
		},
	];
}

describe("deriveLeadSocketPath", () => {
	it("is deterministic, bounded, and collision-resistant across exact keys", () => {
		const stateDir = "/Users/test/.flywheel";
		const first = deriveLeadSocketPath("flywheel-eng-lead", stateDir);
		expect(first).toBe(deriveLeadSocketPath("flywheel-eng-lead", stateDir));
		expect(first).toMatch(
			/^\/Users\/test\/\.flywheel\/sock\/fw-[a-z0-9-]+-[0-9a-f]{16}\.sock$/,
		);
		expect(Buffer.byteLength(first)).toBeLessThan(90);
		expect(deriveLeadSocketPath("geoforge-eng-lead", stateDir)).not.toBe(first);
	});

	it("fails closed when the complete socket path exceeds the tmux budget", () => {
		expect(() =>
			deriveLeadSocketPath("flywheel-eng-lead", `/${"x".repeat(100)}`),
		).toThrow(/90 bytes/);
	});

	it("keeps hyphenated project and Lead identities unambiguous", () => {
		const address = deriveLeadAddress("geo-forge/product-lead", "/tmp/state");
		const ambiguousUnderConcatenation = deriveLeadAddress(
			"geo/forge-product-lead",
			"/tmp/state",
		);
		expect(address.socketPath).not.toBe(ambiguousUnderConcatenation.socketPath);
		expect(
			leadAddressFromManifest("geo-forge", "product-lead", "/tmp/state", {
				projectName: "geo-forge",
				leadId: "product-lead",
				socketPath: address.socketPath,
			}),
		).toEqual(address);
		expect(
			leadAddressFromManifest("geo", "forge-product-lead", "/tmp/state", {
				projectName: "geo-forge",
				leadId: "product-lead",
				socketPath: address.socketPath,
			}),
		).toBeNull();
	});
});

describe("Lead carrier schema", () => {
	it("accepts the v2 carrier", () => {
		const projects = parseAndValidateProjects(projectWith({ carrier: "v2" }));
		expect(projects[0]?.leads[0]?.carrier).toBe("v2");
	});

	it("preserves an absent carrier as canonical v2", () => {
		const projects = parseAndValidateProjects(projectWith());
		expect(projects[0]?.leads[0]).not.toHaveProperty("carrier");
	});

	it.each(["v1", "bespoke"])(
		"rejects retired or unknown carrier %s",
		(carrier) => {
			expect(() => parseAndValidateProjects(projectWith({ carrier }))).toThrow(
				/carrier.*v2/i,
			);
		},
	);

	it("rejects a carrier on a codex Lead", () => {
		expect(() =>
			parseAndValidateProjects(
				projectWith({
					backend: "codex-app-server",
					codexProfile: "full-access",
					canSpawnRunners: false,
					carrier: "v2",
				}),
			),
		).toThrow(/carrier.*claude-code/i);
	});
});
