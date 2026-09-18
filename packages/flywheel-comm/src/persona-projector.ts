import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	canonicalSubmissionDigest,
	type PersonaPin,
	type PersonaProjection,
	withMkdirLock,
} from "flywheel-config";
import {
	type PersonaActivationView,
	readPersonaActivation,
} from "./persona-activation-client.js";

const MAX_PERSONA_BYTES = 256 * 1024;
const TARGET_PATH = ".lead/raya/identity.md";
const FIXED_REPO = "xrliAnnie/raya";

export interface PersonaProjectSelector {
	projectsDigest: string;
	projectName: string;
	leadId: string;
	projectRoot: string;
	projectRepo?: string;
	personaProjection?: PersonaProjection;
	personaProjectionContractDigest?: string;
}

export type PersonaProjectionSource =
	| "target"
	| "pre-m0-lkg"
	| "post-m0-fallback";

export type PersonaProjectResult =
	| { status: "skipped"; reason: "not_raya" | "not_enrolled" }
	| {
			status: "projected" | "fallback";
			source: PersonaProjectionSource;
			personaBlobDigest: string;
			commit: string;
			contractDigest: string;
			activationRevision: string;
			changed: boolean;
	  }
	| { status: "refused"; reason: string };

export interface PersonaProjectorDeps {
	readActivation?: () => Promise<PersonaActivationView>;
	readSelector?: () => Promise<PersonaProjectSelector> | PersonaProjectSelector;
	fetchBlob?: (pin: PersonaPin) => Promise<Buffer>;
	withLock?: typeof withMkdirLock;
	stateRoot: string;
	bridgeUrl?: string;
	bridgeToken?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	/** Test seam for exercising the network-failure fallback after validating a local A0. */
	preferLocalTarget?: boolean;
}

export interface ExactPersonaFetchOptions {
	repoUrl?: string;
	allowTestRepository?: boolean;
	authToken?: string;
	env?: NodeJS.ProcessEnv;
	tempRoot?: string;
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function samePin(left: PersonaPin, right: PersonaPin): boolean {
	return canonicalSubmissionDigest(left) === canonicalSubmissionDigest(right);
}

function safeReadPersona(path: string): Buffer {
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	const fd = openSync(path, flags);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.isSymbolicLink())
			throw new Error("persona_not_regular");
		if (before.nlink !== 1) throw new Error("persona_hardlink_refused");
		if ((before.mode & 0o077) !== 0) throw new Error("persona_mode_invalid");
		if (before.size < 1 || before.size > MAX_PERSONA_BYTES)
			throw new Error("persona_size_invalid");
		const data = readFileSync(fd);
		const after = fstatSync(fd);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			data.length !== before.size
		)
			throw new Error("persona_changed_during_read");
		return data;
	} finally {
		closeSync(fd);
	}
}

function optionalSafeRead(path: string): Buffer | undefined {
	try {
		return safeReadPersona(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function assertDirectory(
	path: string,
	label: string,
): { dev: number; ino: number } {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`${label}_unsafe`);
	return { dev: stat.dev, ino: stat.ino };
}

function hasGitMarker(root: string): boolean {
	let current = root;
	for (;;) {
		try {
			lstatSync(join(current, ".git"));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("persona_git_status_unavailable");
		}
		const parent = resolve(current, "..");
		if (parent === current) return false;
		current = parent;
	}
}

function localGit(args: string[]): ReturnType<typeof spawnSync> {
	const env = sanitizedGitEnv(process.env);
	env.LC_ALL = "C";
	env.LANG = "C";
	return spawnSync("git", args, {
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		maxBuffer: 64 * 1024,
	});
}

function isGitWorktree(root: string): boolean {
	const probe = localGit(["-C", root, "rev-parse", "--is-inside-work-tree"]);
	if (probe.status === 0) {
		const answer = String(probe.stdout).trim();
		if (answer === "true") return true;
		if (answer === "false") return false;
		throw new Error("persona_git_status_unavailable");
	}
	const plainNonGitWorkspace =
		probe.status === 128 &&
		/^fatal: not a git repository\b/.test(String(probe.stderr).trim()) &&
		!hasGitMarker(root);
	if (plainNonGitWorkspace) return false;
	throw new Error("persona_git_status_unavailable");
}

function ensureTargetDirectory(projectRoot: string): {
	root: string;
	target: string;
	parent: string;
	parentIdentity: { dev: number; ino: number };
} {
	const requested = resolve(projectRoot);
	const root = realpathSync.native(requested);
	if (root !== requested) throw new Error("persona_workspace_not_canonical");
	assertDirectory(root, "persona_workspace");
	if (isGitWorktree(root)) {
		const tracked = localGit([
			"-C",
			root,
			"ls-files",
			"--error-unmatch",
			"--",
			TARGET_PATH,
		]);
		if (tracked.status === 0) throw new Error("persona_target_tracked");
		if (tracked.status !== 1) throw new Error("persona_git_status_unavailable");
	}
	const leadDir = join(root, ".lead");
	const personaDir = join(leadDir, "raya");
	for (const [path, label] of [
		[leadDir, "persona_lead_dir"],
		[personaDir, "persona_parent"],
	] as const) {
		try {
			assertDirectory(path, label);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			mkdirSync(path, { mode: 0o700 });
			chmodSync(path, 0o700);
			assertDirectory(path, label);
		}
	}
	const target = join(root, TARGET_PATH);
	return {
		root,
		target,
		parent: personaDir,
		parentIdentity: assertDirectory(personaDir, "persona_parent"),
	};
}

function assertParentUnchanged(
	path: string,
	identity: { dev: number; ino: number },
): void {
	const current = assertDirectory(path, "persona_parent");
	if (current.dev !== identity.dev || current.ino !== identity.ino) {
		throw new Error("persona_parent_replaced");
	}
}

function throwInstallFailures(errors: unknown[]): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "persona_install_cleanup_failed");
}

function installPersona(
	target: string,
	parent: string,
	parentIdentity: { dev: number; ino: number },
	bytes: Buffer,
): boolean {
	if (bytes.length < 1 || bytes.length > MAX_PERSONA_BYTES)
		throw new Error("persona_size_invalid");
	const existing = optionalSafeRead(target);
	if (existing?.equals(bytes)) return false;
	const temp = join(
		parent,
		`.identity.md.tmp.${process.pid}.${randomBytes(8).toString("hex")}`,
	);
	let fd: number | undefined;
	let changed = false;
	const errors: unknown[] = [];
	try {
		fd = openSync(
			temp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(fd, bytes);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		assertParentUnchanged(parent, parentIdentity);
		if (existing) safeReadPersona(target);
		renameSync(temp, target);
		const parentFd = openSync(parent, constants.O_RDONLY);
		try {
			fsyncSync(parentFd);
		} finally {
			closeSync(parentFd);
		}
		changed = true;
	} catch (error) {
		errors.push(error);
	}
	if (fd !== undefined) {
		try {
			closeSync(fd);
		} catch (error) {
			errors.push(error);
		}
	}
	try {
		unlinkSync(temp);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
	}
	throwInstallFailures(errors);
	return changed;
}

function sanitizedGitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_") || key === "GITHUB_TOKEN" || key === "GH_TOKEN")
			delete env[key];
	}
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
	};
}

export async function fetchExactPersonaBlob(
	pin: PersonaPin,
	options: ExactPersonaFetchOptions = {},
): Promise<Buffer> {
	const repoUrl = options.repoUrl ?? `https://github.com/${FIXED_REPO}.git`;
	if (
		repoUrl !== `https://github.com/${FIXED_REPO}.git` &&
		options.allowTestRepository !== true
	) {
		throw new Error("persona_repository_refused");
	}
	const env = sanitizedGitEnv(options.env ?? process.env);
	let token = options.authToken;
	if (!token && repoUrl.startsWith("https://github.com/")) {
		try {
			token = execFileSync(
				"gh",
				["auth", "token", "--hostname", "github.com"],
				{
					encoding: "utf8",
					env,
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 10_000,
				},
			).trim();
		} catch {
			throw new Error("persona_github_auth_unavailable");
		}
		if (!token) throw new Error("persona_github_auth_unavailable");
	}
	const base = options.tempRoot ?? tmpdir();
	const temp = join(
		base,
		`flywheel-persona-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
	mkdirSync(temp, { mode: 0o700 });
	chmodSync(temp, 0o700);
	try {
		const gitEnv = { ...env };
		const config: Array<[string, string]> = [
			["credential.helper", ""],
			["http.followRedirects", "false"],
			["core.hooksPath", "/dev/null"],
			["submodule.recurse", "false"],
			[
				"protocol.file.allow",
				options.allowTestRepository === true ? "always" : "never",
			],
		];
		if (token) {
			config.push([
				"http.https://github.com/.extraHeader",
				`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
			]);
		}
		gitEnv.GIT_CONFIG_COUNT = String(config.length);
		for (const [index, [key, value]] of config.entries()) {
			gitEnv[`GIT_CONFIG_KEY_${index}`] = key;
			gitEnv[`GIT_CONFIG_VALUE_${index}`] = value;
		}
		const git = (args: string[], encoding: "utf8" | "buffer" = "utf8") =>
			execFileSync("git", args, {
				cwd: temp,
				env: gitEnv,
				encoding: encoding === "buffer" ? null : "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
				maxBuffer: MAX_PERSONA_BYTES + 64 * 1024,
			}) as unknown as typeof encoding extends "buffer" ? Buffer : string;
		git(["init", "--bare", "."]);
		git(["fetch", "--no-tags", "--depth=1", repoUrl, pin.commit]);
		const commit = String(git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
		if (commit !== pin.commit) throw new Error("persona_commit_mismatch");
		const tree = String(git(["ls-tree", pin.commit, "--", TARGET_PATH])).trim();
		const match =
			/^100644 blob ([a-f0-9]{40})\t\.lead\/raya\/identity\.md$/.exec(tree);
		if (!match) throw new Error("persona_tree_entry_invalid");
		const size = Number(String(git(["cat-file", "-s", match[1]!])).trim());
		if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PERSONA_BYTES)
			throw new Error("persona_size_invalid");
		const bytes = git(
			["cat-file", "blob", match[1]!],
			"buffer",
		) as unknown as Buffer;
		if (bytes.length !== size) throw new Error("persona_blob_size_mismatch");
		if (sha256(bytes) !== pin.personaBlobDigest)
			throw new Error("persona_blob_digest_mismatch");
		return bytes;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function authorityMatches(
	before: PersonaActivationView,
	after: PersonaActivationView,
): boolean {
	return canonicalSubmissionDigest(before) === canonicalSubmissionDigest(after);
}

export async function projectPersona(
	selector: PersonaProjectSelector,
	deps: PersonaProjectorDeps,
): Promise<PersonaProjectResult> {
	if (selector.projectName !== "raya" || selector.leadId !== "raya") {
		return { status: "skipped", reason: "not_raya" };
	}
	const contract = selector.personaProjection;
	if (!contract) return { status: "skipped", reason: "not_enrolled" };
	if (
		selector.projectRepo !== FIXED_REPO ||
		contract.repo !== FIXED_REPO ||
		contract.path !== TARGET_PATH ||
		!selector.personaProjectionContractDigest ||
		canonicalSubmissionDigest(contract) !==
			selector.personaProjectionContractDigest
	)
		return { status: "refused", reason: "persona_contract_invalid" };

	const readActivation =
		deps.readActivation ??
		(() =>
			readPersonaActivation({
				baseUrl: deps.bridgeUrl ?? "http://localhost:9876",
				token:
					deps.bridgeToken ??
					deps.env?.TEAMLEAD_API_TOKEN ??
					process.env.TEAMLEAD_API_TOKEN ??
					"",
				projectName: "raya",
				leadId: "raya",
			}));
	let activation: PersonaActivationView;
	try {
		activation = await readActivation();
	} catch (error) {
		return {
			status: "refused",
			reason:
				error instanceof Error
					? error.message
					: "persona_activation_unavailable",
		};
	}
	if (activation.kind === "unmanaged" || activation.kind === "legacy-managed") {
		return { status: "refused", reason: "persona_contract_not_activated" };
	}
	if (activation.kind === "fenced" || activation.kind === "refused") {
		return {
			status: "refused",
			reason:
				activation.kind === "refused"
					? activation.reason
					: "persona_activation_fenced",
		};
	}
	if (activation.contractDigest !== selector.personaProjectionContractDigest) {
		return { status: "refused", reason: "persona_contract_digest_changed" };
	}
	const expected =
		activation.kind === "pre-m0" ? contract.lastKnownGood : activation.expected;
	if (
		(activation.kind === "pre-m0" &&
			(!samePin(contract.pin, contract.lastKnownGood) ||
				expected.personaBlobDigest !== activation.a0Digest)) ||
		(activation.kind === "post-m0" &&
			!samePin(contract.pin, activation.expected))
	)
		return { status: "refused", reason: "persona_activation_pin_mismatch" };

	const currentSelector = deps.readSelector
		? await deps.readSelector()
		: selector;
	if (
		currentSelector.projectsDigest !== selector.projectsDigest ||
		currentSelector.personaProjectionContractDigest !==
			selector.personaProjectionContractDigest
	)
		return { status: "refused", reason: "persona_registry_changed" };

	const run = deps.withLock ?? withMkdirLock;
	try {
		return await run(
			join(deps.stateRoot, "projector.lock"),
			async () => {
				const location = ensureTargetDirectory(selector.projectRoot);
				const existing = optionalSafeRead(location.target);
				if (
					deps.preferLocalTarget !== false &&
					existing &&
					sha256(existing) === expected.personaBlobDigest
				) {
					const after = await readActivation();
					if (!authorityMatches(activation, after))
						throw new Error("persona_activation_changed");
					return {
						status: "projected" as const,
						source: "target" as const,
						personaBlobDigest: expected.personaBlobDigest,
						commit: expected.commit,
						contractDigest: selector.personaProjectionContractDigest!,
						activationRevision: activation.revision,
						changed: false,
					};
				}

				let selectedBytes: Buffer;
				let source: PersonaProjectionSource = "target";
				let status: "projected" | "fallback" = "projected";
				let selectedPin = expected;
				try {
					selectedBytes = await (
						deps.fetchBlob ??
						((pin) => fetchExactPersonaBlob(pin, { env: deps.env }))
					)(expected);
					if (sha256(selectedBytes) !== expected.personaBlobDigest)
						throw new Error("persona_blob_digest_mismatch");
				} catch (fetchError) {
					status = "fallback";
					if (activation.kind === "pre-m0") {
						if (!existing || sha256(existing) !== activation.a0Digest)
							throw fetchError;
						selectedBytes = existing;
						source = "pre-m0-lkg";
					} else {
						if (!activation.fallback) throw fetchError;
						selectedPin = activation.fallback;
						const fallbackPath = join(
							deps.stateRoot,
							"blobs",
							`${activation.fallback.personaBlobDigest}.md`,
						);
						selectedBytes = safeReadPersona(fallbackPath);
						if (sha256(selectedBytes) !== activation.fallback.personaBlobDigest)
							throw new Error("persona_fallback_digest_mismatch");
						source = "post-m0-fallback";
					}
				}
				const after = await readActivation();
				if (!authorityMatches(activation, after))
					throw new Error("persona_activation_changed");
				const afterSelector = deps.readSelector
					? await deps.readSelector()
					: selector;
				if (
					afterSelector.projectsDigest !== selector.projectsDigest ||
					afterSelector.personaProjectionContractDigest !==
						selector.personaProjectionContractDigest
				)
					throw new Error("persona_registry_changed");
				const changed = installPersona(
					location.target,
					location.parent,
					location.parentIdentity,
					selectedBytes,
				);
				return {
					status,
					source,
					personaBlobDigest: selectedPin.personaBlobDigest,
					commit: selectedPin.commit,
					contractDigest: selector.personaProjectionContractDigest!,
					activationRevision: activation.revision,
					changed,
				};
			},
			{ timeoutMs: 30_000 },
		);
	} catch (error) {
		return {
			status: "refused",
			reason:
				error instanceof Error ? error.message : "persona_projection_failed",
		};
	}
}
