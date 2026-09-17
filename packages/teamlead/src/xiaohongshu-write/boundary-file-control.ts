import { createHash } from "node:crypto";
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { loadBoundaryFixture } from "./boundary-file-probe.js";
import { readImmutableFile, readPrivateFile } from "./trusted-files.js";

const privateNames = [
	"permit.synthetic",
	"cookie.synthetic",
	"ledger.synthetic",
] as const;
const immutableNames = ["policy.synthetic", "binary.synthetic"] as const;
function identity(stat: Stats) {
	return {
		dev: stat.dev,
		ino: stat.ino,
		uid: stat.uid,
		gid: stat.gid,
		mode: stat.mode,
		nlink: stat.nlink,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
	};
}
/** Positive control runs under the real dedicated UID. It reads only a fixed
 * nonsecret sentinel format inside the root-installed synthetic fixture. Root
 * must execute this before AND after denial probes and compare measurements;
 * stdout is not a signature and must never be accepted from the model. */
export function probeFileControl(root: string) {
	try {
		const fixture = loadBoundaryFixture(root);
		if (!process.getuid || process.getuid() !== fixture.serviceUid)
			throw Error();
		const state = join(root, "state"),
			artifacts = join(state, "artifacts");
		const current = () => {
			if (JSON.stringify(loadBoundaryFixture(root)) !== JSON.stringify(fixture))
				throw Error();
			const names = readdirSync(state).sort();
			if (
				JSON.stringify(names) !==
				JSON.stringify([...privateNames, "artifacts"].sort())
			)
				throw Error();
		};
		current();
		const artifactStat = lstatSync(artifacts);
		if (
			!artifactStat.isDirectory() ||
			artifactStat.uid !== fixture.serviceUid ||
			(artifactStat.mode & 0o7777) !== 0o700 ||
			readdirSync(artifacts).length !== 0
		)
			throw Error();
		const files = [...privateNames, ...immutableNames].map((name) => {
			current();
			const privateFile = (privateNames as readonly string[]).includes(name);
			const path = join(privateFile ? state : root, name);
			const before = identity(lstatSync(path));
			const bytes = privateFile
				? readPrivateFile(path, {
						root: state,
						uid: fixture.serviceUid,
						maxBytes: 256,
					})
				: readImmutableFile(path, { maxBytes: 256 });
			try {
				const expected = Buffer.from(
					`flywheel:xhs:synthetic:${name}:${fixture.nonce}\n`,
				);
				if (
					!bytes.equals(expected) ||
					JSON.stringify(before) !== JSON.stringify(identity(lstatSync(path)))
				)
					throw Error();
				return {
					name,
					...before,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			} finally {
				bytes.fill(0);
			}
		});
		current();
		if (
			JSON.stringify(identity(artifactStat)) !==
				JSON.stringify(identity(lstatSync(artifacts))) ||
			readdirSync(artifacts).length !== 0
		)
			throw Error();
		return {
			schemaVersion: 1,
			probeKind: "fixture_harness",
			probe: "file-control",
			nonce: fixture.nonce,
			uid: process.getuid(),
			fixture: {
				markerSha256: fixture.markerSha256,
				state: fixture.stateIdentity,
			},
			artifacts: identity(artifactStat),
			files,
		};
	} catch {
		throw Error("boundary_file_control_unavailable");
	}
}
