import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { verifyBrowserHostIdentity } from "../browser-host-identity.js";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
	spawnSync: vi.fn(),
}));
type Outcome = {
	stdout?: string;
	stderr?: string;
	error?: Error;
	delayMs?: number;
};
type Call = [string, string[], { timeout?: number; maxBuffer?: number }];
/** Async child processes only: the parent's event loop must keep running (QA@3 H1). */
function fakeExecFile(respond: (command: string, args: string[]) => Outcome) {
	const calls: Call[] = [];
	vi.mocked(execFile).mockImplementation(((
		command: string,
		args: string[],
		options: Call[2],
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		calls.push([command, args, options]);
		let outcome: Outcome;
		try {
			outcome = respond(command, args);
		} catch (error) {
			outcome = { error: error as Error };
		}
		setTimeout(
			() =>
				callback(
					outcome.error ?? null,
					outcome.stdout ?? "",
					outcome.stderr ?? "",
				),
			outcome.delayMs ?? 0,
		);
	}) as unknown as typeof execFile);
	return calls;
}
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-identity-"))),
		chromeRoot = join(root, "Chrome.app"),
		chromeExecutable = join(chromeRoot, "Contents/MacOS/Google Chrome");
	mkdirSync(join(chromeRoot, "Contents/MacOS"), { recursive: true });
	writeFileSync(chromeExecutable, "chrome");
	const node = join(root, "node"),
		libnode = join(root, "libnode.dylib");
	writeFileSync(node, "node");
	writeFileSync(libnode, "library");
	const hash = (s: string) => createHash("sha256").update(s).digest("hex");
	const pin = {
		chrome: {
			root: chromeRoot,
			version: "1.2.3.4",
			identifier: "com.google.Chrome",
			teamIdentifier: "EQHXZ8M8AV",
		},
		node: { path: node, version: "v25.6.1", sha256: hash("node") },
		libnode: { path: libnode, sha256: hash("library") },
	};
	const input = { nodeExecutable: node, chromeExecutable };
	return { root, chromeRoot, node, libnode, pin, input };
}

it("pins executable bytes before executing, verifies signatures, and rejects mid-check drift", async () => {
	const { root, chromeRoot, node, libnode, pin, input } = fixture();
	let chromeVersion = "1.2.3.4";
	let team = "EQHXZ8M8AV";
	let signatureFails = false,
		drift = false;
	const calls = fakeExecFile((command, args) => {
		if (command === "/usr/bin/codesign" && args[0] === "--verify") {
			if (signatureFails) throw new Error("signature invalid");
			return {};
		}
		if (command === "/usr/bin/codesign" && args[0] === "-dv")
			return {
				stderr: `Identifier=com.google.Chrome\nTeamIdentifier=${team}\n`,
			};
		if (command === "/usr/libexec/PlistBuddy") return { stdout: chromeVersion };
		if (command === node) {
			if (drift) writeFileSync(libnode, "changed");
			return { stdout: "v25.6.1\n" };
		}
		throw new Error("unexpected command");
	});
	try {
		await expect(verifyBrowserHostIdentity(input, pin)).resolves.toMatchObject({
			codesign: "verified",
			nodeSha256: pin.node.sha256,
		});
		const signatureChecks = calls.filter(
			([command, args]) =>
				command === "/usr/bin/codesign" && args[0] === "--verify",
		);
		expect(signatureChecks).toHaveLength(1);
		expect(signatureChecks[0]![1]).toEqual(["--verify", "--deep", chromeRoot]);
		expect(signatureChecks[0]![2].timeout).toBeGreaterThanOrEqual(60000);
		chromeVersion = "1.2.3.5";
		expect((await verifyBrowserHostIdentity(input, pin)).warnings).toEqual([
			"chrome_version_drift",
		]);
		team = "FOREIGN";
		await expect(verifyBrowserHostIdentity(input, pin)).rejects.toThrow(
			"browser_host_identity_unverified",
		);
		team = "EQHXZ8M8AV";
		signatureFails = true;
		calls.length = 0;
		await expect(verifyBrowserHostIdentity(input, pin)).rejects.toThrow(
			"browser_host_identity_unverified",
		);
		expect(calls.some(([cmd]) => cmd === node)).toBe(false);
		signatureFails = false;
		drift = true;
		await expect(verifyBrowserHostIdentity(input, pin)).rejects.toThrow(
			"browser_host_identity_unverified",
		);
		calls.length = 0;
		await expect(verifyBrowserHostIdentity(input, pin)).rejects.toThrow(
			"browser_host_identity_unverified",
		);
		expect(calls).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps the event loop running while the deep signature check runs (QA@3 H1)", async () => {
	const { root, node, pin, input } = fixture();
	fakeExecFile((command, args) => {
		if (command === "/usr/bin/codesign" && args[0] === "--verify")
			return { delayMs: 300 };
		if (command === "/usr/bin/codesign")
			return {
				stderr: "Identifier=com.google.Chrome\nTeamIdentifier=EQHXZ8M8AV\n",
			};
		if (command === "/usr/libexec/PlistBuddy") return { stdout: "1.2.3.4" };
		if (command === node) return { stdout: "v25.6.1" };
		throw new Error("unexpected command");
	});
	let ticks = 0;
	const timer = setInterval(() => ticks++, 20);
	try {
		await expect(verifyBrowserHostIdentity(input, pin)).resolves.toMatchObject({
			codesign: "verified",
		});
		// A lease heartbeat would have run many times during the 300 ms check.
		expect(ticks).toBeGreaterThanOrEqual(5);
		expect(execFileSync).not.toHaveBeenCalled();
		expect(spawnSync).not.toHaveBeenCalled();
	} finally {
		clearInterval(timer);
		rmSync(root, { recursive: true, force: true });
	}
});
