import { expect, it } from "vitest";
import { renderFixtureRunnerPolicy } from "../fixture-runner-policy.js";

const input = {
	serviceUid: 450,
	serviceGid: 450,
	modelUid: 501,
	modelGid: 20,
	nonce: "a".repeat(64),
	node: {
		path: "/Library/Application Support/Flywheel/Xhs/node",
		sha256: "b".repeat(64),
	},
	boundaryProbe: {
		path: "/Library/Application Support/Flywheel/Xhs/probe.js",
		sha256: "c".repeat(64),
	},
};
it("renders the fixed ordered native grammar using the dedicated probe pin", () => {
	expect(renderFixtureRunnerPolicy(input)).toBe(
		[
			"version=1",
			"service_uid=450",
			"service_gid=450",
			"model_uid=501",
			"model_gid=20",
			`node=${input.node.path}`,
			`node_sha256=${input.node.sha256}`,
			`entry=${input.boundaryProbe.path}`,
			`entry_sha256=${input.boundaryProbe.sha256}`,
			`fixture=/private/var/db/flywheel-xhs-qa/${input.nonce}`,
			"",
		].join("\n"),
	);
});
it.each([
	"/tmp/probe.js",
	"/Library/Application Support/Flywheel/Xhs/../probe.js",
	"/Library/Application Support/Flywheel/Xhs/a//b",
	"/Library/Application Support/Flywheel/Xhs/a/",
	"/Library/Application Support/Flywheel/Xhs/a\nentry=/tmp/b",
	"/Library/Application Support/Flywheel/Xhs/a\0b",
	"/Library/Application Support/Flywheel/Xhs/a\rb",
	`/Library/Application Support/Flywheel/Xhs/${"a".repeat(1024)}`,
])("rejects noncanonical or injectable paths %j", (path) => {
	expect(() =>
		renderFixtureRunnerPolicy({ ...input, node: { ...input.node, path } }),
	).toThrow("fixture_policy_unavailable");
});
it.each([
	{ serviceUid: 0 },
	{ modelGid: 2147483648 },
	{ serviceGid: 80 },
	{ modelUid: 450 },
	{ modelGid: 450 },
	{ serviceUid: 1.5 },
	{ nonce: "A".repeat(64) },
	{ enabled: true },
	{ boundaryProbe: { ...input.boundaryProbe, sha256: "x".repeat(64) } },
])("rejects invalid identity, digest or extra authority %j", (change) => {
	expect(() => renderFixtureRunnerPolicy({ ...input, ...change })).toThrow(
		"fixture_policy_unavailable",
	);
});
