import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const HELPER = path.join(ROOT, "scripts/release/shell-publish-helper.mjs");

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function resultFrom(stdout) {
	const line = stdout
		.split("\n")
		.find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
	assert.ok(line, `missing JSON result: ${stdout}`);
	return JSON.parse(line);
}

async function invoke(args, env = {}) {
	try {
		const result = await execFileAsync(process.execPath, [HELPER, ...args], {
			env: {
				...process.env,
				npm_config_fetch_retries: "0",
				npm_config_fetch_retry_mintimeout: "0",
				npm_config_fetch_retry_maxtimeout: "0",
				...env,
			},
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return {
			code: error.code,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
		};
	}
}

async function packExact(tempDir) {
	const outputFile = path.join(tempDir, "github-output");
	const result = await invoke(["pack", "--out", tempDir], {
		GITHUB_OUTPUT: outputFile,
	});
	assert.equal(result.code, 0, result.stderr);
	const packed = resultFrom(result.stdout);
	assert.equal(packed.sha, sha256(fs.readFileSync(packed.tarball)));
	assert.equal(packed.version, "0.1.0");
	assert.equal(packed.tag, "latest");
	assert.match(
		fs.readFileSync(outputFile, "utf8"),
		/^tarball=.+\nsha=[0-9a-f]{64}\ntag=latest$/m,
	);
	return packed;
}

async function registry({
	mode,
	version,
	tag,
	tagVersion = version,
	tarballBytes,
}) {
	const server = http.createServer((request, response) => {
		if (request.url?.endsWith(".tgz")) {
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.end(tarballBytes);
			return;
		}
		if (mode === "free" || mode === "error") {
			response.writeHead(mode === "free" ? 404 : 500, {
				"content-type": "application/json",
			});
			response.end(
				JSON.stringify({
					error: mode === "free" ? "Not found" : "host not found",
				}),
			);
			return;
		}
		const name = "@flywheel-ai/onboard";
		const versions = {
			[version]: {
				name,
				version,
				dist: {
					tarball: `http://${request.headers.host}/onboard-${version}.tgz`,
				},
			},
		};
		if (tagVersion !== version) {
			versions[tagVersion] = {
				name,
				version: tagVersion,
				dist: {
					tarball: `http://${request.headers.host}/onboard-${tagVersion}.tgz`,
				},
			};
		}
		const metadata = {
			_id: name,
			name,
			"dist-tags": { [tag]: tagVersion },
			versions,
		};
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(metadata));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	return {
		url: `${base}/`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test("pack emits the exact tarball, sha, version, and tag", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2388-shell-pack-"));
	try {
		const packed = await packExact(tempDir);
		const gate = await invoke(["gate", packed.tarball]);
		assert.equal(gate.code, 0, gate.stderr);
		assert.equal(resultFrom(gate.stdout).outcome, "passed");

		const shimDir = path.join(tempDir, "bin");
		const npmMarker = path.join(tempDir, "npm-invoked");
		fs.mkdirSync(shimDir);
		fs.writeFileSync(
			path.join(shimDir, "npm"),
			`#!/bin/bash\nprintf invoked > "${npmMarker}"\nexit 99\n`,
		);
		fs.chmodSync(path.join(shimDir, "npm"), 0o755);
		const exactGate = await invoke(["gate", packed.tarball], {
			PATH: `${shimDir}:${process.env.PATH}`,
		});
		assert.equal(exactGate.code, 0, exactGate.stderr);
		assert.equal(
			fs.existsSync(npmMarker),
			false,
			"exact gate rebuilt the source tree",
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("registry errors other than an explicit E404 never mean free", async () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "fly2388-shell-error-"),
	);
	try {
		const packed = await packExact(tempDir);
		const stub = await registry({
			mode: "error",
			version: packed.version,
			tag: packed.tag,
			tarballBytes: Buffer.alloc(0),
		});
		try {
			const result = await invoke([
				"preflight",
				packed.tarball,
				"--expect-sha",
				packed.sha,
				"--expect-tag",
				packed.tag,
				"--registry",
				stub.url,
			]);
			assert.notEqual(result.code, 0);
			assert.doesNotMatch(result.stdout, /"outcome":"free"/);
			assert.match(result.stderr, /npm view failed closed/i);
		} finally {
			await stub.close();
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("registry preflight distinguishes free, idempotent, sha conflict, and tag conflict", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2388-shell-reg-"));
	try {
		const packed = await packExact(tempDir);
		const bytes = fs.readFileSync(packed.tarball);
		for (const scenario of [
			{ mode: "free", tag: "latest", bytes, outcome: "free", code: 0 },
			{ mode: "present", tag: "latest", bytes, outcome: "idempotent", code: 0 },
			{
				mode: "present",
				tag: "latest",
				bytes: Buffer.from("different"),
				outcome: "conflict",
				code: 1,
			},
			{
				mode: "present",
				tag: "latest",
				tagVersion: "9.9.9",
				bytes,
				outcome: "conflict",
				code: 1,
			},
		]) {
			const stub = await registry({
				mode: scenario.mode,
				version: packed.version,
				tag: scenario.tag,
				tagVersion: scenario.tagVersion,
				tarballBytes: scenario.bytes,
			});
			try {
				const outputFile = path.join(
					tempDir,
					`output-${scenario.mode}-${scenario.tag}-${scenario.bytes.length}`,
				);
				const result = await invoke(
					[
						"preflight",
						packed.tarball,
						"--expect-sha",
						packed.sha,
						"--expect-tag",
						packed.tag,
						"--registry",
						stub.url,
					],
					{ GITHUB_OUTPUT: outputFile },
				);
				assert.equal(result.code === 0 ? 0 : 1, scenario.code, result.stderr);
				assert.match(
					result.stdout,
					/^\{/m,
					`${JSON.stringify({ ...scenario, bytes: scenario.bytes.length })}: ${result.stderr}`,
				);
				assert.equal(resultFrom(result.stdout).outcome, scenario.outcome);
				if (scenario.code === 0) {
					assert.match(
						fs.readFileSync(outputFile, "utf8"),
						new RegExp(`^outcome=${scenario.outcome}$`, "m"),
					);
				}
			} finally {
				await stub.close();
			}
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("verify fails closed on a mismatched readback and on timeout", async () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "fly2388-shell-verify-"),
	);
	try {
		const packed = await packExact(tempDir);
		for (const scenario of [
			{ mode: "present", tag: "latest", bytes: Buffer.from("wrong") },
			{ mode: "free", tag: "latest", bytes: Buffer.alloc(0) },
		]) {
			const stub = await registry({
				mode: scenario.mode,
				version: packed.version,
				tag: scenario.tag,
				tarballBytes: scenario.bytes,
			});
			try {
				const result = await invoke(
					[
						"verify",
						packed.tarball,
						"--expect-sha",
						packed.sha,
						"--expect-tag",
						packed.tag,
						"--registry",
						stub.url,
					],
					{ FW_SHELL_VERIFY_ATTEMPTS: "2", FW_SHELL_VERIFY_DELAY_MS: "0" },
				);
				assert.notEqual(result.code, 0);
				assert.match(result.stderr, /published|verify|sha256|visible/i);
			} finally {
				await stub.close();
			}
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
