import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { verifyBoundaryAcceptance } from "./boundary-acceptance.js";
import { canonical, parseStrictJson } from "./canonical.js";
import {
	type InstallationBinding,
	readInstallationMetadata,
} from "./installation-metadata.js";
import { verifyPrivateAuthoritySocket } from "./launchd-private-path.js";
import { readImmutableFile, readRootReceipt } from "./trusted-files.js";

const unavailable = (): never => {
	throw Error("authority_config_unavailable");
};
class HostActivationReceiptAbsent extends Error {
	constructor() {
		super("host_activation_receipt_absent");
	}
}
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(256);
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
const path = z
	.string()
	.min(2)
	.max(4096)
	.refine(
		(value) =>
			isAbsolute(value) &&
			normalize(value) === value &&
			!value.includes("\0") &&
			!value.endsWith(sep),
	);
const pin = z
	.object({ path, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();
const registryEntry = z
	.object({
		projectId: identifier,
		leadId: identifier,
		account: z
			.object({
				providerInstanceId: identifier,
				accountUserId: identifier,
				accountEpoch: positive,
				providerGeneration: identifier,
			})
			.strict(),
		founderId: snowflake,
		canonicalFounderId: snowflake,
		botId: snowflake,
		guildId: snowflake,
		channelId: snowflake,
		initialCursor: snowflake,
		probeChannelId: snowflake.optional(),
	})
	.strict();
const schema = z
	.object({
		schemaVersion: z.literal(1),
		enabled: z.boolean(),
		serviceUid: positive,
		serviceGid: positive,
		modelUid: positive,
		ingressGid: positive,
		policyVersion: positive,
		founderConfigVersion: positive,
		flywheelRevision: z.string().regex(/^[a-f0-9]{40}$/),
		providerRevision: z.string().regex(/^[a-f0-9]{40}$/),
		node: pin,
		entry: pin,
		peerHelper: pin,
		launcher: pin,
		boundaryProbe: pin,
		providerConfig: pin,
		stateRoot: path,
		ledgerPath: path,
		artifactRoot: path,
		botTokenPath: path,
		permitKeyPath: path,
		authoritySocket: path,
		ingressSocket: path,
		acceptancePath: path,
		acceptancePublicKey: z.string(),
		keyId: identifier,
		registry: z.array(registryEntry).min(1).max(64),
	})
	.strict();
export type AuthorityConfig = z.infer<typeof schema>;
const providerSchema = z
	.object({
		schemaVersion: z.literal(1),
		serviceUid: positive,
		serviceGid: positive,
		modelUid: positive,
		policyVersion: positive,
		flywheelRevision: schema.shape.flywheelRevision,
		providerRevision: schema.shape.providerRevision,
		accountBase: registryEntry.shape.account,
		providerBinary: pin,
		browser: pin,
		guardian: pin,
		boundaryProbe: pin,
		ffmpeg: pin,
		ffprobe: pin,
		toolSchemaDigest: pin.shape.sha256,
		epochPath: path,
		journalPath: path,
		mediaRoot: path,
		profileRoot: path,
		providerSocket: path,
		authoritySocket: path,
		keyPath: path,
		keyId: identifier,
		acceptancePath: path,
		acceptancePublicKey: z.string(),
	})
	.strict();
export type ProviderStartupConfig = z.infer<typeof providerSchema>;

/** Exact JSON contract of the existing Go guardedStartup, with cross-service
 * equality checked before either service can acquire any private credentials. */
export function verifyProviderConfigBinding(
	config: AuthorityConfig,
	raw: string,
): ProviderStartupConfig {
	try {
		if (Buffer.byteLength(raw) > 64 * 1024) unavailable();
		const provider = providerSchema.parse(parseStrictJson(raw));
		for (const key of [
			"serviceUid",
			"serviceGid",
			"modelUid",
			"policyVersion",
			"flywheelRevision",
			"providerRevision",
			"authoritySocket",
			"keyId",
			"acceptancePublicKey",
		] as const) {
			if (provider[key] !== config[key]) unavailable();
		}
		if (
			canonical(provider.boundaryProbe) !== canonical(config.boundaryProbe) ||
			provider.keyPath !== config.permitKeyPath ||
			provider.providerSocket === config.ingressSocket ||
			provider.providerSocket === config.authoritySocket ||
			config.registry.some(
				(entry) => canonical(entry.account) !== canonical(provider.accountBase),
			)
		)
			unavailable();
		const roots = [
			provider.epochPath,
			provider.journalPath,
			provider.mediaRoot,
			provider.profileRoot,
			config.artifactRoot,
		];
		const protectedPaths = [
			config.ledgerPath,
			config.botTokenPath,
			config.permitKeyPath,
			config.authoritySocket,
			config.ingressSocket,
			provider.providerSocket,
			config.acceptancePath,
			provider.acceptancePath,
			config.entry.path,
			config.node.path,
			config.peerHelper.path,
			config.launcher.path,
			config.boundaryProbe.path,
			config.providerConfig.path,
			provider.providerBinary.path,
			provider.browser.path,
			provider.guardian.path,
			provider.ffmpeg.path,
			provider.ffprobe.path,
		];
		for (let i = 0; i < roots.length; i++) {
			const root = roots[i]!;
			if (
				!within(config.stateRoot, root) ||
				roots.some(
					(other, j) => j !== i && (other === root || within(root, other)),
				) ||
				protectedPaths.some((p) => p === root || within(root, p))
			)
				unavailable();
		}
		return provider;
	} catch {
		return unavailable();
	}
}
function within(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child !== "" &&
		child !== ".." &&
		!child.startsWith(`..${sep}`) &&
		!isAbsolute(child)
	);
}

/** Parsing is not an authorization decision. Only the root-owned loader may
 * supply this policy to the authority, and enabled still requires QA proof. */
export function parseAuthorityConfig(raw: string): AuthorityConfig {
	try {
		if (Buffer.byteLength(raw) > 64 * 1024) unavailable();
		const config = schema.parse(parseStrictJson(raw));
		if (
			config.modelUid === config.serviceUid ||
			config.serviceGid === 80 ||
			config.ingressGid === config.serviceGid ||
			config.ingressGid === 80
		)
			unavailable();
		const key = Buffer.from(config.acceptancePublicKey, "base64");
		if (
			key.length !== 32 ||
			key.toString("base64") !== config.acceptancePublicKey
		)
			unavailable();
		const privatePaths = [
			config.ledgerPath,
			config.artifactRoot,
			config.botTokenPath,
			config.permitKeyPath,
		];
		if (
			new Set(privatePaths).size !== privatePaths.length ||
			privatePaths.some((p) => !within(config.stateRoot, p))
		)
			unavailable();
		const protectedPaths = [
			config.ledgerPath,
			config.botTokenPath,
			config.permitKeyPath,
			config.authoritySocket,
			config.ingressSocket,
			config.acceptancePath,
			config.node.path,
			config.entry.path,
			config.peerHelper.path,
			config.launcher.path,
			config.boundaryProbe.path,
			config.providerConfig.path,
		];
		if (
			protectedPaths.some(
				(p) => p === config.artifactRoot || within(config.artifactRoot, p),
			) ||
			new Set(protectedPaths).size !== protectedPaths.length
		)
			unavailable();
		const scopes = new Set<string>();
		const userChannels = new Set(
			config.registry.map((entry) => entry.channelId),
		);
		const probes = new Map<string, string>();
		for (const entry of config.registry) {
			if (entry.probeChannelId) {
				const binding = JSON.stringify([entry.guildId, entry.botId]);
				if (
					userChannels.has(entry.probeChannelId) ||
					(probes.has(entry.probeChannelId) &&
						probes.get(entry.probeChannelId) !== binding)
				)
					unavailable();
				probes.set(entry.probeChannelId, binding);
			}
			const scope = JSON.stringify([entry.projectId, entry.leadId]);
			if (
				entry.founderId !== entry.canonicalFounderId ||
				entry.founderId === entry.botId ||
				scopes.has(scope)
			)
				unavailable();
			scopes.add(scope);
		}
		return config;
	} catch {
		return unavailable();
	}
}

export function assertAuthorityPrincipal(
	config: AuthorityConfig,
	actual: {
		uid: number;
		gid: number;
		groups: number[];
		modelGroups: number[];
	},
): void {
	if (
		actual.uid !== config.serviceUid ||
		actual.gid !== config.serviceGid ||
		actual.uid === config.modelUid ||
		actual.uid <= 0 ||
		config.serviceGid === 80 ||
		actual.groups.some((g) => g !== config.serviceGid) ||
		actual.modelGroups.length === 0 ||
		!actual.modelGroups.includes(config.ingressGid) ||
		actual.modelGroups.some(
			(g) => !Number.isSafeInteger(g) || g < 0 || g === config.serviceGid,
		)
	)
		unavailable();
}

/** All state ancestry must already be provisioned by the trusted installer.
 * No mkdir/chown/provisioning and no private secret reads occur in this loader. */
function privateRoot(root: string, uid: number): void {
	for (let current = root; ; current = dirname(current)) {
		const stat = lstatSync(current);
		if (
			!stat.isDirectory() ||
			(stat.mode & 0o022) !== 0 ||
			(current === root
				? stat.uid !== uid || (stat.mode & 0o7777) !== 0o700
				: stat.uid !== 0 && stat.uid !== uid)
		)
			unavailable();
		if (current === dirname(current)) break;
	}
}

export async function loadAuthorityConfig(configPath: string): Promise<
	AuthorityConfig & {
		configDigest: string;
		provider: ProviderStartupConfig;
		installation: InstallationBinding;
	}
> {
	try {
		const raw = readImmutableFile(configPath, { maxBytes: 64 * 1024 });
		const decode = (bytes: Buffer) =>
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const config = parseAuthorityConfig(decode(raw));
		if (
			!process.getuid ||
			!process.getgid ||
			!process.getgroups ||
			process.getuid() !== config.serviceUid ||
			process.getgid() !== config.serviceGid
		)
			unavailable();
		const { stdout } = await promisify(execFile)(
			"/usr/bin/id",
			["-G", String(config.modelUid)],
			{
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				timeout: 1000,
				maxBuffer: 1024,
				encoding: "utf8",
			},
		);
		if (!/^\d+(?:\s+\d+)*\s*$/.test(stdout)) unavailable();
		assertAuthorityPrincipal(config, {
			uid: process.getuid!(),
			gid: process.getgid!(),
			groups: process.getgroups!(),
			modelGroups: stdout.trim().split(/\s+/).map(Number),
		});
		if (
			process.execPath !== config.node.path ||
			process.argv[1] !== config.entry.path
		)
			unavailable();
		for (const binary of [config.node, config.peerHelper, config.launcher])
			readImmutableFile(binary.path, {
				sha256: binary.sha256,
				executable: true,
				maxBytes: 256 * 1024 * 1024,
			});
		readImmutableFile(config.entry.path, {
			sha256: config.entry.sha256,
			maxBytes: 16 * 1024 * 1024,
		});
		const providerRaw = readImmutableFile(config.providerConfig.path, {
			sha256: config.providerConfig.sha256,
			maxBytes: 64 * 1024,
		});
		const provider = verifyProviderConfigBinding(config, decode(providerRaw));
		for (const binary of [
			provider.providerBinary,
			provider.browser,
			provider.guardian,
			provider.boundaryProbe,
			provider.ffmpeg,
			provider.ffprobe,
		]) {
			readImmutableFile(binary.path, {
				sha256: binary.sha256,
				executable: true,
				maxBytes: 256 * 1024 * 1024,
			});
		}
		const configDigest = createHash("sha256").update(raw).digest("hex");
		const installation = readInstallationMetadata();
		verifyBoundaryAcceptance(
			decode(
				readRootReceipt(config.acceptancePath, {
					serviceUid: config.serviceUid,
					maxBytes: 4096,
				}),
			),
			{
				publicKey: config.acceptancePublicKey,
				configDigest,
				providerBinarySha256: provider.providerBinary.sha256,
				toolSchemaDigest: provider.toolSchemaDigest,
				probeSha256: config.boundaryProbe.sha256,
				...installation,
			},
		);
		// The only supported receipt attests synthetic fixture evidence. A root
		// enabled flag cannot substitute for the separately designed host proof.
		if (config.enabled) throw new HostActivationReceiptAbsent();
		privateRoot(config.stateRoot, config.serviceUid);
		privateRoot(config.artifactRoot, config.serviceUid);
		verifyPrivateAuthoritySocket(config);
		return { ...config, configDigest, provider, installation };
	} catch (error) {
		if (error instanceof HostActivationReceiptAbsent) throw error;
		return unavailable();
	}
}
