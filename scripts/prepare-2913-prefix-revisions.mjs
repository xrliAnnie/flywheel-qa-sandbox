#!/usr/bin/env node
// FLY-2913 C3: offline candidates only. Publication remains a separate,
// authorized workflow-template publish operation with the saved CAS evidence.
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalSubmissionDigest } from "../packages/config/dist/canonical-json.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const PREFIX_NODE_TYPES = new Set(["design", "implement", "qa"]);
const NODE_TYPES = new Set([
	...PREFIX_NODE_TYPES,
	"gate",
	"land",
	"generic",
	"review",
]);
const USAGE = `Usage: node scripts/prepare-2913-prefix-revisions.mjs --code <savedGET.json> --simple-code <savedGET.json> --out-dir <new-directory>

Read saved GET /api/workflow/templates/tpl_code and /tpl_simple_code responses
(regular JSON files, at most 1 MiB each). Verify current revision and canonical
manifest digest, then copy complete manifests and add role-v1 node profiles.
Requires built flywheel-config (pnpm --filter flywheel-config build).

The output directory must not exist; its parent must exist. Writes private
tpl_code.role-v1.json, tpl_simple_code.role-v1.json and before.json (CAS revision,
original digest, source file SHA-256, and candidate digest). Inputs stay intact.
This is offline preparation: no seed, database, network, or publish operations.
Publication revalidates the complete manifest through the existing managed API.
`;

const isObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const positiveRevision = (value) => Number.isSafeInteger(value) && value > 0;

function readSavedResponse(path) {
	// O_NONBLOCK avoids hanging on a FIFO before fstat rejects non-files.
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	let bytes;
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error("input must be a regular file");
		if (info.size > MAX_INPUT_BYTES)
			throw new Error("input exceeds 1 MiB (1048576 bytes)");
		const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > MAX_INPUT_BYTES)
			throw new Error("input exceeds 1 MiB (1048576 bytes)");
		bytes = buffer.subarray(0, length);
	} finally {
		closeSync(fd);
	}
	let response;
	try {
		response = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
	} catch {
		throw new Error("invalid JSON input (expected UTF-8 saved GET response)");
	}
	return {
		response,
		sourceSha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function prepareCandidate(path, templateId) {
	const { response, sourceSha256 } = readSavedResponse(path);
	if (!isObject(response) || response.ok !== true)
		throw new Error("saved GET must have ok: true");
	const { template, current_revision: revision } = response;
	if (!isObject(template) || template.template_id !== templateId)
		throw new Error(`expected template ${templateId}`);
	if (!isObject(revision)) throw new Error("current_revision is required");
	if (revision.template_id !== templateId)
		throw new Error("current revision template ID mismatch");
	if (
		!positiveRevision(template.current_published_revision) ||
		!positiveRevision(revision.revision)
	)
		throw new Error("current revision must be a positive safe integer");
	if (template.current_published_revision !== revision.revision)
		throw new Error("current revision mismatch");
	const original = revision.manifest;
	if (!isObject(original)) throw new Error("manifest must be an object");
	if (
		typeof revision.manifest_digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(revision.manifest_digest)
	)
		throw new Error("invalid manifest digest");
	if (canonicalSubmissionDigest(original) !== revision.manifest_digest)
		throw new Error("manifest digest mismatch");
	if (![1, 2, 3].includes(original.schema_version))
		throw new Error("unsupported manifest schema_version");
	if (
		revision.schema_version !== undefined &&
		revision.schema_version !== original.schema_version
	)
		throw new Error("revision schema_version mismatch");
	if (!Array.isArray(original.nodes) || original.nodes.length === 0)
		throw new Error("manifest nodes must be a non-empty array");
	if (!Array.isArray(original.edges) || !Array.isArray(original.loops))
		throw new Error("manifest edges and loops must be arrays");
	const candidate = structuredClone(original);
	const nodeIds = new Set();
	let selected = 0;
	for (const node of candidate.nodes) {
		if (
			!isObject(node) ||
			typeof node.id !== "string" ||
			!node.id.trim() ||
			nodeIds.has(node.id) ||
			!NODE_TYPES.has(node.type)
		)
			throw new Error("invalid manifest node identity or type");
		nodeIds.add(node.id);
		for (const key of ["prefix_profile", "review_prefix_profile"]) {
			if (
				Object.hasOwn(node, key) &&
				(!PREFIX_NODE_TYPES.has(node.type) ||
					!["legacy", "role-v1"].includes(node[key]))
			)
				throw new Error(`invalid node ${key}`);
		}
		if (!PREFIX_NODE_TYPES.has(node.type)) continue;
		node.prefix_profile = "role-v1";
		// QA can author an existing code review: /review-requests and
		// ReviewRequestCoordinator.accept gate vendor/session/worktree/review
		// identity, not author phase. A Codex override can therefore consume this
		// field without granting any new review route or authority.
		node.review_prefix_profile = "role-v1";
		selected += 1;
	}
	if (selected === 0)
		throw new Error("manifest has no design/implement/qa nodes");
	const filename = `${templateId}.role-v1.json`;
	return {
		filename,
		candidate,
		before: {
			template_id: templateId,
			current_published_revision: revision.revision,
			manifest_digest: revision.manifest_digest,
			source_sha256: sourceSha256,
			candidate_file: filename,
			candidate_manifest_digest: canonicalSubmissionDigest(candidate),
		},
	};
}

function main(args) {
	if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
		process.stdout.write(USAGE);
		return;
	}
	const options = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		if (
			!["--code", "--simple-code", "--out-dir"].includes(key) ||
			options.has(key)
		)
			throw new Error(`unknown or duplicate option: ${key}`);
		const value = args[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`value required for ${key}`);
		options.set(key, value);
	}
	if (options.size !== 3)
		throw new Error(
			"--code, --simple-code and --out-dir are required; use --help for usage",
		);
	// Validate both sources and serialize all output before touching the directory.
	const code = prepareCandidate(options.get("--code"), "tpl_code");
	const simpleCode = prepareCandidate(
		options.get("--simple-code"),
		"tpl_simple_code",
	);
	const before = {
		schema_version: 1,
		templates: { tpl_code: code.before, tpl_simple_code: simpleCode.before },
	};
	const outputs = [
		[code.filename, code.candidate],
		[simpleCode.filename, simpleCode.candidate],
		["before.json", before],
	].map(([filename, value]) => [
		filename,
		`${JSON.stringify(value, null, 2)}\n`,
	]);
	const outDir = resolve(options.get("--out-dir"));
	try {
		mkdirSync(outDir, { mode: 0o700 });
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				"output directory already exists; choose a fresh output directory",
			);
		throw error;
	}
	const created = [];
	try {
		for (const [filename, content] of outputs) {
			const outputPath = join(outDir, filename);
			const fd = openSync(outputPath, "wx", 0o600);
			created.push(outputPath);
			try {
				writeFileSync(fd, content);
			} finally {
				closeSync(fd);
			}
		}
	} catch (error) {
		for (const path of created) unlinkSync(path);
		rmdirSync(outDir);
		throw error;
	}
	process.stdout.write(
		`${JSON.stringify({ ok: true, out_dir: outDir, files: outputs.map(([name]) => name) })}\n`,
	);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`prepare-2913-prefix-revisions: ${error.message}\n`);
	process.exitCode = 1;
}
