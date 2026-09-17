import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	assertAuthorityPrincipal,
	loadAuthorityConfig,
	parseAuthorityConfig,
	verifyProviderConfigBinding,
} from "../authority-config.js";

function configuration() {
	const base = "/Library/Application Support/Flywheel/Xhs";
	const state = "/var/db/flywheel-xhs";
	const pin = (name: string) => ({
		path: `${base}/${name}`,
		sha256: "a".repeat(64),
	});
	return {
		schemaVersion: 1,
		enabled: false,
		serviceUid: 450,
		serviceGid: 450,
		modelUid: 501,
		ingressGid: 451,
		policyVersion: 1,
		founderConfigVersion: 1,
		flywheelRevision: "b".repeat(40),
		providerRevision: "c".repeat(40),
		node: pin("node"),
		entry: pin("authority-main.js"),
		peerHelper: pin("peer-helper"),
		launcher: pin("authority-launcher"),
		boundaryProbe: pin("boundary-probe"),
		providerConfig: pin("provider.json"),
		stateRoot: state,
		ledgerPath: `${state}/ledger.db`,
		artifactRoot: `${state}/artifacts`,
		botTokenPath: `${state}/keys/card-bot`,
		permitKeyPath: `${state}/keys/permit`,
		authoritySocket: "/var/run/flywheel-xhs/authority.sock",
		ingressSocket: "/var/run/flywheel-xhs-ingress/request.sock",
		acceptancePath: `${base}/acceptance.json`,
		acceptancePublicKey: Buffer.alloc(32, 1).toString("base64"),
		keyId: "key-1",
		registry: [
			{
				projectId: "flywheel",
				leadId: "raya",
				account: {
					providerInstanceId: "xhs-1",
					accountUserId: "account-1",
					accountEpoch: 1,
					providerGeneration: "generation-1",
				},
				founderId: "12345678901234567",
				canonicalFounderId: "12345678901234567",
				botId: "12345678901234568",
				guildId: "12345678901234569",
				channelId: "12345678901234570",
				initialCursor: "12345678901234571",
			},
		],
	};
}

it("parses the complete root policy without inventing enabled or account defaults", () => {
	const input = configuration();
	expect(parseAuthorityConfig(JSON.stringify(input))).toEqual(input);
	const { enabled: _, ...missing } = input;
	expect(() => parseAuthorityConfig(JSON.stringify(missing))).toThrow(
		"authority_config_unavailable",
	);
});

it("binds the pinned provider startup to the same account, principal, revisions and private transport", () => {
	const config = parseAuthorityConfig(JSON.stringify(configuration()));
	const provider = {
		schemaVersion: 1,
		serviceUid: config.serviceUid,
		serviceGid: config.serviceGid,
		modelUid: config.modelUid,
		policyVersion: config.policyVersion,
		flywheelRevision: config.flywheelRevision,
		providerRevision: config.providerRevision,
		accountBase: config.registry[0]!.account,
		providerBinary: config.node,
		browser: config.node,
		boundaryProbe: config.boundaryProbe,
		guardian: {
			path: "/Library/Application Support/Flywheel/Xhs/guardian",
			sha256: "f".repeat(64),
		},
		ffmpeg: config.node,
		ffprobe: config.node,
		toolSchemaDigest: "d".repeat(64),
		epochPath: `${config.stateRoot}/epochs`,
		journalPath: `${config.stateRoot}/journal`,
		mediaRoot: `${config.stateRoot}/media`,
		profileRoot: `${config.stateRoot}/profiles`,
		providerSocket: "/var/run/flywheel-xhs/provider.sock",
		authoritySocket: config.authoritySocket,
		keyPath: config.permitKeyPath,
		keyId: config.keyId,
		acceptancePath:
			"/Library/Application Support/Flywheel/Xhs/provider-acceptance.json",
		acceptancePublicKey: config.acceptancePublicKey,
	};
	expect(verifyProviderConfigBinding(config, JSON.stringify(provider))).toEqual(
		provider,
	);
	for (const change of [
		{ guardian: undefined },
		{ boundaryProbe: undefined },
		{ boundaryProbe: { ...provider.boundaryProbe, sha256: "e".repeat(64) } },
		{ guardian: { ...provider.guardian, sha256: "invalid" } },
		{
			guardian: {
				...provider.guardian,
				path: `${provider.profileRoot}/guardian`,
			},
		},
		{ serviceUid: 501 },
		{ serviceGid: 20 },
		{ modelUid: 502 },
		{ policyVersion: 2 },
		{ flywheelRevision: "e".repeat(40) },
		{ providerRevision: "e".repeat(40) },
		{
			accountBase: { ...provider.accountBase, accountUserId: "other-account" },
		},
		{ authoritySocket: "/tmp/fake.sock" },
		{ keyPath: "/tmp/fake-key" },
		{ keyId: "other" },
		{ acceptancePublicKey: Buffer.alloc(32, 2).toString("base64") },
		{ mediaRoot: config.stateRoot },
		{ providerSocket: config.ingressSocket },
	]) {
		expect(() =>
			verifyProviderConfigBinding(
				config,
				JSON.stringify({ ...provider, ...change }),
			),
		).toThrow("authority_config_unavailable");
	}
});

it("requires a pinned launcher outside mutable roots", () => {
	const input = configuration();
	const { launcher: _, ...missing } = input;
	expect(() => parseAuthorityConfig(JSON.stringify(missing))).toThrow(
		"authority_config_unavailable",
	);
	for (const path of [input.entry.path, `${input.artifactRoot}/launcher`]) {
		expect(() =>
			parseAuthorityConfig(
				JSON.stringify({ ...input, launcher: { ...input.launcher, path } }),
			),
		).toThrow("authority_config_unavailable");
	}
});

it.each([
	(c: ReturnType<typeof configuration>) => {
		c.registry[0]!.canonicalFounderId = "12345678901234572";
	},
	(c: ReturnType<typeof configuration>) => {
		c.modelUid = c.serviceUid;
	},
	(c: ReturnType<typeof configuration>) => {
		c.serviceGid = 80;
	},
	(c: ReturnType<typeof configuration>) => {
		c.serviceUid = 0;
	},
	(c: ReturnType<typeof configuration>) => {
		c.ledgerPath = `${c.artifactRoot}/ledger.db`;
	},
	(c: ReturnType<typeof configuration>) => {
		c.botTokenPath = `${c.artifactRoot}/bot`;
	},
	(c: ReturnType<typeof configuration>) => {
		c.permitKeyPath = c.botTokenPath;
	},
	(c: ReturnType<typeof configuration>) => {
		c.ledgerPath = "/tmp/ledger.db";
	},
	(c: ReturnType<typeof configuration>) => {
		c.node.path = "/trusted/../node";
	},
	(c: ReturnType<typeof configuration>) => {
		c.authoritySocket = c.ingressSocket;
	},
	(c: ReturnType<typeof configuration>) => {
		c.registry.push(structuredClone(c.registry[0]!));
	},
	(c: ReturnType<typeof configuration>) => {
		c.acceptancePublicKey = "bad";
	},
])("rejects unsafe or ambiguous policy variant %$", (mutate) => {
	const input = configuration();
	mutate(input);
	expect(() => parseAuthorityConfig(JSON.stringify(input))).toThrow(
		"authority_config_unavailable",
	);
});

it("rejects caller approval fields and duplicate JSON keys", () => {
	expect(() =>
		parseAuthorityConfig(
			JSON.stringify({ ...configuration(), approved: true }),
		),
	).toThrow("authority_config_unavailable");
	expect(() =>
		parseAuthorityConfig(
			JSON.stringify(configuration()).replace(
				'"enabled":false',
				'"enabled":false,"enabled":true',
			),
		),
	).toThrow("authority_config_unavailable");
});

it("requires actual service UID/GID and disjoint model groups", () => {
	const config = parseAuthorityConfig(JSON.stringify(configuration()));
	const actual = {
		uid: 450,
		gid: 450,
		groups: [450],
		modelGroups: [20, 80, 501, 451],
	};
	expect(() => assertAuthorityPrincipal(config, actual)).not.toThrow();
	for (const change of [
		{ uid: 0 },
		{ uid: 501 },
		{ gid: 20 },
		{ groups: [450, 20] },
		{ modelGroups: [20, 450] },
		{ modelGroups: [20, 80, 501] },
		{ modelGroups: [] },
		{ modelGroups: [NaN] },
	]) {
		expect(() =>
			assertAuthorityPrincipal(config, { ...actual, ...change }),
		).toThrow("authority_config_unavailable");
	}
});

it("refuses a model-owned config even when it contains an otherwise valid policy", async () => {
	const dir = mkdtempSync("/tmp/xhs-config-");
	try {
		const path = join(dir, "policy.json");
		writeFileSync(path, JSON.stringify(configuration()), { mode: 0o644 });
		await expect(loadAuthorityConfig(path)).rejects.toThrow(
			"authority_config_unavailable",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
it("accepts optional dedicated probe channels but rejects any user-facing probe destination", () => {
	const input = configuration();
	const probe = {
		...input,
		registry: input.registry.map((entry) => ({
			...entry,
			probeChannelId: "22345678901234567",
		})),
	};
	expect(parseAuthorityConfig(JSON.stringify(probe)).registry[0]).toMatchObject(
		{ probeChannelId: "22345678901234567" },
	);
	expect(() =>
		parseAuthorityConfig(
			JSON.stringify({
				...probe,
				registry: probe.registry.map((entry) => ({
					...entry,
					probeChannelId: entry.channelId,
				})),
			}),
		),
	).toThrow("authority_config_unavailable");
});
