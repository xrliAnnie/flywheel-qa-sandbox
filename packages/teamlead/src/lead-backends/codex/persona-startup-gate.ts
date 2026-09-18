import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withSyncOpMarker } from "flywheel-claude-runner";
import {
	compileLeadIdentityRows,
	type IdentityProjectRow,
} from "flywheel-comm/lead-identity";
import { getProcessStart } from "flywheel-comm/lead-lease";
import {
	type PersonaActivationView,
	readPersonaActivation,
} from "flywheel-comm/persona-activation-client";
import { canonicalSubmissionDigest, type PersonaPin } from "flywheel-config";

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PERSONA_BYTES = 256 * 1024;
const MAX_COLD_PROOF_BYTES = 16 * 1024;

export interface VerifiedPersona {
	personaBlobDigest: string;
	baseInstructionsDigest: string;
	baseInstructions: string;
	contractDigest: string;
	activationRevision: string;
	source: "target" | "pre-m0-lkg" | "post-m0-fallback";
}

export interface PersonaStartupGateInput {
	projectName: string;
	leadId: string;
	projectsPath: string;
	expectedProjectsDigest: string;
	projectRoot: string;
	stateRoot: string;
	systemPromptFiles: readonly string[];
	capabilityBundleVersion?: 2;
	bridgeUrl: string;
	bridgeToken: string;
}

export interface PersonaStartupGateDeps {
	readActivation?: () => Promise<PersonaActivationView>;
	readRegistry?: () => { raw: Buffer; project: IdentityProjectRow };
}

function sha256(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeRead(
	path: string,
	maxBytes: number,
	mode: "registry" | "persona" | "proof",
): Buffer {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.isSymbolicLink())
			throw new Error(`${mode}_not_regular`);
		if (before.size < 1 || before.size > maxBytes)
			throw new Error(`${mode}_size_invalid`);
		if (
			mode !== "registry" &&
			(before.nlink !== 1 || (before.mode & 0o077) !== 0)
		) {
			throw new Error(
				before.nlink !== 1
					? "persona_hardlink_refused"
					: "persona_mode_invalid",
			);
		}
		const data = readFileSync(fd);
		const after = fstatSync(fd);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			data.length !== before.size
		)
			throw new Error(`${mode}_changed_during_read`);
		return data;
	} finally {
		closeSync(fd);
	}
}

function assertNoEnrollmentMarkers(stateRoot: string): void {
	for (const marker of ["enrollment.json", "activation.json"] as const) {
		try {
			lstatSync(join(stateRoot, marker));
			throw new Error("enrolled_contract_missing");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function assertNoSymlinkParents(root: string, file: string): void {
	const canonicalRoot = realpathSync.native(root);
	if (canonicalRoot !== resolve(root))
		throw new Error("persona_workspace_not_canonical");
	let cursor = dirname(file);
	for (;;) {
		const stat = lstatSync(cursor);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("persona_parent_unsafe");
		if (cursor === canonicalRoot) break;
		const parent = dirname(cursor);
		if (parent === cursor || !cursor.startsWith(`${canonicalRoot}/`))
			throw new Error("persona_path_escape");
		cursor = parent;
	}
}

function loadRegistry(input: PersonaStartupGateInput): {
	raw: Buffer;
	project: IdentityProjectRow;
} {
	const raw = safeRead(input.projectsPath, MAX_REGISTRY_BYTES, "registry");
	const projectsDigest = sha256(raw);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch {
		throw new Error("persona_registry_json_invalid");
	}
	const rows = compileLeadIdentityRows(parsed, {
		projectsDigest,
		homeDir: dirname(dirname(input.projectsPath)),
	});
	const matches = rows.filter(
		(row) =>
			row.identity.projectName === input.projectName &&
			row.identity.leadId === input.leadId,
	);
	if (matches.length !== 1)
		throw new Error("persona_registry_identity_missing");
	const project = matches[0]!.project;
	if (
		projectsDigest !== input.expectedProjectsDigest &&
		(project.personaProjection || project.invalidPersonaProjection)
	) {
		throw new Error("persona_projects_digest_changed");
	}
	return { raw, project };
}

function samePin(left: PersonaPin, right: PersonaPin): boolean {
	return canonicalSubmissionDigest(left) === canonicalSubmissionDigest(right);
}

export function stripPersonaFrontmatter(value: string): string {
	return value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export async function verifyPersonaStartup(
	input: PersonaStartupGateInput,
	deps: PersonaStartupGateDeps = {},
): Promise<VerifiedPersona | null> {
	if (input.projectName !== "raya" || input.leadId !== "raya") return null;
	const first = (deps.readRegistry ?? (() => loadRegistry(input)))();
	const project = first.project;
	if (project.invalidPersonaProjection)
		throw new Error(
			`persona_contract_invalid:${project.invalidPersonaProjection}`,
		);
	const contract = project.personaProjection;
	const contractDigest = project.personaProjectionContractDigest;
	if (!contract || !contractDigest) {
		assertNoEnrollmentMarkers(input.stateRoot);
		return null;
	}
	if (input.capabilityBundleVersion === 2)
		throw new Error("persona_capability_v2_refused");
	const lead = project.leads.find((row) => row.agentId === "raya");
	if (
		project.projectRepo !== "xrliAnnie/raya" ||
		typeof project.projectRoot !== "string" ||
		lead?.backend !== "codex-app-server" ||
		lead.codexProfile !== "full-access" ||
		lead.codexCapabilityBundleVersion === 2
	)
		throw new Error("persona_runtime_identity_invalid");
	const canonicalRoot = realpathSync.native(input.projectRoot);
	if (
		canonicalRoot !== resolve(input.projectRoot) ||
		canonicalRoot !== realpathSync.native(project.projectRoot)
	) {
		throw new Error("persona_workspace_identity_mismatch");
	}
	const expectedPath = join(canonicalRoot, contract.path);
	if (
		input.systemPromptFiles.length !== 1 ||
		input.systemPromptFiles[0] !== expectedPath
	) {
		throw new Error("persona_prompt_path_invalid");
	}
	const readActivation =
		deps.readActivation ??
		(() =>
			readPersonaActivation({
				baseUrl: input.bridgeUrl,
				token: input.bridgeToken,
				projectName: "raya",
				leadId: "raya",
			}));
	const activation = await readActivation();
	if (activation.kind !== "pre-m0" && activation.kind !== "post-m0") {
		throw new Error(
			activation.kind === "refused"
				? activation.reason
				: `persona_activation_${activation.kind}`,
		);
	}
	if (activation.contractDigest !== contractDigest)
		throw new Error("persona_contract_digest_changed");
	if (
		activation.kind === "pre-m0" &&
		(!samePin(contract.pin, contract.lastKnownGood) ||
			contract.pin.personaBlobDigest !== activation.a0Digest)
	)
		throw new Error("persona_pre_m0_pin_invalid");
	if (
		activation.kind === "post-m0" &&
		!samePin(contract.pin, activation.expected)
	) {
		throw new Error("persona_post_m0_pin_invalid");
	}
	assertNoSymlinkParents(canonicalRoot, expectedPath);
	const raw = safeRead(expectedPath, MAX_PERSONA_BYTES, "persona");
	const rawDigest = sha256(raw);
	let source: VerifiedPersona["source"];
	let selected: PersonaPin;
	if (activation.kind === "pre-m0") {
		if (rawDigest !== activation.a0Digest)
			throw new Error("persona_pre_m0_digest_mismatch");
		source = "pre-m0-lkg";
		selected = contract.lastKnownGood;
	} else if (rawDigest === activation.expected.personaBlobDigest) {
		source = "target";
		selected = activation.expected;
	} else if (
		activation.fallback &&
		rawDigest === activation.fallback.personaBlobDigest
	) {
		source = "post-m0-fallback";
		selected = activation.fallback;
	} else {
		throw new Error("persona_post_m0_digest_mismatch");
	}
	if (selected.personaBlobDigest !== rawDigest)
		throw new Error("persona_selected_digest_mismatch");
	const decoded = raw.toString("utf8");
	if (!Buffer.from(decoded, "utf8").equals(raw))
		throw new Error("persona_utf8_invalid");
	const baseInstructions = stripPersonaFrontmatter(decoded).trim();
	if (!baseInstructions) throw new Error("persona_instructions_empty");
	const afterActivation = await readActivation();
	const afterRegistry = (deps.readRegistry ?? (() => loadRegistry(input)))();
	if (
		canonicalSubmissionDigest(afterActivation) !==
			canonicalSubmissionDigest(activation) ||
		sha256(afterRegistry.raw) !== sha256(first.raw) ||
		afterRegistry.project.personaProjectionContractDigest !== contractDigest
	)
		throw new Error("persona_authority_changed");
	return {
		personaBlobDigest: rawDigest,
		baseInstructionsDigest: sha256(baseInstructions),
		baseInstructions,
		contractDigest,
		activationRevision: activation.revision,
		source,
	};
}

export async function assertPersonaNotHeadless(
	input: Omit<
		PersonaStartupGateInput,
		"systemPromptFiles" | "bridgeUrl" | "bridgeToken"
	>,
	deps: Pick<PersonaStartupGateDeps, "readRegistry"> = {},
): Promise<void> {
	if (input.projectName !== "raya" || input.leadId !== "raya") return;
	const current = (
		deps.readRegistry ??
		(() =>
			loadRegistry({
				...input,
				systemPromptFiles: [],
				bridgeUrl: "",
				bridgeToken: "",
			}))
	)();
	if (
		current.project.personaProjection ||
		current.project.invalidPersonaProjection
	) {
		throw new Error("persona_headless_runtime_refused");
	}
	assertNoEnrollmentMarkers(input.stateRoot);
}

export interface PersonaColdProof {
	schemaVersion: 1;
	generationId: string;
	pid: number;
	processStartTime: string;
	socketPath: string;
	createdAt: string;
}

export function personaColdProofPath(codexHome: string): string {
	return join(codexHome, ".flywheel-raya-persona-cold-proof.json");
}

export function verifyPersonaColdProof(
	input: {
		codexHome: string;
		generationId: string;
	},
	deps: {
		getStart?: (pid: number) => string;
		lstat?: typeof lstatSync;
	} = {},
): PersonaColdProof {
	if (!/^[a-f0-9]{32}$/.test(input.generationId))
		throw new Error("persona_cold_generation_invalid");
	const proofPath = personaColdProofPath(input.codexHome);
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			safeRead(proofPath, MAX_COLD_PROOF_BYTES, "proof").toString("utf8"),
		);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error("persona_cold_proof_json_invalid");
		throw error;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("persona_cold_proof_invalid");
	}
	const proof = parsed as Partial<PersonaColdProof>;
	const expectedSocket = join(
		input.codexHome,
		"app-server-control",
		"app-server-control.sock",
	);
	if (
		proof.schemaVersion !== 1 ||
		proof.generationId !== input.generationId ||
		!Number.isSafeInteger(proof.pid) ||
		(proof.pid ?? 0) <= 1 ||
		typeof proof.processStartTime !== "string" ||
		!proof.processStartTime ||
		/[\r\n\t]/.test(proof.processStartTime) ||
		proof.socketPath !== expectedSocket ||
		typeof proof.createdAt !== "string" ||
		!Number.isFinite(Date.parse(proof.createdAt))
	)
		throw new Error("persona_cold_proof_invalid");
	const stat = (deps.lstat ?? lstatSync)(expectedSocket);
	if (!stat.isSocket() || stat.isSymbolicLink())
		throw new Error("persona_cold_socket_invalid");
	const currentStart = (
		deps.getStart ??
		((pid: number) =>
			withSyncOpMarker("raya-persona-cold-proof:process-start", () =>
				getProcessStart(pid),
			))
	)(proof.pid!);
	if (currentStart !== proof.processStartTime)
		throw new Error("persona_cold_process_changed");
	return proof as PersonaColdProof;
}

export interface PersonaObservationReceipt extends VerifiedPersona {
	schemaVersion: 1;
	stage: "verified" | "ready";
	generationId: string;
	pid: number;
	processStartTime: string;
	leadKey: string;
	threadId: string;
	threadRpcAckAt: string;
}

function throwObservationWriteFailures(errors: unknown[]): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "persona_observation_cleanup_failed");
}

export function writePersonaObservationReceipt(
	stateRoot: string,
	receipt: PersonaObservationReceipt,
): void {
	const root = realpathSync.native(stateRoot);
	if (root !== resolve(stateRoot))
		throw new Error("persona_observation_root_unsafe");
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
		throw new Error("persona_observation_root_unsafe");
	if (
		receipt.schemaVersion !== 1 ||
		(receipt.stage !== "verified" && receipt.stage !== "ready") ||
		!/^[a-f0-9]{32}$/.test(receipt.generationId) ||
		!Number.isSafeInteger(receipt.pid) ||
		receipt.pid <= 1 ||
		!receipt.processStartTime ||
		/[\r\n\t]/.test(receipt.processStartTime) ||
		!receipt.leadKey ||
		!receipt.threadId ||
		!Number.isFinite(Date.parse(receipt.threadRpcAckAt))
	)
		throw new Error("persona_observation_invalid");
	const target = join(root, "observation.json");
	const temporary = join(root, `.observation-${randomUUID()}.tmp`);
	let fd: number | undefined;
	const errors: unknown[] = [];
	try {
		fd = openSync(
			temporary,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, target);
		const directory = openSync(root, constants.O_RDONLY);
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
		const readback = safeRead(target, MAX_COLD_PROOF_BYTES, "proof");
		if (
			canonicalSubmissionDigest(JSON.parse(readback.toString("utf8"))) !==
			canonicalSubmissionDigest(receipt)
		) {
			throw new Error("persona_observation_readback_mismatch");
		}
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
		unlinkSync(temporary);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
	}
	throwObservationWriteFailures(errors);
}
