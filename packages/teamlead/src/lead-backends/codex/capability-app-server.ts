import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildLeadModelEnv } from "../../lead-capabilities/model-env.js";
import type { LeadCapabilityParent } from "../../lead-capabilities/runtime-parent.js";

/** One activation-owned process; never contacts or adopts a remote-control daemon. */
export async function startCapabilityAppServer(options: {
	parent: LeadCapabilityParent;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	startupTimeoutMs?: number;
}) {
	const { parent, signal } = options;
	await parent.assertCurrent();
	signal?.throwIfAborted();
	const binary = parent.codexPath;
	if (!binary || realpathSync(binary) !== binary)
		throw new Error("capability_app_server_binary_invalid");
	const timeout = options.startupTimeoutMs ?? 10_000;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
		throw new Error("capability_app_server_timeout_invalid");
	const env = buildLeadModelEnv(options.env, parent.pins);
	const digest = (value: string | Buffer) =>
		createHash("sha256").update(value).digest("hex");
	const binarySha256 = digest(readFileSync(binary));
	const root = realpathSync(mkdtempSync("/tmp/fw-tui-")),
		directory = lstatSync(root);
	const socketPath = join(root, "app.sock");
	const argv = [
		"app-server",
		"--strict-config",
		"--listen",
		`unix://${socketPath}`,
		...parent.permissionArgv,
		...parent.mcp.argv,
	];
	let closed = false,
		exited = false,
		failed = false;
	let closing: Promise<void> | undefined;
	let child: ChildProcess;
	try {
		child = spawn(binary, argv, { env, stdio: "ignore" });
	} catch (error) {
		rmSync(root, { recursive: true });
		throw error;
	}
	let done!: () => void;
	const completion = new Promise<void>((resolve) => {
		done = resolve;
	});
	child.once("exit", () => {
		exited = true;
		done();
	});
	child.once("error", () => {
		failed = true;
		exited = true;
		done();
	});
	const sameDirectory = () => {
		const current = lstatSync(root);
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.ino !== directory.ino ||
			current.dev !== directory.dev ||
			current.uid !== directory.uid ||
			(current.mode & 0o077) !== 0
		)
			throw new Error("capability_app_server_directory_changed");
	};
	const close = () => {
		if (closing) return closing;
		closed = true;
		closing = (async () => {
			if (!exited) {
				child.kill("SIGTERM");
				await Promise.race([
					completion,
					delay(2000, undefined, { ref: false }),
				]);
				if (!exited) {
					child.kill("SIGKILL");
					await Promise.race([
						completion,
						delay(2000, undefined, { ref: false }),
					]);
				}
			}
			if (!exited) throw new Error("capability_app_server_stop_unproved");
			sameDirectory();
			rmSync(root, { recursive: true });
		})();
		return closing;
	};
	try {
		const deadline = Date.now() + timeout;
		let socket: ReturnType<typeof lstatSync> | undefined;
		while (!socket) {
			signal?.throwIfAborted();
			if (exited || failed) throw new Error("capability_app_server_exited");
			sameDirectory();
			try {
				socket = lstatSync(socketPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (socket) break;
			if (Date.now() >= deadline)
				throw new Error("capability_app_server_timeout");
			await delay(20);
		}
		if (!socket.isSocket() || socket.uid !== directory.uid)
			throw new Error("capability_app_server_socket_invalid");
		const assertCurrent = async () => {
			if (closed) throw new Error("capability_app_server_closed");
			if (exited || failed) throw new Error("capability_app_server_exited");
			signal?.throwIfAborted();
			sameDirectory();
			const current = lstatSync(socketPath);
			if (
				!current.isSocket() ||
				current.ino !== socket!.ino ||
				current.dev !== socket!.dev
			)
				throw new Error("capability_app_server_socket_changed");
			await parent.assertCurrent();
		};
		await assertCurrent();
		return Object.freeze({
			socketPath,
			assertCurrent,
			close,
			receipt: Object.freeze({
				transport: "app_server_socket" as const,
				pid: child.pid!,
				binarySha256,
				argvSha256: digest(JSON.stringify(argv)),
				envSha256: digest(
					JSON.stringify(
						Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
					),
				),
			}),
		});
	} catch (error) {
		await close();
		throw error;
	}
}
