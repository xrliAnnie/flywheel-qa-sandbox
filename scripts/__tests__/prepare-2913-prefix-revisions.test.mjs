import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalSubmissionDigest } from "../../packages/config/dist/canonical-json.js";

const script = fileURLToPath(
	new URL("../prepare-2913-prefix-revisions.mjs", import.meta.url),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function manifest(schemaVersion = 3, simple = false) {
	const nodes = [
		{
			id: "custom-design",
			type: "design",
			vendor: "codex",
			model: "gpt-6-astra",
			effort: "xhigh",
			label: "Founder design",
		},
		{
			id: "custom-implement",
			type: "implement",
			vendor: "codex",
			model: "gpt-6-sol",
			effort: "high",
			handoff_pointer: { worktree: true, design_doc: true },
		},
		{
			id: "custom-qa",
			type: "qa",
			vendor: "claude",
			model: "opus",
			effort: "max",
			produces_output: true,
			output: { schema: "json_v1", max_bytes: 8192 },
		},
		{ id: "approve", type: "gate", execution: "engine", founder_review: true },
		{ id: "ship", type: "land", execution: "engine" },
	];
	if (simple) nodes.shift();
	for (const node of nodes.filter((node) =>
		["design", "implement", "qa"].includes(node.type),
	)) {
		if (schemaVersion === 3) node.handbook_ref = `handbook-${node.type}`;
		else if (schemaVersion === 2) node.role = node.type;
		else node.agent_file = `agents/${node.type}.md`;
	}
	return {
		schema_version: schemaVersion,
		...(schemaVersion === 1 ? { manifest_variant: "land_v1" } : {}),
		nodes,
		edges: nodes.slice(1).map((node, index) => ({
			id: `edge-${index}`,
			from: nodes[index].id,
			to: node.id,
			condition: [
				"design_done",
				"implement_done",
				"qa_pass",
				"founder_approved",
			][index + (simple ? 1 : 0)],
		})),
		loops: [
			{
				id: "retry",
				from: "custom-qa",
				to: "custom-implement",
				loop_when: "qa_fail",
				exit_when: "qa_pass",
				max_iterations: 7,
				on_limit: "escalate",
			},
		],
		approval_gate: { node: "approve", predicate: "founder_approved" },
		terminal_node: { node: "ship" },
		ship_claims: ["qa_passed", "founder_approved"],
		tier_presets: {
			heavy: {
				reason: "founder customization",
				nodes: { "custom-implement": { model: "gpt-6-astra", effort: "max" } },
			},
		},
	};
}

function response(templateId, schemaVersion = 3) {
	const saved = manifest(schemaVersion, templateId === "tpl_simple_code");
	return {
		ok: true,
		template: {
			template_id: templateId,
			current_published_revision: 8,
			seed_owner: "founder",
		},
		current_revision: {
			template_id: templateId,
			revision: 8,
			manifest: saved,
			manifest_digest: canonicalSubmissionDigest(saved),
			schema_version: schemaVersion,
		},
	};
}

function fixture(t, schemaVersion = 3) {
	const root = mkdtempSync(join(tmpdir(), "fly-2913-candidate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const code = join(root, "code.get.json");
	const simpleCode = join(root, "simple.get.json");
	const out = join(root, "candidates");
	const codeResponse = response("tpl_code", schemaVersion);
	const simpleResponse = response("tpl_simple_code", schemaVersion);
	writeFileSync(code, `${JSON.stringify(codeResponse, null, 2)}\n`);
	writeFileSync(simpleCode, `${JSON.stringify(simpleResponse, null, 2)}\n`);
	const run = (extra = []) =>
		spawnSync(
			process.execPath,
			[
				script,
				"--code",
				code,
				"--simple-code",
				simpleCode,
				"--out-dir",
				out,
				...extra,
			],
			{ encoding: "utf8", timeout: 5000 },
		);
	return { root, code, simpleCode, out, codeResponse, simpleResponse, run };
}

for (const version of [1, 2, 3]) {
	test(`schema ${version}: preserves the complete customized manifests and immutable before evidence`, (t) => {
		const f = fixture(t, version);
		const originalFiles = [readFileSync(f.code), readFileSync(f.simpleCode)];
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readdirSync(f.out).sort(), [
			"before.json",
			"tpl_code.role-v1.json",
			"tpl_simple_code.role-v1.json",
		]);
		const before = JSON.parse(readFileSync(join(f.out, "before.json")));
		assert.equal(before.schema_version, 1);
		for (const [index, saved] of [f.codeResponse, f.simpleResponse].entries()) {
			const id = saved.template.template_id;
			const output = join(f.out, `${id}.role-v1.json`);
			const candidate = JSON.parse(readFileSync(output));
			const expected = structuredClone(saved.current_revision.manifest);
			for (const node of expected.nodes.filter((node) =>
				["design", "implement", "qa"].includes(node.type),
			)) {
				node.prefix_profile = "role-v1";
				node.review_prefix_profile = "role-v1";
			}
			assert.deepEqual(candidate, expected);
			assert.deepEqual(before.templates[id], {
				template_id: id,
				current_published_revision: 8,
				manifest_digest: saved.current_revision.manifest_digest,
				source_sha256: sha256(originalFiles[index]),
				candidate_file: `${id}.role-v1.json`,
				candidate_manifest_digest: canonicalSubmissionDigest(candidate),
			});
			assert.equal(statSync(output).mode & 0o777, 0o600);
			assert.equal(
				saved.current_revision.manifest.nodes.some(
					(node) => "prefix_profile" in node || "review_prefix_profile" in node,
				),
				false,
			);
		}
		assert.deepEqual(readFileSync(f.code), originalFiles[0]);
		assert.deepEqual(readFileSync(f.simpleCode), originalFiles[1]);
	});
}

const invalidCases = [
	[
		"unsuccessful GET",
		(saved) => {
			saved.ok = false;
		},
		/ok.*true/i,
	],
	[
		"unknown template",
		(saved) => {
			saved.template.template_id = "tpl_generic";
		},
		/template.*tpl_code/i,
	],
	[
		"wrong revision template",
		(saved) => {
			saved.current_revision.template_id = "tpl_simple_code";
		},
		/revision.*template/i,
	],
	[
		"zero revision",
		(saved) => {
			saved.template.current_published_revision = 0;
		},
		/positive.*revision|revision.*positive/i,
	],
	[
		"fractional revision",
		(saved) => {
			saved.template.current_published_revision = 1.5;
		},
		/positive.*revision|revision.*positive/i,
	],
	[
		"revision mismatch",
		(saved) => {
			saved.current_revision.revision = 7;
		},
		/revision.*mismatch/i,
	],
	[
		"missing current revision",
		(saved) => {
			saved.current_revision = null;
		},
		/current_revision/i,
	],
	[
		"manifest encoded as string",
		(saved) => {
			saved.current_revision.manifest = JSON.stringify(
				saved.current_revision.manifest,
			);
		},
		/manifest.*object/i,
	],
	[
		"digest mismatch",
		(saved) => {
			saved.current_revision.manifest.nodes[0].effort = "low";
		},
		/digest.*mismatch/i,
	],
	[
		"invalid digest",
		(saved) => {
			saved.current_revision.manifest_digest = "oops";
		},
		/digest/i,
	],
	[
		"unknown schema",
		(saved) => {
			saved.current_revision.manifest.schema_version = 99;
		},
		/schema_version/i,
		true,
	],
	[
		"missing nodes",
		(saved) => {
			delete saved.current_revision.manifest.nodes;
		},
		/nodes/i,
		true,
	],
	[
		"invalid node",
		(saved) => {
			saved.current_revision.manifest.nodes[0] = null;
		},
		/invalid manifest node/i,
		true,
	],
	[
		"invalid profile",
		(saved) => {
			saved.current_revision.manifest.nodes[0].prefix_profile = null;
		},
		/prefix_profile/i,
		true,
	],
];
for (const [name, mutate, reason, rehash] of invalidCases) {
	test(`rejects ${name} before creating any outputs`, (t) => {
		const f = fixture(t);
		mutate(f.codeResponse);
		if (rehash)
			f.codeResponse.current_revision.manifest_digest =
				canonicalSubmissionDigest(f.codeResponse.current_revision.manifest);
		writeFileSync(f.code, JSON.stringify(f.codeResponse));
		const result = f.run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, reason);
		assert.equal(existsSync(f.out), false);
	});
}

test("rejects a bad second input without leaving the first candidate", (t) => {
	const f = fixture(t);
	writeFileSync(f.simpleCode, "{bad JSON");
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /invalid JSON/i);
	assert.equal(existsSync(f.out), false);
});

test("bounds saved GET input size to 1 MiB", (t) => {
	const f = fixture(t);
	writeFileSync(f.code, " ".repeat(1024 * 1024 + 1));
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /1048576|1 MiB/);
	assert.equal(existsSync(f.out), false);
});

test("rejects non-file input", (t) => {
	const f = fixture(t);
	rmSync(f.code);
	mkdirSync(f.code);
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /regular file/i);
	assert.equal(existsSync(f.out), false);
});

test("requires a fresh output directory and never overwrites an earlier candidate", (t) => {
	const f = fixture(t);
	assert.equal(f.run().status, 0);
	const sentinel = join(f.out, "tpl_code.role-v1.json");
	writeFileSync(sentinel, "reviewed candidate");
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /exist|fresh/i);
	assert.equal(readFileSync(sentinel, "utf8"), "reviewed candidate");
});

test("does not follow an output directory symlink", (t) => {
	const f = fixture(t);
	const target = join(f.root, "do-not-touch");
	mkdirSync(target);
	symlinkSync(target, f.out);
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/output directory.*exist|fresh output directory/i,
	);
	assert.deepEqual(readdirSync(target), []);
});

test("help is offline and missing or unknown options cannot activate anything", (t) => {
	const f = fixture(t);
	const help = spawnSync(process.execPath, [script, "--help"], {
		encoding: "utf8",
	});
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--code.*--simple-code.*--out-dir/);
	assert.match(help.stdout, /publish|offline/i);
	for (const args of [[], ["--from", "seed"], ["--code", f.code]]) {
		const result = spawnSync(process.execPath, [script, ...args], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /usage|required|unknown/i);
	}
	assert.equal(f.run(["--code", f.code]).status, 1);
	assert.equal(existsSync(f.out), false);
});
