import { describe, expect, it, vi } from "vitest";
import {
	createDesktopCodexVerifier,
	DESKTOP_CODEX_PATH,
} from "../desktop-codex-identity.js";

// Real `codesign -dv --verbose=2` stderr shape captured on the production host.
const CODESIGN_STDERR = [
	`Executable=${DESKTOP_CODEX_PATH}`,
	"Identifier=codex",
	"Format=Mach-O thin (arm64)",
	"CodeDirectory v=20500 size=81234 flags=0x10000(runtime) hashes=2527+7 location=embedded",
	"Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
	"Authority=Developer ID Certification Authority",
	"Authority=Apple Root CA",
	"Timestamp=Sep 20, 2026 at 10:00:00",
	"Info.plist=not bound",
	"TeamIdentifier=2DC432GLL2",
	"Runtime Version=15.0.0",
	"Sealed Resources=none",
].join("\n");

function harness(
	overrides: {
		lsof?: string;
		verifyExit?: number;
		describe?: string;
		stat?: { ino: number; mtimeMs: number };
	} = {},
) {
	let stat = overrides.stat ?? { ino: 7, mtimeMs: 1000 };
	const run = vi.fn(async (file: string, args: string[]) => {
		if (file === "/usr/sbin/lsof")
			return {
				exitCode: 0,
				stdout:
					overrides.lsof ??
					`p77\nftxt\nn${DESKTOP_CODEX_PATH}\nftxt\nn/usr/lib/dyld\n`,
				stderr: "",
			};
		if (args[0] === "--verify")
			return { exitCode: overrides.verifyExit ?? 0, stdout: "", stderr: "" };
		return {
			exitCode: 0,
			stdout: "",
			stderr: overrides.describe ?? CODESIGN_STDERR,
		};
	});
	const verifier = createDesktopCodexVerifier({
		run,
		stat: () => stat,
	});
	return {
		run,
		verifier,
		setStat: (next: { ino: number; mtimeMs: number }) => {
			stat = next;
		},
	};
}

describe("FLY-2869 — verifiable ChatGPT desktop codex identity", () => {
	it("accepts the signed OpenAI binary running from inside ChatGPT.app", async () => {
		const h = harness();
		await expect(h.verifier(77, DESKTOP_CODEX_PATH)).resolves.toBe(true);
	});

	it.each([
		{
			name: "an argv0 outside the bundle",
			argv0: "/usr/local/bin/codex",
			overrides: {},
		},
		{
			name: "a kernel executable path that differs from argv0 (spoofed argv0)",
			argv0: DESKTOP_CODEX_PATH,
			overrides: { lsof: "p77\nftxt\nn/tmp/evil/codex\n" },
		},
		{
			name: "a failed signature verification",
			argv0: DESKTOP_CODEX_PATH,
			overrides: { verifyExit: 1 },
		},
		{
			name: "a different leaf Authority",
			argv0: DESKTOP_CODEX_PATH,
			overrides: {
				describe: CODESIGN_STDERR.replace(
					"Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
					"Authority=Developer ID Application: Someone Else (2DC432GLL2)",
				),
			},
		},
		{
			name: "the right Authority only in a non-leaf position",
			argv0: DESKTOP_CODEX_PATH,
			overrides: {
				describe: CODESIGN_STDERR.replace(
					"Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)\nAuthority=Developer ID Certification Authority",
					"Authority=Developer ID Certification Authority\nAuthority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
				),
			},
		},
		{
			name: "a different TeamIdentifier",
			argv0: DESKTOP_CODEX_PATH,
			overrides: {
				describe: CODESIGN_STDERR.replace(
					"TeamIdentifier=2DC432GLL2",
					"TeamIdentifier=XXXXXXXXXX",
				),
			},
		},
		{
			name: "a missing TeamIdentifier",
			argv0: DESKTOP_CODEX_PATH,
			overrides: {
				describe: CODESIGN_STDERR.replace("TeamIdentifier=2DC432GLL2\n", ""),
			},
		},
		{
			name: "a duplicated TeamIdentifier",
			argv0: DESKTOP_CODEX_PATH,
			overrides: {
				describe: `${CODESIGN_STDERR}\nTeamIdentifier=2DC432GLL2`,
			},
		},
	])("rejects $name", async ({ argv0, overrides }) => {
		const h = harness(overrides);
		await expect(h.verifier(77, argv0)).resolves.toBe(false);
	});

	it("caches the signature by (path, inode, mtime) and re-verifies on change", async () => {
		const h = harness();
		await h.verifier(77, DESKTOP_CODEX_PATH);
		await h.verifier(78, DESKTOP_CODEX_PATH);
		const signatureCalls = () =>
			h.run.mock.calls.filter(([file]) => file === "/usr/bin/codesign").length;
		expect(signatureCalls()).toBe(2);
		h.setStat({ ino: 8, mtimeMs: 1000 });
		await h.verifier(77, DESKTOP_CODEX_PATH);
		expect(signatureCalls()).toBe(4);
		h.setStat({ ino: 8, mtimeMs: 2000 });
		await h.verifier(77, DESKTOP_CODEX_PATH);
		expect(signatureCalls()).toBe(6);
	});

	it("fails closed when a tool cannot run", async () => {
		const verifier = createDesktopCodexVerifier({
			run: async () => {
				throw new Error("ETIMEDOUT");
			},
			stat: () => ({ ino: 1, mtimeMs: 1 }),
		});
		await expect(verifier(77, DESKTOP_CODEX_PATH)).resolves.toBe(false);
	});
});
