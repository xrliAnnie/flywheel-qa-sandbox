import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyBoundaryAcceptance } from "../boundary-acceptance.js";
import { canonical } from "../canonical.js";

it("accepts the same installation-bound signature fixture as Go", () => {
	const fixture = JSON.parse(
		readFileSync(
			new URL("./fixtures/boundary-installation.json", import.meta.url),
			"utf8",
		),
	);
	expect(() =>
		verifyBoundaryAcceptance(
			JSON.stringify(fixture.envelope),
			fixture.expected,
		),
	).not.toThrow();
});

function fixture() {
	const keys = generateKeyPairSync("ed25519");
	const rawKey = keys.publicKey.export({ format: "jwk" }).x!;
	const expected = {
		publicKey: Buffer.from(rawKey, "base64url").toString("base64"),
		configDigest: "a".repeat(64),
		providerBinarySha256: "b".repeat(64),
		toolSchemaDigest: "c".repeat(64),
		probeSha256: "e".repeat(64),
		manifestSha256: "1".repeat(64),
		bootstrapSha256: "2".repeat(64),
	};
	const statement = {
		schemaVersion: 1,
		configDigest: expected.configDigest,
		providerBinarySha256: expected.providerBinarySha256,
		toolSchemaDigest: expected.toolSchemaDigest,
		probeSha256: expected.probeSha256,
		manifestSha256: expected.manifestSha256,
		bootstrapSha256: expected.bootstrapSha256,
		probeKind: "fixture_harness",
		hostAcceptance: false,
		notCovered: [
			"real_claude_context",
			"real_codex_context",
			"real_runner_context",
			"real_login_context",
			"process_authority",
			"privilege_paths",
			"private_transport",
			"headless_service",
			"legacy_cutover",
		],
		passed: true,
	};
	const encode = (value: unknown) =>
		JSON.stringify({
			statement: value,
			signature: sign(
				null,
				Buffer.from(`flywheel:xhs-boundary:v1\n${canonical(value)}`),
				keys.privateKey,
			).toString("base64"),
		});
	return { expected, statement, encode, raw: encode(statement) };
}
it("verifies the Go-compatible domain and all measured bindings", () => {
	const f = fixture();
	expect(() => verifyBoundaryAcceptance(f.raw, f.expected)).not.toThrow();
});
it.each([
	"configDigest",
	"providerBinarySha256",
	"toolSchemaDigest",
	"publicKey",
	"probeSha256",
	"manifestSha256",
	"bootstrapSha256",
] as const)("rejects independent %s drift", (key) => {
	const f = fixture();
	const mismatch =
		key === "publicKey"
			? Buffer.alloc(32, 2).toString("base64")
			: "d".repeat(64);
	expect(() =>
		verifyBoundaryAcceptance(f.raw, { ...f.expected, [key]: mismatch }),
	).toThrow("boundary_unproven");
});
it("rejects a signed failed verdict and unsigned edits to the verdict", () => {
	const f = fixture();
	const failed = f.encode({ ...f.statement, passed: false });
	expect(() => verifyBoundaryAcceptance(failed, f.expected)).toThrow(
		"boundary_unproven",
	);
	expect(() =>
		verifyBoundaryAcceptance(
			failed.replace('"passed":false', '"passed":true'),
			f.expected,
		),
	).toThrow("boundary_unproven");
});
it("rejects extra fields, duplicate keys, missing proof and malformed signature", () => {
	const f = fixture();
	for (const raw of [
		"",
		"{}",
		f.encode({ ...f.statement, approved: true }),
		f.raw.replace('"passed":true', '"passed":true,"passed":true'),
		JSON.stringify({ ...JSON.parse(f.raw), signature: "not-a-signature" }),
		f.raw + " ".repeat(4096),
	]) {
		expect(() => verifyBoundaryAcceptance(raw, f.expected)).toThrow(
			"boundary_unproven",
		);
	}
});

it("rejects an otherwise signed legacy statement without measured probe identity", () => {
	const f = fixture();
	const { probeSha256: _, ...legacy } = f.statement;
	expect(() => verifyBoundaryAcceptance(f.encode(legacy), f.expected)).toThrow(
		"boundary_unproven",
	);
});

it.each(["manifestSha256", "bootstrapSha256"] as const)(
	"requires signed %s even with all prior measurements",
	(key) => {
		const f = fixture();
		const legacy = { ...f.statement };
		delete (legacy as Partial<typeof legacy>)[key];
		expect(() =>
			verifyBoundaryAcceptance(f.encode(legacy), f.expected),
		).toThrow("boundary_unproven");
	},
);

it("requires the signed fixture-harness classification and rejects real-platform claims", () => {
	const f = fixture();
	const { probeKind: _, ...legacy } = f.statement;
	for (const value of [legacy, { ...f.statement, probeKind: "real_platform" }])
		expect(() => verifyBoundaryAcceptance(f.encode(value), f.expected)).toThrow(
			"boundary_unproven",
		);
});

it.each(["missing", "true", "scope-missing", "scope-shortened"])(
	"refuses signed fixture host-acceptance ambiguity: %s",
	(change) => {
		const f = fixture();
		const statement: Record<string, unknown> = { ...f.statement };
		if (change === "missing") delete statement.hostAcceptance;
		if (change === "true") statement.hostAcceptance = true;
		if (change === "scope-missing") delete statement.notCovered;
		if (change === "scope-shortened") statement.notCovered = ["legacy_cutover"];
		expect(() =>
			verifyBoundaryAcceptance(f.encode(statement), f.expected),
		).toThrow("boundary_unproven");
	},
);
