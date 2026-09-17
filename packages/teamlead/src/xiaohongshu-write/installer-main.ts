import {
	createHash,
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
} from "node:crypto";
import { z } from "zod";
import {
	parseAuthorityConfig,
	verifyProviderConfigBinding,
} from "./authority-config.js";
import {
	statementSchema,
	verifyBoundaryAcceptance,
} from "./boundary-acceptance.js";
import { canonical, parseStrictJson } from "./canonical.js";
import { runInstallerFixture } from "./fixture-orchestrator.js";
import {
	persistFixtureObservations,
	persistFixtureSignature,
} from "./fixture-provision.js";
import {
	INSTALLATION_METADATA_PATH,
	parseInstallationMetadata,
} from "./installation-metadata.js";
import {
	parseInstalledTreeManifest,
	verifyInstalledTree,
} from "./installed-tree.js";
import { verifyManifestProjection } from "./installer-manifests.js";
import { readImmutableFile } from "./trusted-files.js";

const root = "/Library/Application Support/Flywheel/Xhs",
	runtime = `${root}/runtime`;
const installerSchema = z
	.object({
		schemaVersion: z.literal(1),
		authorityConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
		modelGid: z.number().int().min(1).max(2147483647),
	})
	.strict();
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const read = (path: string, maxBytes: number, digest?: string) =>
	new TextDecoder("utf-8", { fatal: true }).decode(
		readImmutableFile(path, { maxBytes, sha256: digest }),
	);

/** Called only by the fixed installed entry after native pre-Node verification.
 * No argv/config paths or uploaded probe JSON. The independent installer owns
 * the fixed root-only signing key; model or service processes never receive it.
 * Failure retains fixture evidence and never retries an external action. */
export async function runInstalledFixture() {
	try {
		if (
			process.getuid?.() !== 0 ||
			process.geteuid?.() !== 0 ||
			process.execPath !== `${runtime}/node`
		)
			throw Error();
		const policy = read(`${root}/installer-bootstrap.policy`, 1024);
		const json = read(`${root}/runtime.manifest.json`, 4 * 1024 * 1024);
		const native = read(`${root}/runtime.manifest`, 4 * 1024 * 1024);
		const binding = verifyManifestProjection(policy, json, native);
		const metadataRaw = read(INSTALLATION_METADATA_PATH, 1024);
		const installation = parseInstallationMetadata(metadataRaw);
		if (installation.manifestSha256 !== binding.manifestSha256) throw Error();
		const manifest = parseInstalledTreeManifest(json);
		verifyInstalledTree(json);
		const entries = new Map(
			manifest.entries.map((entry) => [entry.path, entry]),
		);
		const file = (path: string) => {
			const entry = entries.get(path);
			if (!entry || entry.kind !== "file") throw Error();
			return entry;
		};
		const installed = installerSchema.parse(
			parseStrictJson(
				read(
					`${runtime}/fixture-installer.json`,
					4096,
					file("fixture-installer.json").sha256,
				),
			),
		);
		const bootstrap = file("xhs-installer-bootstrap");
		if (
			!(bootstrap.mode & 0o111) ||
			bootstrap.sha256 !== installation.bootstrapSha256
		)
			throw Error();
		const authority = parseAuthorityConfig(
			read(
				`${root}/authority.json`,
				64 * 1024,
				installed.authorityConfigSha256,
			),
		);
		if (
			authority.enabled !== false ||
			authority.acceptancePath !== `${root}/acceptance.json` ||
			authority.node.path !== process.execPath ||
			installed.modelGid === authority.serviceGid
		)
			throw Error();
		const providerRaw = read(
			authority.providerConfig.path,
			64 * 1024,
			authority.providerConfig.sha256,
		);
		const provider = verifyProviderConfigBinding(authority, providerRaw);
		if (provider.acceptancePath !== `${root}/provider-acceptance.json`)
			throw Error();
		for (const pin of [
			authority.node,
			authority.peerHelper,
			authority.boundaryProbe,
			provider.providerBinary,
			provider.browser,
			provider.guardian,
			provider.boundaryProbe,
			provider.ffmpeg,
			provider.ffprobe,
		]) {
			if (
				!pin.path.startsWith(`${runtime}/`) ||
				file(pin.path.slice(runtime.length + 1)).sha256 !== pin.sha256
			)
				throw Error();
		}
		const principal = file("xhs-fixture-principal");
		if (!(principal.mode & 0o111)) throw Error();
		const nonce = randomBytes(32).toString("hex");
		const observations = await runInstallerFixture({
			serviceUid: authority.serviceUid,
			serviceGid: authority.serviceGid,
			modelUid: authority.modelUid,
			modelGid: installed.modelGid,
			nonce,
			node: authority.node,
			peerHelper: authority.peerHelper,
			boundaryProbe: authority.boundaryProbe,
			principalRunner: {
				path: `${runtime}/xhs-fixture-principal`,
				sha256: principal.sha256,
			},
		});
		// Refuse a receipt if root deployment changed while the probes ran.
		read(`${root}/installer-bootstrap.policy`, 1024, sha(policy));
		read(`${root}/runtime.manifest.json`, 4 * 1024 * 1024, binding.jsonSha256);
		read(`${root}/runtime.manifest`, 4 * 1024 * 1024, binding.manifestSha256);
		read(`${root}/authority.json`, 64 * 1024, installed.authorityConfigSha256);
		read(INSTALLATION_METADATA_PATH, 1024, sha(metadataRaw));
		read(
			authority.providerConfig.path,
			64 * 1024,
			authority.providerConfig.sha256,
		);
		verifyInstalledTree(json);
		const raw = JSON.stringify({
			...observations,
			...binding,
			...installation,
			authorityConfigSha256: installed.authorityConfigSha256,
			createdAt: new Date().toISOString(),
		});
		const receiptSha256 = persistFixtureObservations(nonce, raw);
		// The collector above runs the trusted probes itself. There is no API to
		// import an observation file or to sign a caller-supplied passed statement.
		const keyBytes = readImmutableFile(`${root}/boundary-signing.key`, {
			maxBytes: 4096,
			mode: 0o600,
		});
		let signatures: { path: string; raw: string }[];
		try {
			const key = createPrivateKey({
				key: keyBytes,
				format: "pem",
				type: "pkcs8",
			});
			if (key.asymmetricKeyType !== "ed25519") throw Error();
			const publicKey = Buffer.from(
				createPublicKey(key).export({ format: "jwk" }).x!,
				"base64url",
			).toString("base64");
			if (
				publicKey !== authority.acceptancePublicKey ||
				publicKey !== provider.acceptancePublicKey
			)
				throw Error();
			signatures = [
				{
					path: authority.acceptancePath,
					configDigest: installed.authorityConfigSha256,
				},
				{ path: provider.acceptancePath, configDigest: sha(providerRaw) },
			].map(({ path, configDigest }) => {
				const expected = {
					publicKey,
					configDigest,
					providerBinarySha256: provider.providerBinary.sha256,
					toolSchemaDigest: provider.toolSchemaDigest,
					probeSha256: authority.boundaryProbe.sha256,
					...installation,
				};
				const { publicKey: _, ...measurements } = expected;
				const statement = statementSchema.parse({
					...measurements,
					schemaVersion: 1,
					probeKind: "fixture_harness",
					passed: true,
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
				});
				const raw = JSON.stringify({
					statement,
					signature: sign(
						null,
						Buffer.from(`flywheel:xhs-boundary:v1\n${canonical(statement)}`),
						key,
					).toString("base64"),
				});
				verifyBoundaryAcceptance(raw, expected);
				return { path, raw };
			});
		} finally {
			keyBytes.fill(0);
		}
		// Exclusive files retain partial output on failure. This is deliberately
		// not advertised as an atomic two-file publication or automatic retry.
		const signatureSha256 = signatures.map(({ path, raw }) =>
			persistFixtureSignature(path, raw),
		);
		return {
			schemaVersion: 1,
			probeKind: "fixture_harness",
			hostAcceptance: false,
			nonce,
			receiptSha256,
			signatureSha256,
		};
	} catch {
		throw Error("installed_fixture_unavailable");
	}
}
