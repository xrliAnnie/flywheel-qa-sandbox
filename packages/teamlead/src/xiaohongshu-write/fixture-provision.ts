import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { renderFixtureRunnerPolicy } from "./fixture-runner-policy.js";
import { readImmutableFile } from "./trusted-files.js";

const install = "/Library/Application Support/Flywheel/Xhs";
const fixtureParent = "/private/var/db/flywheel-xhs-qa";
type PolicyInput = Parameters<typeof renderFixtureRunnerPolicy>[0];
const helperSchema = z
	.object({
		path: z.string().startsWith(`${install}/`),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

function trustedDirectory(path: string) {
	for (let current = path; ; current = dirname(current)) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022)
			throw Error();
		if (current === dirname(current)) break;
	}
}
function syncDirectory(path: string) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isDirectory()) throw Error();
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function exclusiveFile(
	path: string,
	bytes: Buffer,
	uid: number,
	gid: number,
	mode: number,
) {
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (writeSync(fd, bytes) !== bytes.length) throw Error();
		fchownSync(fd, uid, gid);
		fchmodSync(fd, mode);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Root-installer primitive, never an RPC. Policy must come from the immutable
 * reviewed installation configuration. No production credential is read/copied.
 * Exclusive reservations and partial fixtures are retained on every failure. */
export function provisionBoundaryFixture(
	input: PolicyInput & { peerHelper: { path: string; sha256: string } },
) {
	const directories: number[] = [];
	try {
		if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw Error();
		const { peerHelper, ...policyInput } = input;
		const policy = renderFixtureRunnerPolicy(policyInput);
		const helper = helperSchema.parse(peerHelper);
		const helperBytes = readImmutableFile(helper.path, {
			sha256: helper.sha256,
			maxBytes: 1024 * 1024,
			executable: true,
		});
		trustedDirectory(install);
		trustedDirectory(fixtureParent);
		const root = join(fixtureParent, input.nonce);
		// The global native runner policy reserves the single active fixture.
		exclusiveFile(
			join(install, "fixture-runner.policy"),
			Buffer.from(policy),
			0,
			0,
			0o644,
		);
		syncDirectory(install);
		mkdirSync(root, { mode: 0o700 });
		const openDirectory = (path: string) => {
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			directories.push(fd);
			const named = lstatSync(path),
				opened = fstatSync(fd);
			if (
				!opened.isDirectory() ||
				opened.uid !== 0 ||
				opened.dev !== named.dev ||
				opened.ino !== named.ino
			)
				throw Error();
			return fd;
		};
		const rootFd = openDirectory(root);
		fchownSync(rootFd, 0, 0);
		fchmodSync(rootFd, 0o700);
		const serviceDirectory = (path: string) => {
			mkdirSync(path, { mode: 0o700 });
			const fd = openDirectory(path);
			return () => {
				fchownSync(fd, input.serviceUid, input.serviceGid);
				fchmodSync(fd, 0o700);
				fsyncSync(fd);
			};
		};
		const statePath = join(root, "state");
		const finishState = serviceDirectory(statePath);
		const finishArtifacts = serviceDirectory(join(statePath, "artifacts"));
		for (const name of [
			"permit.synthetic",
			"cookie.synthetic",
			"ledger.synthetic",
			"policy.synthetic",
			"binary.synthetic",
		]) {
			const privateFile = [
				"permit.synthetic",
				"cookie.synthetic",
				"ledger.synthetic",
			].includes(name);
			exclusiveFile(
				join(privateFile ? statePath : root, name),
				Buffer.from(`flywheel:xhs:synthetic:${name}:${input.nonce}\n`),
				privateFile ? input.serviceUid : 0,
				privateFile ? input.serviceGid : 0,
				privateFile ? 0o600 : 0o644,
			);
		}
		finishArtifacts();
		finishState();
		serviceDirectory(join(root, "runtime"))();
		serviceDirectory(join(root, "io"))();
		exclusiveFile(join(root, "peer-helper"), helperBytes, 0, 0, 0o555);
		const marker = Buffer.from(
			`${JSON.stringify({ schemaVersion: 1, purpose: "flywheel-xhs-synthetic-boundary", nonce: input.nonce, serviceUid: input.serviceUid, modelUid: input.modelUid })}\n`,
		);
		exclusiveFile(join(root, "fixture.json"), marker, 0, 0, 0o644);
		// Expose only after all contents have been persisted. No writes underneath
		// service-owned paths follow exposure to the actual service principal.
		fsyncSync(rootFd);
		fchmodSync(rootFd, 0o755);
		fsyncSync(rootFd);
		syncDirectory(fixtureParent);
		const state = lstatSync(statePath);
		return {
			root,
			markerSha256: createHash("sha256").update(marker).digest("hex"),
			state: { dev: state.dev, ino: state.ino },
		};
	} catch {
		throw Error("fixture_provision_unavailable");
	} finally {
		for (const fd of directories.reverse()) closeSync(fd);
	}
}

/** Stores observations only; this file is never an acceptance signature. */
export function persistFixtureObservations(nonce: string, raw: string): string {
	try {
		if (
			process.getuid?.() !== 0 ||
			process.geteuid?.() !== 0 ||
			!/^[a-f0-9]{64}$/.test(nonce) ||
			Buffer.byteLength(raw) < 1 ||
			Buffer.byteLength(raw) > 512 * 1024
		)
			throw Error();
		const root = join(fixtureParent, nonce);
		trustedDirectory(root);
		exclusiveFile(
			join(root, "fixture-evidence.json"),
			Buffer.from(raw),
			0,
			0,
			0o600,
		);
		syncDirectory(root);
		return createHash("sha256").update(raw).digest("hex");
	} catch {
		throw Error("fixture_evidence_persist_unavailable");
	}
}

/** Internal root-installer output primitive. The caller signs directly collected
 * evidence; no service/ingress endpoint exposes this operation. Existing or
 * partially written receipts are retained and never overwritten. */
export function persistFixtureSignature(path: string, raw: string): string {
	try {
		if (
			process.getuid?.() !== 0 ||
			process.geteuid?.() !== 0 ||
			![
				`${install}/acceptance.json`,
				`${install}/provider-acceptance.json`,
			].includes(path) ||
			Buffer.byteLength(raw) < 1 ||
			Buffer.byteLength(raw) > 4096
		)
			throw Error();
		trustedDirectory(install);
		exclusiveFile(path, Buffer.from(raw), 0, 0, 0o644);
		syncDirectory(install);
		return createHash("sha256").update(raw).digest("hex");
	} catch {
		throw Error("fixture_signature_persist_unavailable");
	}
}
