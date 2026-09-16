import { execFileSync, spawnSync } from "node:child_process";
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
	execFileSync: vi.fn(),
	spawnSync: vi.fn(),
}));
it("pins executable bytes before executing, verifies signatures, and rejects mid-check drift", () => {
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
	vi.mocked(spawnSync).mockReturnValue({
		status: 0,
		stderr: "Identifier=com.google.Chrome\nTeamIdentifier=EQHXZ8M8AV\n",
	} as any);
	const run = vi.mocked(execFileSync);
	let chromeVersion = "1.2.3.4";
	let signatureFails = false,
		drift = false;
	run.mockImplementation(((command: string) => {
		if (command === "/usr/bin/codesign") {
			if (signatureFails) throw new Error("signature invalid");
			return "";
		}
		if (command === "/usr/libexec/PlistBuddy") return chromeVersion;
		if (command === node) {
			if (drift) writeFileSync(libnode, "changed");
			return "v25.6.1";
		}
		throw new Error("unexpected command");
	}) as typeof execFileSync);
	try {
		expect(verifyBrowserHostIdentity(input, pin)).toMatchObject({
			codesign: "verified",
			nodeSha256: pin.node.sha256,
		});
		const signatureChecks = run.mock.calls.filter(
			([command]) => command === "/usr/bin/codesign",
		);
		expect(signatureChecks).toHaveLength(1);
		expect(signatureChecks[0][1]).toEqual(["--verify", "--deep", chromeRoot]);
		expect(signatureChecks[0][2]?.timeout).toBeGreaterThanOrEqual(60000);
		chromeVersion = "1.2.3.5";
		expect(verifyBrowserHostIdentity(input, pin).warnings).toEqual([
			"chrome_version_drift",
		]);
		vi.mocked(spawnSync).mockReturnValueOnce({
			status: 0,
			stderr: "Identifier=com.google.Chrome\nTeamIdentifier=FOREIGN\n",
		} as any);
		expect(() => verifyBrowserHostIdentity(input, pin)).toThrow(
			"browser_host_identity_unverified",
		);
		signatureFails = true;
		run.mockClear();
		expect(() => verifyBrowserHostIdentity(input, pin)).toThrow(
			"browser_host_identity_unverified",
		);
		expect(run.mock.calls.some(([cmd]) => cmd === node)).toBe(false);
		signatureFails = false;
		drift = true;
		expect(() => verifyBrowserHostIdentity(input, pin)).toThrow(
			"browser_host_identity_unverified",
		);
		run.mockClear();
		expect(() => verifyBrowserHostIdentity(input, pin)).toThrow(
			"browser_host_identity_unverified",
		);
		expect(run).not.toHaveBeenCalled();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
