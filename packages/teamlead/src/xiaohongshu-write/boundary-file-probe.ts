import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	lstatSync,
	openSync,
	renameSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";
import { readImmutableFile } from "./trusted-files.js";

const markerSchema = z
	.object({
		schemaVersion: z.literal(1),
		purpose: z.literal("flywheel-xhs-synthetic-boundary"),
		nonce: z.string().regex(/^[a-f0-9]{64}$/),
		serviceUid: z.number().int().positive(),
		modelUid: z.number().int().positive(),
	})
	.strict();

/** No configurable state path, account, credential or endpoint is accepted.
 * The independently installed marker and every ancestor must be root-owned.
 * Its presence is admission to a synthetic probe, never acceptance evidence. */
export function loadBoundaryFixture(root: string) {
	try {
		if (!/^\/private\/var\/db\/flywheel-xhs-qa\/[a-f0-9]{64}$/.test(root))
			throw Error();
		const raw = readImmutableFile(join(root, "fixture.json"), {
			maxBytes: 4096,
		});
		const marker = markerSchema.parse(
			parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
		);
		if (
			root !== `/private/var/db/flywheel-xhs-qa/${marker.nonce}` ||
			marker.serviceUid === marker.modelUid
		)
			throw Error();
		const state = lstatSync(join(root, "state"));
		if (
			!state.isDirectory() ||
			state.uid !== marker.serviceUid ||
			(state.mode & 0o7777) !== 0o700
		)
			throw Error();
		return {
			...marker,
			root,
			markerSha256: createHash("sha256").update(raw).digest("hex"),
			stateIdentity: { dev: state.dev, ino: state.ino },
		};
	} catch {
		throw Error("boundary_fixture_unavailable");
	}
}

/** Runs as the actual model UID. Results are unsigned observations: a trusted
 * installer must independently establish nonempty positive fixture controls
 * and execute all other probes before considering any acceptance signature. */
export function probeFileAuthority(root: string) {
	const fixture = loadBoundaryFixture(root);
	if (
		!process.getuid ||
		process.getuid() !== fixture.modelUid ||
		process.getuid() === 0
	)
		throw Error("boundary_probe_principal_invalid");
	const state = join(root, "state");
	const open = (path: string, mode: number) => {
		const fd = openSync(
			path,
			mode | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		closeSync(fd);
	};
	const probes: Array<[string, () => void]> = [
		[
			"key_read",
			() => open(join(state, "permit.synthetic"), constants.O_RDONLY),
		],
		[
			"cookie_read",
			() => open(join(state, "cookie.synthetic"), constants.O_RDONLY),
		],
		[
			"ledger_read",
			() => open(join(state, "ledger.synthetic"), constants.O_RDONLY),
		],
		[
			"ledger_write",
			() => open(join(state, "ledger.synthetic"), constants.O_RDWR),
		],
		[
			"store_rename",
			() =>
				renameSync(
					join(state, "artifacts"),
					join(state, "artifacts-probe-moved"),
				),
		],
		[
			"store_symlink",
			() => symlinkSync("artifacts", join(state, "artifacts-probe-link")),
		],
		[
			"policy_write",
			() => open(join(root, "policy.synthetic"), constants.O_WRONLY),
		],
		[
			"binary_write",
			() => open(join(root, "binary.synthetic"), constants.O_WRONLY),
		],
	];
	const observations = probes.map(([operation, run]) => {
		// Recheck immutable fixture admission before every filesystem operation.
		if (JSON.stringify(loadBoundaryFixture(root)) !== JSON.stringify(fixture))
			throw Error("boundary_fixture_changed");
		try {
			run();
			return { operation, denied: false, errno: null };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return {
				operation,
				denied: code === "EACCES" || code === "EPERM",
				errno: code ?? "UNKNOWN",
			};
		}
	});
	return {
		schemaVersion: 1,
		probeKind: "fixture_harness",
		probe: "file-authority",
		nonce: fixture.nonce,
		uid: process.getuid(),
		fixture: {
			markerSha256: fixture.markerSha256,
			state: fixture.stateIdentity,
		},
		observations,
	};
}
