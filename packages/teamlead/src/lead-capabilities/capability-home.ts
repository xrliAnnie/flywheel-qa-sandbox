import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import {
	LEAD_PERMISSION_PROFILE,
	type LeadPermissionProfileSpec,
	renderLeadPermissionProfile,
} from "./permission-profile.js";

const denied = () => new Error("capability_home_configuration_rejected");
const HEADER = "# Flywheel managed capability bundle v2\n";
const PROOF_NAME = ".flywheel-capability-config.sha256";
const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");
/** Parent-only home assembly under the runtime's exclusive activation ownership.
 * Does not provision/copy auth, start a daemon, or claim OS confinement. */
export async function ensureLeadCapabilityHome(options: {
	codexHome: string;
	activationRoot: string;
	permissionProfile: LeadPermissionProfileSpec;
	assertCurrent(): Promise<void>;
}): Promise<void> {
	await options.assertCurrent();
	const home = options.codexHome,
		activationRoot = options.activationRoot;
	const spec = structuredClone(options.permissionProfile);
	const expected = parse(renderLeadPermissionProfile(spec));
	const under = (child: string, parent: string) =>
		child === parent || child.startsWith(`${parent}/`);
	function directory(path: string) {
		const stat = lstatSync(path);
		if (
			realpathSync(path) !== path ||
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0
		)
			throw denied();
		return stat;
	}
	const originalHome = directory(home),
		originalActivation = directory(activationRoot);
	if (
		under(home, spec.projectRoot) ||
		under(activationRoot, spec.projectRoot) ||
		under(home, activationRoot) ||
		under(activationRoot, home)
	)
		throw denied();
	const socketAllowed = (socket: string) =>
		/^run-[A-Za-z0-9_-]+\/broker\.sock$/.test(relative(activationRoot, socket));
	if (!socketAllowed(spec.brokerSocket)) throw denied();
	const configPath = join(home, "config.toml");
	const proofPath = join(home, PROOF_NAME);
	function readPrivateFile(path: string, maximumBytes: number) {
		let fd: number;
		try {
			fd = openSync(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw denied();
		}
		try {
			const stat = fstatSync(fd);
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.uid !== process.getuid?.() ||
				(stat.mode & 0o077) !== 0 ||
				stat.size > maximumBytes
			)
				throw denied();
			const buffer = Buffer.alloc(maximumBytes + 1),
				size = readSync(fd, buffer, 0, buffer.length, 0);
			if (size !== stat.size || size > maximumBytes) throw denied();
			return { stat, text: buffer.subarray(0, size).toString("utf8") };
		} finally {
			closeSync(fd);
		}
	}
	const readExisting = () => readPrivateFile(configPath, 1024 * 1024);
	const readProof = () => {
		const file = readPrivateFile(proofPath, 130);
		if (!file) return undefined;
		const hashes = file.text.trim().split("\n");
		if (
			hashes.length < 1 ||
			hashes.length > 2 ||
			new Set(hashes).size !== hashes.length ||
			hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
		)
			throw denied();
		return hashes;
	};
	const nextText = HEADER + renderLeadPermissionProfile(spec),
		nextHash = sha256(nextText),
		existing = readExisting(),
		proof = readProof();
	let existingHash: string | undefined;
	if (existing) {
		if (!existing.text.startsWith(HEADER)) throw denied();
		existingHash = sha256(existing.text);
		if (proof && !proof.includes(existingHash)) throw denied();
		const previous = parse(existing.text);
		const profile = (previous.permissions as Record<string, any> | undefined)?.[
			LEAD_PERMISSION_PROFILE
		];
		const sockets = Object.keys(profile?.network?.unix_sockets ?? {}),
			proxy = profile?.network?.proxy_url;
		if (
			sockets.length !== 1 ||
			!(
				socketAllowed(sockets[0]!) ||
				/^fw-cap-[A-Za-z0-9]+\/run-[A-Za-z0-9_-]+\/broker\.sock$/.test(
					relative(dirname(activationRoot), sockets[0]!),
				)
			) ||
			typeof proxy !== "string" ||
			!/^http:\/\/127\.0\.0\.1:\d+$/.test(proxy)
		)
			throw denied();
		// Previous activation directories may already be removed. Recognize only
		// the factory's disposable artifact name in this same project, then compare
		// the entire old policy; never accept unrelated grants or MCP additions.
		const oldArtifacts = Object.keys(profile?.filesystem ?? {}).filter(
			(entry) =>
				/^\.flywheel-artifacts-[A-Za-z0-9]+$/.test(
					relative(spec.projectRoot, entry),
				),
		);
		if (oldArtifacts.length > 1) throw denied();
		const filesystem = profile?.filesystem;
		if (!filesystem || typeof filesystem !== "object") throw denied();
		const dynamicReads = (entries: Record<string, unknown>, artifact: string) =>
			Object.entries(entries)
				.filter(
					([entry, access]) =>
						access === "read" &&
						!entry.startsWith(":") &&
						entry !== spec.deploymentRoot &&
						entry !== artifact,
				)
				.map(([entry]) => entry);
		const oldArtifact = oldArtifacts[0] ?? spec.artifactRoot,
			oldReads = dynamicReads(filesystem, oldArtifact),
			currentProfile = (expected.permissions as Record<string, any>)[
				LEAD_PERMISSION_PROFILE
			],
			currentReads = dynamicReads(currentProfile.filesystem, spec.artifactRoot),
			oldCredentials = Object.entries(filesystem)
				.filter(
					([entry, access]) => access === "deny" && !entry.startsWith(":"),
				)
				.map(([entry]) => entry);
		if (!proof && oldReads.length !== currentReads.length) throw denied();
		const oldSpec = {
			...spec,
			artifactRoot: oldArtifact,
			...(!proof
				? { readPaths: oldReads, credentialPaths: oldCredentials }
				: {}),
			brokerSocket: sockets[0]!,
			proxyPort: Number(new URL(proxy).port),
		};
		if (!proof) {
			let renderedPrevious: unknown;
			try {
				renderedPrevious = parse(renderLeadPermissionProfile(oldSpec));
			} catch {
				throw denied();
			}
			if (!isDeepStrictEqual(previous, renderedPrevious)) throw denied();
		}
		if (
			isDeepStrictEqual(previous, expected) &&
			proof?.length === 1 &&
			proof[0] === nextHash
		)
			return;
	} else if (proof && !proof.includes(nextHash)) throw denied();
	const temp = join(home, `.capability-config-${randomUUID()}.tmp`),
		proofTemp = join(home, `.capability-proof-${randomUUID()}.tmp`),
		proofCompactTemp = join(home, `.capability-proof-${randomUUID()}.tmp`);
	function writePrivate(path: string, contents: string) {
		const fd = openSync(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(fd, contents);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	try {
		writePrivate(temp, nextText);
		writePrivate(
			proofTemp,
			`${[...new Set([existingHash, nextHash].filter(Boolean))].join("\n")}\n`,
		);
		writePrivate(proofCompactTemp, `${nextHash}\n`);
		await options.assertCurrent();
		const currentHome = directory(home),
			currentActivation = directory(activationRoot);
		if (
			currentHome.dev !== originalHome.dev ||
			currentHome.ino !== originalHome.ino ||
			currentActivation.dev !== originalActivation.dev ||
			currentActivation.ino !== originalActivation.ino
		)
			throw denied();
		const current = readExisting();
		if (
			current?.text !== existing?.text ||
			current?.stat.ino !== existing?.stat.ino ||
			current?.stat.dev !== existing?.stat.dev
		)
			throw denied();
		// Publish an old+new hash transition before replacing config.toml. A crash
		// on either side of the config rename remains restartable without trusting
		// an unproven config; the final rename compacts the proof to the new hash.
		renameSync(proofTemp, proofPath);
		renameSync(temp, configPath);
		renameSync(proofCompactTemp, proofPath);
	} finally {
		rmSync(temp, { force: true });
		rmSync(proofTemp, { force: true });
		rmSync(proofCompactTemp, { force: true });
	}
}
