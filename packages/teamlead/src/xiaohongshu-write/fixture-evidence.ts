import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, parseStrictJson } from "./canonical.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const binding = z
	.object({
		markerSha256: digest,
		state: z.object({ dev: integer, ino: integer }).strict(),
	})
	.strict();
const expectedSchema = z
	.object({
		nonce: digest,
		serviceUid: integer.min(1),
		serviceGid: integer.min(1),
		modelUid: integer.min(1),
		helperSha256: digest,
		fixture: binding,
	})
	.strict();
const metadata = z
	.object({
		dev: integer,
		ino: integer,
		uid: integer,
		gid: integer,
		mode: integer,
		nlink: integer.min(1),
		size: integer,
		mtimeMs: z.number().finite(),
		ctimeMs: z.number().finite(),
	})
	.strict();
const common = {
	schemaVersion: z.literal(1),
	probeKind: z.literal("fixture_harness"),
	nonce: digest,
	uid: integer.min(1),
};
const fileNames = [
	"permit.synthetic",
	"cookie.synthetic",
	"ledger.synthetic",
	"policy.synthetic",
	"binary.synthetic",
] as const;
const controlSchema = z
	.object({
		...common,
		probe: z.literal("file-control"),
		fixture: binding,
		artifacts: metadata,
		files: z
			.array(
				metadata.extend({ name: z.enum(fileNames), sha256: digest }).strict(),
			)
			.length(5),
	})
	.strict();
const operations = [
	"key_read",
	"cookie_read",
	"ledger_read",
	"ledger_write",
	"store_rename",
	"store_symlink",
	"policy_write",
	"binary_write",
] as const;
const denialSchema = z
	.object({
		...common,
		probe: z.literal("file-authority"),
		fixture: binding,
		observations: z
			.array(
				z
					.object({
						operation: z.enum(operations),
						denied: z.literal(true),
						errno: z.enum(["EACCES", "EPERM"]),
					})
					.strict(),
			)
			.length(8),
	})
	.strict();
const scenarioOperations = [
	"xiaohongshu.like_feed",
	"xiaohongshu.like_feed",
	"xiaohongshu.favorite_feed",
	"xiaohongshu.favorite_feed",
	"xiaohongshu.post_comment_to_feed",
	"xiaohongshu.reply_comment_in_feed",
	"xiaohongshu.publish_content",
	"xiaohongshu.publish_with_video",
] as const;
const flowSchema = z
	.object({
		...common,
		probe: z.literal("authority-flow"),
		helperSha256: digest,
		controlBefore: controlSchema,
		controlAfter: controlSchema,
		scenarios: z
			.array(
				z
					.object({
						probeKind: z.literal("fixture_harness"),
						caseIndex: integer,
						operation: z.enum(scenarioOperations),
						commits: z.literal(1),
						replayedCommits: z.literal(1),
						negativeCommits: z
							.object({
								missingReceipt: z.literal(0),
								forgedIngress: z.literal(0),
								wrongFounder: z.literal(0),
								digestMismatch: z.literal(0),
							})
							.strict(),
						uid: integer.min(1),
					})
					.strict(),
			)
			.length(8),
	})
	.strict();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** This collector is not an approval/acceptance API. The root installer supplies
 * pinned identity and executes its own child callback; it never accepts uploaded
 * probe JSON. Complete fixture evidence still supplies NO host acceptance. */
export async function collectFixtureEvidence(
	input: z.infer<typeof expectedSchema>,
	run: (
		role: "service" | "model",
		probe: "file-control" | "file-authority" | "authority-flow",
	) => Promise<string>,
) {
	try {
		const expected = expectedSchema.parse(input);
		if (expected.serviceUid === expected.modelUid || expected.serviceGid === 80)
			throw Error();
		const parse = (raw: string) => {
			if (Buffer.byteLength(raw) > 128 * 1024) throw Error();
			return parseStrictJson(raw);
		};
		const checkControl = (raw: unknown) => {
			const result = controlSchema.parse(raw);
			if (
				result.nonce !== expected.nonce ||
				result.uid !== expected.serviceUid ||
				canonical(result.fixture) !== canonical(expected.fixture)
			)
				throw Error();
			const directory = result.artifacts;
			if (
				directory.uid !== expected.serviceUid ||
				directory.gid !== expected.serviceGid ||
				directory.mode !== 0o40700
			)
				throw Error();
			if (new Set(result.files.map((file) => file.name)).size !== 5)
				throw Error();
			for (const file of result.files) {
				const privateFile = fileNames.indexOf(file.name) < 3;
				const bytes = `flywheel:xhs:synthetic:${file.name}:${expected.nonce}\n`;
				if (
					file.sha256 !== sha(bytes) ||
					file.size !== Buffer.byteLength(bytes) ||
					file.nlink !== 1 ||
					file.uid !== (privateFile ? expected.serviceUid : 0) ||
					file.gid !== (privateFile ? expected.serviceGid : 0) ||
					(privateFile
						? file.mode !== 0o100600
						: ![0o100644, 0o100555].includes(file.mode))
				)
					throw Error();
			}
			return result;
		};
		const before = checkControl(parse(await run("service", "file-control")));
		const denial = denialSchema.parse(
			parse(await run("model", "file-authority")),
		);
		if (
			denial.uid !== expected.modelUid ||
			denial.nonce !== expected.nonce ||
			canonical(denial.fixture) !== canonical(before.fixture) ||
			new Set(denial.observations.map((row) => row.operation)).size !== 8
		)
			throw Error();
		const after = checkControl(parse(await run("service", "file-control")));
		if (canonical(before) !== canonical(after)) throw Error();
		const flow = flowSchema.parse(
			parse(await run("service", "authority-flow")),
		);
		if (
			flow.nonce !== expected.nonce ||
			flow.uid !== expected.serviceUid ||
			flow.helperSha256 !== expected.helperSha256 ||
			canonical(checkControl(flow.controlBefore)) !== canonical(before) ||
			canonical(checkControl(flow.controlAfter)) !== canonical(before)
		)
			throw Error();
		for (const [index, scenario] of flow.scenarios.entries())
			if (
				scenario.caseIndex !== index ||
				scenario.operation !== scenarioOperations[index] ||
				scenario.uid !== expected.serviceUid
			)
				throw Error();
		const evidence = { before, denial, after, flow };
		return {
			schemaVersion: 1,
			probeKind: "fixture_harness" as const,
			hostAcceptance: false as const,
			evidenceSha256: sha(canonical(evidence)),
			evidence,
		};
	} catch {
		throw Error("fixture_evidence_unavailable");
	}
}
