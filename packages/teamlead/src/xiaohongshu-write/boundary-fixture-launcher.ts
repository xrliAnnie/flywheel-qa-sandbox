import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { probeFileControl } from "./boundary-file-control.js";
import { loadBoundaryFixture } from "./boundary-file-probe.js";
import { runSyntheticAuthorityCase } from "./boundary-fixture-flow.js";
import { readImmutableFile } from "./trusted-files.js";

/** One-shot fixture execution only. No production startup/acceptance bypass,
 * external endpoints, operator-selected command or signing key is available.
 * Failed and successful runs are retained for the independent installer. */
export async function runBoundaryFixtureHarness(root: string) {
	try {
		const fixture = loadBoundaryFixture(root);
		if (!process.getuid || process.getuid() !== fixture.serviceUid)
			throw Error();
		const controlBefore = probeFileControl(root);
		const helperPath = join(root, "peer-helper");
		const helper = readImmutableFile(helperPath, {
			maxBytes: 1024 * 1024,
			executable: true,
		});
		const peerHelper = {
			path: helperPath,
			sha256: createHash("sha256").update(helper).digest("hex"),
		};
		const runtime = join(root, "runtime"),
			before = lstatSync(runtime);
		const io = join(root, "io"),
			ioBefore = lstatSync(io),
			socketPath = join(io, "i");
		if (
			!ioBefore.isDirectory() ||
			ioBefore.uid !== fixture.serviceUid ||
			(ioBefore.mode & 0o7777) !== 0o700 ||
			readdirSync(io).length ||
			Buffer.byteLength(socketPath) > 103
		)
			throw Error();
		if (
			!before.isDirectory() ||
			before.uid !== fixture.serviceUid ||
			(before.mode & 0o7777) !== 0o700 ||
			readdirSync(runtime).length !== 0
		)
			throw Error();
		const current = () => {
			if (JSON.stringify(loadBoundaryFixture(root)) !== JSON.stringify(fixture))
				throw Error();
			const now = lstatSync(runtime);
			const ioNow = lstatSync(io);
			if (
				!ioNow.isDirectory() ||
				ioNow.dev !== ioBefore.dev ||
				ioNow.ino !== ioBefore.ino ||
				ioNow.mode !== ioBefore.mode ||
				ioNow.uid !== ioBefore.uid ||
				readdirSync(io).length
			)
				throw Error();
			if (
				!now.isDirectory() ||
				now.dev !== before.dev ||
				now.ino !== before.ino ||
				now.uid !== before.uid ||
				now.mode !== before.mode
			)
				throw Error();
			readImmutableFile(helperPath, {
				maxBytes: 1024 * 1024,
				executable: true,
				sha256: peerHelper.sha256,
			});
		};
		const run = join(runtime, "run-once");
		mkdirSync(run, { mode: 0o700 }); // Exclusive admission; no age/retry recovery.
		const marker = openSync(
			join(run, "run.json"),
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const bytes = Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					nonce: fixture.nonce,
					uid: process.getuid(),
					pid: process.pid,
					helperSha256: peerHelper.sha256,
				}),
			);
			if (writeSync(marker, bytes) !== bytes.length) throw Error();
			fsyncSync(marker);
		} finally {
			closeSync(marker);
		}
		for (const path of [run, runtime]) {
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const opened = fstatSync(fd),
					named = lstatSync(path);
				if (
					!opened.isDirectory() ||
					opened.dev !== named.dev ||
					opened.ino !== named.ino
				)
					throw Error();
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		current();
		const scenarios = [];
		for (let index = 0; index < 8; index++) {
			current();
			const path = join(run, `case-${index}`);
			mkdirSync(path, { mode: 0o700 });
			scenarios.push(
				await runSyntheticAuthorityCase(path, peerHelper, index, socketPath),
			);
		}
		current();
		const controlAfter = probeFileControl(root);
		if (JSON.stringify(controlBefore) !== JSON.stringify(controlAfter))
			throw Error();
		return {
			schemaVersion: 1,
			probeKind: "fixture_harness",
			probe: "authority-flow",
			nonce: fixture.nonce,
			uid: process.getuid(),
			helperSha256: peerHelper.sha256,
			controlBefore,
			controlAfter,
			scenarios,
		};
	} catch {
		throw Error("boundary_fixture_harness_unavailable");
	}
}
