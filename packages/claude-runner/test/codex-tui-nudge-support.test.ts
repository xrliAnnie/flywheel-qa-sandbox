import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const docDir = join(
	repoRoot,
	"engineering",
	"doc",
	"FLY-2296-codex-rate-limit-nudge",
);

function writeExecutable(path: string, body: string): void {
	writeFileSync(path, body);
	chmodSync(path, 0o700);
}

function makeShortTempDir(prefix: string): string {
	try {
		return mkdtempSync(join("/private/tmp", prefix));
	} catch {
		return mkdtempSync(join("/tmp", prefix));
	}
}

async function waitFor(
	predicate: () => boolean,
	description: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${description}`);
}

describe("FLY-2296 review and probe support", () => {
	it("HTML-escapes review metadata before rendering the founder artifact", () => {
		const scratch = mkdtempSync(join(tmpdir(), "fly2296-html-"));
		try {
			for (const name of [
				"build-founder-html.py",
				"founder-design.template.html",
				"d1-core-flow.svg",
				"d2-data-model.svg",
				"d3-probe.svg",
			]) {
				cpSync(join(docDir, name), join(scratch, name));
			}
			const hostile = '<img src=x onerror=alert(1)>&"';
			const result = spawnSync(
				"python3",
				[join(scratch, "build-founder-html.py"), hostile],
				{ encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			const rendered = readFileSync(
				join(scratch, "founder-design.html"),
				"utf8",
			);
			expect(rendered).not.toContain(hostile);
			expect(rendered).toContain(
				"&lt;img src=x onerror=alert(1)&gt;&amp;&quot;",
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("rejects unsafe legacy probe identifiers before launching anything", () => {
		const probe = join(docDir, "probe", "probe.sh");
		const result = spawnSync("/bin/bash", [probe, "bad;id", "0"], {
			encoding: "utf8",
			timeout: 5_000,
		});
		expect(result.status, `${result.stdout}${result.stderr}`).toBe(64);
	});

	it("reports the legacy Codex exit code through the probe CLI", () => {
		const scratch = mkdtempSync(join(tmpdir(), "fly2296-legacy-exit-"));
		const runName = `exit-${process.pid}-${Date.now()}`;
		const longTmpRoot = join(
			scratch,
			"runner-state",
			"12345678-1234-1234-1234-123456789abc",
			"browser-tmp",
		);
		const runDirs = ["/private/tmp", "/tmp"].map((root) =>
			join(root, "fly2296", `run-${runName}`),
		);
		const binDir = join(scratch, "bin");
		try {
			mkdirSync(binDir);
			writeExecutable(
				join(binDir, "node"),
				`#!/bin/bash
exec python3 - "$2" "$3" <<'PY'
import signal
import socket
import sys
import time

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sys.argv[1])
server.listen(1)
with open(sys.argv[2], "w", encoding="utf-8") as log:
    log.write(f"LISTEN {sys.argv[1]}\\n")
running = True
def stop(*_args):
    global running
    running = False
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while running:
    time.sleep(0.01)
server.close()
PY
`,
			);
			writeExecutable(
				join(binDir, "tmux"),
				`#!/bin/bash
case "$1" in
  kill-session) exit 0 ;;
  new-session)
    command="\${!#}"
    /bin/bash -c "$command"
    ;;
  capture-pane) printf 'fake Codex pane\\n' ;;
  *) exit 2 ;;
esac
`,
			);
			writeExecutable(join(binDir, "codex"), "#!/bin/bash\nexit 23\n");
			writeExecutable(
				join(binDir, "mkdir"),
				`#!/bin/bash
set -u
case "\${!#}" in
  /private/tmp/fly2296|/private/tmp/fly2296/*|/tmp/fly2296|/tmp/fly2296/*)
    exec /bin/mkdir "$@"
    ;;
  *) printf 'unexpected runtime path: %s\\n' "\${!#}" >&2; exit 73 ;;
esac
`,
			);
			writeExecutable(
				join(binDir, "uuidgen"),
				"#!/bin/bash\nprintf '12345678-1234-1234-1234-123456789abc\\n'\n",
			);
			writeExecutable(join(binDir, "sleep"), "#!/bin/bash\n/bin/sleep 0.01\n");

			const result = spawnSync(
				"/bin/bash",
				[join(docDir, "probe", "probe.sh"), runName, "1"],
				{
					cwd: repoRoot,
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${binDir}:${process.env.PATH ?? ""}`,
						TMPDIR: longTmpRoot,
					},
					timeout: 5_000,
				},
			);
			const evidence = `${result.stdout ?? ""}${result.stderr ?? ""}`;
			expect(result.status, evidence).toBe(0);
			expect(evidence).toContain("EXIT=23");
		} finally {
			for (const runDir of runDirs) {
				rmSync(runDir, { recursive: true, force: true });
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("reports fake-server socket cleanup failures through its process exit", async () => {
		const scratch = makeShortTempDir("fly2296-server-cleanup-");
		const server = join(repoRoot, "scripts", "codex-tui-fake-app-server.cjs");
		const socket = join(scratch, "app.sock");
		const log = join(scratch, "server.log");
		const preload = join(scratch, "fail-unlink.cjs");
		writeFileSync(
			preload,
			`const fs = require("node:fs");
const original = fs.unlinkSync;
fs.unlinkSync = (path) => {
  if (path === ${JSON.stringify(socket)}) {
    const error = new Error("synthetic permission failure");
    error.code = "EACCES";
    throw error;
  }
  return original(path);
};
`,
		);
		const child = spawn(
			process.execPath,
			[server, socket, log, scratch, "12345678-1234-1234-1234-123456789abc"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
						.filter(Boolean)
						.join(" "),
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exited = new Promise<{ code: number | null; signal: string | null }>(
			(resolveExit, rejectExit) => {
				child.once("error", rejectExit);
				child.once("exit", (code, signal) => resolveExit({ code, signal }));
			},
		);

		try {
			await waitFor(
				() => existsSync(log) && readFileSync(log, "utf8").includes("LISTEN"),
				"fake app-server listen evidence",
			);
			child.kill("SIGTERM");
			const result = await exited;
			expect(result, stderr).toEqual({ code: 2, signal: null });
			expect(stderr).toContain(`could not unlink ${socket}`);
			expect(stderr).toContain("synthetic permission failure");
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited.catch(() => undefined);
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
