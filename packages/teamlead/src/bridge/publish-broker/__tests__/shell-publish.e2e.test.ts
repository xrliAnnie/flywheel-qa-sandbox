/**
 * FLY-1062 broker PR · publish-shell executor against a stub npm registry.
 * Pins: broker-side authoritative content gate (whitelist / secrets / private
 * URL / placeholder endpoint), approved-sha rehash, in-process publish with
 * the GAT only in the Authorization header, 409 re-hash idempotency, and
 * "same version different bytes" refusal.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executePublishShell } from "../shell-publish.js";
import { verifyShellTarball } from "../shell-verify.js";

const GAT = "npm-gat-token-value";
const HERE_DIR = fileURLToPath(new URL(".", import.meta.url));
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface FixtureOpts {
	name?: string;
	version?: string;
	endpoint?: string;
	/** in-prefix smuggle: an UNPINNED lib/ file (Codex R1 HIGH repro) */
	smuggledLibFile?: boolean;
	/** rootward smuggle: a file outside bin/lib */
	extraRootFile?: boolean;
	/** drop a pinned required file */
	missingRequiredFile?: boolean;
	/** replace a pinned file with a symlink */
	symlinkFile?: boolean;
	secretInLib?: boolean;
	npmTokenInLib?: boolean;
	/** patterns the in-process list does NOT know — must be caught by the
	 * SHARED calibrated scanner (Codex R2 HIGH) */
	discordTokenInLib?: boolean;
	jwtInLib?: boolean;
	highEntropyInLib?: boolean;
	/** NUL byte in a required text file — would make grep -I skip it (R3) */
	nulByteInLib?: boolean;
	privateRepoUrl?: boolean;
	marker?: string;
}

/** builds the EXACT pinned 12-file set (the verifier's contract), with hooks
 * for each violation class. */
function buildShellTarball(opts: FixtureOpts = {}): {
	tarball: string;
	sha256: string;
} {
	const {
		name = "@flywheel/onboard",
		version = "9.9.9",
		endpoint = "https://onboard.example.com",
		marker = "",
	} = opts;
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "fw-shell-fixture-"));
	const root = path.join(work, "package");
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	fs.mkdirSync(path.join(root, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			name,
			version,
			bin: { "flywheel-onboard": "bin/flywheel-onboard.js" },
			engines: { node: ">=20" },
			publishConfig: { access: "public" },
		}),
	);
	fs.writeFileSync(path.join(root, "README.md"), `# onboard shell ${marker}\n`);
	fs.writeFileSync(
		path.join(root, "bin", "flywheel-onboard.js"),
		"#!/usr/bin/env node\nconsole.log('ok');\n",
	);
	fs.writeFileSync(
		path.join(root, "lib", "config.mjs"),
		`export const DEFAULT_ENDPOINT = ${JSON.stringify(endpoint)};\n${
			opts.secretInLib ? `// fwk_${"0".repeat(40)}\n` : ""
		}${opts.privateRepoUrl ? "// see github.com/xrliAnnie/flywheel\n" : ""}`,
	);
	for (const stub of [
		"messages.mjs",
		"key.mjs",
		"endpoint.mjs",
		"install.mjs",
		"journal.mjs",
		"onboard.mjs",
		"update.mjs",
		"license.mjs",
	]) {
		fs.writeFileSync(path.join(root, "lib", stub), `// ${stub} stub\n`);
	}
	if (opts.npmTokenInLib) {
		fs.appendFileSync(
			path.join(root, "lib", "messages.mjs"),
			`// npm_${"A1b2".repeat(9)}\n`,
		);
	}
	if (opts.discordTokenInLib) {
		fs.appendFileSync(
			path.join(root, "lib", "messages.mjs"),
			`// DISCORD_BOT_TOKEN=M${"a1B".repeat(8)}.aB1x2c.${"a1B".repeat(9)}\n`,
		);
	}
	if (opts.jwtInLib) {
		fs.appendFileSync(
			path.join(root, "lib", "messages.mjs"),
			`// eyJ${"a1B".repeat(5)}.eyJ${"a1B".repeat(5)}.${"a1B".repeat(4)}\n`,
		);
	}
	if (opts.highEntropyInLib) {
		fs.appendFileSync(
			path.join(root, "lib", "messages.mjs"),
			`// ${"Ab3".repeat(15)}\n`,
		);
	}
	if (opts.nulByteInLib) {
		// a NUL byte makes grep treat the file as binary (-I skips it) — the
		// gate must refuse binary content in a published text file outright
		fs.appendFileSync(
			path.join(root, "lib", "messages.mjs"),
			Buffer.concat([
				Buffer.from([0]),
				Buffer.from(`// M${"a1B".repeat(8)}.aB1x2c.${"a1B".repeat(9)}\n`),
			]),
		);
	}
	if (opts.smuggledLibFile) {
		fs.writeFileSync(
			path.join(root, "lib", "internal-secret.mjs"),
			"// smuggled — must never publish\n",
		);
	}
	if (opts.extraRootFile) {
		fs.writeFileSync(path.join(root, "notes.txt"), "should not publish\n");
	}
	if (opts.missingRequiredFile) {
		fs.rmSync(path.join(root, "lib", "update.mjs"));
	}
	if (opts.symlinkFile) {
		fs.rmSync(path.join(root, "lib", "license.mjs"));
		fs.symlinkSync("config.mjs", path.join(root, "lib", "license.mjs"));
	}
	const tarball = path.join(work, "staged.tgz");
	execFileSync("tar", ["-czf", tarball, "-C", work, "package"], {
		stdio: "pipe",
	});
	return { tarball, sha256: sha256Hex(fs.readFileSync(tarball)) };
}

interface StubRegistry {
	url: string;
	close: () => void;
	puts: {
		auth: string | undefined;
		version: string;
		bytes: Buffer;
		versionDoc: Record<string, unknown>;
	}[];
	packumentGets: number;
	/** pre-seed a published version */
	seed: (version: string, bytes: Buffer) => void;
	/** force the NEXT PUT to answer 409 without storing */
	conflictNextPut: () => void;
}

function startStubRegistry(): Promise<StubRegistry> {
	const published = new Map<string, Buffer>();
	const puts: StubRegistry["puts"] = [];
	let conflictOnce = false;
	let packumentGets = 0;
	const server = http.createServer(async (req, res) => {
		const url = decodeURIComponent(req.url ?? "");
		if (req.method === "GET" && url === "/@flywheel/onboard") {
			packumentGets++;
			if (published.size === 0) {
				res.writeHead(404).end(JSON.stringify({ error: "not found" }));
				return;
			}
			const versions: Record<string, unknown> = {};
			for (const v of published.keys()) {
				versions[v] = {
					dist: {
						tarball: `http://127.0.0.1:${(server.address() as { port: number }).port}/@flywheel/onboard/-/onboard-${v}.tgz`,
					},
				};
			}
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ name: "@flywheel/onboard", versions }));
			return;
		}
		const tarballMatch = /^\/@flywheel\/onboard\/-\/onboard-(.+)\.tgz$/.exec(
			url,
		);
		if (req.method === "GET" && tarballMatch) {
			const bytes = published.get(tarballMatch[1]);
			if (!bytes) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(bytes);
			return;
		}
		if (req.method === "PUT" && url === "/@flywheel/onboard") {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(Buffer.from(c));
			const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const version = Object.keys(doc.versions)[0];
			const attachment = Object.values(
				doc._attachments as Record<string, { data: string }>,
			)[0];
			const bytes = Buffer.from(attachment.data, "base64");
			if (conflictOnce) {
				conflictOnce = false;
				res.writeHead(409).end(JSON.stringify({ error: "conflict" }));
				return;
			}
			if (published.has(version)) {
				res.writeHead(409).end(JSON.stringify({ error: "exists" }));
				return;
			}
			published.set(version, bytes);
			puts.push({
				auth: req.headers.authorization,
				version,
				bytes,
				versionDoc: doc.versions[version],
			});
			res.writeHead(201).end(JSON.stringify({ ok: true }));
			return;
		}
		res.writeHead(500).end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => server.close(),
				puts,
				get packumentGets() {
					return packumentGets;
				},
				seed: (v, b) => published.set(v, b),
				conflictNextPut: () => {
					conflictOnce = true;
				},
			});
		});
	});
}

const registries: StubRegistry[] = [];
afterEach(() => {
	for (const r of registries.splice(0)) r.close();
});

async function registry(): Promise<StubRegistry> {
	const r = await startStubRegistry();
	registries.push(r);
	return r;
}

describe("verifyShellTarball (broker-side authoritative gate)", () => {
	it("accepts the clean publishable form and returns the full manifest", () => {
		const { tarball, sha256 } = buildShellTarball();
		const id = verifyShellTarball(tarball, sha256);
		expect(id.name).toBe("@flywheel/onboard");
		expect(id.version).toBe("9.9.9");
		expect(id.manifest.bin).toEqual({
			"flywheel-onboard": "bin/flywheel-onboard.js",
		});
	});

	it("refuses a sha mismatch with the approved artifact", () => {
		const { tarball } = buildShellTarball();
		expect(() => verifyShellTarball(tarball, "0".repeat(64))).toThrow(
			/does not match the approved artifact/,
		);
	});

	it("refuses a non-whitelisted file at the package root", () => {
		const { tarball, sha256 } = buildShellTarball({ extraRootFile: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/non-whitelisted file/,
		);
	});

	it("refuses an IN-PREFIX smuggled lib file (exact set, not prefix rules)", () => {
		const { tarball, sha256 } = buildShellTarball({ smuggledLibFile: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/non-whitelisted file in shell tarball: package\/lib\/internal-secret\.mjs/,
		);
	});

	it("refuses a tarball MISSING a pinned required file (lower bound)", () => {
		const { tarball, sha256 } = buildShellTarball({
			missingRequiredFile: true,
		});
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/required published file missing/,
		);
	});

	it("refuses a symlink standing in for a pinned file", () => {
		const { tarball, sha256 } = buildShellTarball({ symlinkFile: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/non-regular file/,
		);
	});

	it("refuses license-key material anywhere in the tree", () => {
		const { tarball, sha256 } = buildShellTarball({ secretInLib: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/license-key material/,
		);
	});

	it("refuses generic vendor credentials (npm token shape)", () => {
		const { tarball, sha256 } = buildShellTarball({ npmTokenInLib: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(/npm token/);
	});

	it("CALIBRATED NET: refuses a Discord bot token (not in the in-process list)", () => {
		const { tarball, sha256 } = buildShellTarball({ discordTokenInLib: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/calibrated secret scan/,
		);
	});

	it("CALIBRATED NET: refuses a JWT-shaped token", () => {
		const { tarball, sha256 } = buildShellTarball({ jwtInLib: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/calibrated secret scan/,
		);
	});

	it("CALIBRATED NET: refuses a bare high-entropy blob", () => {
		const { tarball, sha256 } = buildShellTarball({ highEntropyInLib: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/calibrated secret scan/,
		);
	});

	it("CALIBRATED NET: refusal never echoes the matched value", () => {
		const { tarball, sha256 } = buildShellTarball({ discordTokenInLib: true });
		try {
			verifyShellTarball(tarball, sha256);
			expect.unreachable("must refuse");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).not.toContain("a1Ba1B"); // no fragment of the token value
			expect(msg).toMatch(/vendor-token|high-entropy|scan refused/);
		}
	});

	it("BINARY EVASION: a NUL byte in a required text file refuses outright", () => {
		// grep's binary detection (-I) would otherwise exempt the file from the
		// calibrated whole-tree net — the gate refuses before that can matter
		const { tarball, sha256 } = buildShellTarball({ nulByteInLib: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/binary content in published file/,
		);
	});

	it("FAIL-CLOSED: a scanner TOOL ERROR (exit 2, zero findings) refuses the publish", () => {
		const { tarball, sha256 } = buildShellTarball();
		const stub = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "fw-scan-stub-")),
			"fleet-sanitize.sh",
		);
		fs.writeFileSync(
			stub,
			'scan_code_tree_for_secrets() { echo "scan_code_tree_for_secrets: [scan-error] simulated tool failure" >&2; return 2; }\n',
		);
		const prev = process.env.FLYWHEEL_FLEET_SANITIZE;
		process.env.FLYWHEEL_FLEET_SANITIZE = stub;
		try {
			expect(() => verifyShellTarball(tarball, sha256)).toThrow(
				/calibrated secret scan/,
			);
		} finally {
			if (prev === undefined) delete process.env.FLYWHEEL_FLEET_SANITIZE;
			else process.env.FLYWHEEL_FLEET_SANITIZE = prev;
		}
	});

	it("FAIL-CLOSED: a missing calibrated scanner refuses the publish", () => {
		const { tarball, sha256 } = buildShellTarball();
		const prev = process.env.FLYWHEEL_FLEET_SANITIZE;
		process.env.FLYWHEEL_FLEET_SANITIZE = "/nonexistent/fleet-sanitize.sh";
		try {
			expect(() => verifyShellTarball(tarball, sha256)).toThrow(
				/scanner missing.*fail-closed/,
			);
		} finally {
			if (prev === undefined) delete process.env.FLYWHEEL_FLEET_SANITIZE;
			else process.env.FLYWHEEL_FLEET_SANITIZE = prev;
		}
	});

	it("refuses a private repo URL", () => {
		const { tarball, sha256 } = buildShellTarball({ privateRepoUrl: true });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(/private repo/);
	});

	it("refuses the .invalid placeholder endpoint", () => {
		const { tarball, sha256 } = buildShellTarball({
			endpoint: "https://onboard.flywheel.invalid",
		});
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(/placeholder/);
	});

	it("refuses a wrong package name", () => {
		const { tarball, sha256 } = buildShellTarball({ name: "@evil/onboard" });
		expect(() => verifyShellTarball(tarball, sha256)).toThrow(
			/unexpected package name/,
		);
	});
});

describe("executePublishShell against a stub registry", () => {
	it("publishes: one PUT, GAT only in the Authorization header, exact bytes", async () => {
		const reg = await registry();
		const { tarball, sha256 } = buildShellTarball();
		const detail = await executePublishShell(
			{ stagedPath: tarball, sha256, registryUrl: reg.url },
			GAT,
		);
		expect(detail.name).toBe("@flywheel/onboard");
		expect(detail.version).toBe("9.9.9");
		expect(reg.puts.length).toBe(1);
		expect(reg.puts[0].auth).toBe(`Bearer ${GAT}`);
		expect(sha256Hex(reg.puts[0].bytes)).toBe(sha256);
		// the version document IS the install manifest — bin/engines must ride
		// (Codex R1 HIGH: without bin, npx cannot resolve the executable)
		expect(reg.puts[0].versionDoc.bin).toEqual({
			"flywheel-onboard": "bin/flywheel-onboard.js",
		});
		expect(reg.puts[0].versionDoc.engines).toEqual({ node: ">=20" });
	});

	it("same version already published with the SAME bytes → idempotent, no PUT", async () => {
		const reg = await registry();
		const { tarball, sha256 } = buildShellTarball();
		reg.seed("9.9.9", fs.readFileSync(tarball));
		const detail = await executePublishShell(
			{ stagedPath: tarball, sha256, registryUrl: reg.url },
			GAT,
		);
		expect(detail.idempotent).toBe("true");
		expect(reg.puts.length).toBe(0);
	});

	it("same version with DIFFERENT bytes → refuse (clean semver never reused)", async () => {
		const reg = await registry();
		const other = buildShellTarball({ marker: "other-bytes" });
		reg.seed("9.9.9", fs.readFileSync(other.tarball));
		const { tarball, sha256 } = buildShellTarball();
		await expect(
			executePublishShell(
				{ stagedPath: tarball, sha256, registryUrl: reg.url },
				GAT,
			),
		).rejects.toThrow(/DIFFERENT content/);
		expect(reg.puts.length).toBe(0);
	});

	it("PUT conflict is NOT success by itself — re-download + local sha256 decides", async () => {
		const reg = await registry();
		const { tarball, sha256 } = buildShellTarball();
		// preflight sees nothing; the PUT races a concurrent publish of the SAME
		// bytes (simulated: 409 once, then the registry serves those bytes)
		reg.conflictNextPut();
		reg.seed("9.9.9", fs.readFileSync(tarball));
		const detail = await executePublishShell(
			{ stagedPath: tarball, sha256, registryUrl: reg.url },
			GAT,
		);
		expect(detail.idempotent).toBe("true");
	});

	it("a failing gate never touches the registry", async () => {
		const reg = await registry();
		const { tarball, sha256 } = buildShellTarball({ smuggledLibFile: true });
		await expect(
			executePublishShell(
				{ stagedPath: tarball, sha256, registryUrl: reg.url },
				GAT,
			),
		).rejects.toThrow(/non-whitelisted/);
		expect(reg.packumentGets).toBe(0);
		expect(reg.puts.length).toBe(0);
	});
});

describe("DRIFT LOCK — the pinned file set tracks the REAL shell package", () => {
	it("npm pack of packages/onboard-shell (endpoint patched) passes the verifier", () => {
		const shellDir = path.join(HERE_DIR, "../../../../..", "onboard-shell");
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "fw-shell-drift-"));
		const packed = execFileSync("npm", ["pack", "--pack-destination", work], {
			cwd: shellDir,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.pop() as string;
		// the real shell still bakes the .invalid placeholder (filled at P5) —
		// patch ONLY that constant, then repack: everything else must pass the
		// pinned exact set, or the snapshot has drifted and needs a deliberate
		// update in BOTH the PR2 gate and SHELL_PUBLISH_FILE_SET.
		execFileSync("tar", ["-xzf", path.join(work, packed), "-C", work], {
			stdio: "pipe",
		});
		const cfg = path.join(work, "package", "lib", "config.mjs");
		fs.writeFileSync(
			cfg,
			fs
				.readFileSync(cfg, "utf8")
				.replace(/onboard\.flywheel\.invalid/g, "onboard.example.com"),
		);
		const repacked = path.join(work, "drift.tgz");
		execFileSync("tar", ["-czf", repacked, "-C", work, "package"], {
			stdio: "pipe",
		});
		const sha = sha256Hex(fs.readFileSync(repacked));
		const id = verifyShellTarball(repacked, sha);
		expect(id.name).toBe("@flywheel/onboard");
		expect((id.manifest as { bin?: Record<string, string> }).bin).toBeTruthy();
	});
});
