import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("replays the original durable stage after SIGKILL during an unresponsive POST", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly1956-stage-crash-"));
	const posts: Record<string, unknown>[] = [];
	let received!: () => void;
	const firstPost = new Promise<void>((resolve) => {
		received = resolve;
	});
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		posts.push(JSON.parse(raw));
		if (posts.length === 1) {
			// Hold the response indefinitely: the parent kills the client after observing POST.
			received();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, duplicate: true, applied: true }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing socket address");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		FLYWHEEL_COMM_DB: join(home, "comm.db"),
		FLYWHEEL_EXEC_ID: "crash-exec",
		FLYWHEEL_ISSUE_ID: "FLY-1956",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_INGEST_TOKEN: "fixture-token",
		FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
	};
	const children: ChildProcess[] = [];
	const start = (...args: string[]) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				new URL("../index.ts", import.meta.url).pathname,
				...args,
			],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		children.push(child);
		return child;
	};
	try {
		const first = start("stage", "set", "implement");
		const firstExit = once(first, "exit");
		const winner = await Promise.race([
			firstPost.then(() => "posted"),
			firstExit.then(() => "exited"),
		]);
		expect(winner).toBe("posted");
		const dir = join(home, ".flywheel", "state", "stage-queue", "crash-exec");
		const file = readdirSync(dir).find((name) => name.endsWith(".json"))!;
		const original = readFileSync(join(dir, file), "utf8");
		expect(JSON.parse(original).event_id).toBe(posts[0].event_id);
		expect(original).not.toContain("fixture-token");
		first.kill("SIGKILL");
		expect(await firstExit).toEqual([null, "SIGKILL"]);
		expect(readFileSync(join(dir, file), "utf8")).toBe(original);
		const next = start("founder-time", "--json");
		let stderr = "";
		next.stderr!.on("data", (chunk) => {
			stderr += chunk;
		});
		const [code] = await once(next, "exit");
		expect(code, stderr).toBe(0);
		expect(posts).toHaveLength(2);
		expect(posts[1]).toEqual(posts[0]);
		expect(
			readdirSync(dir).filter((name) => name.endsWith(".json")),
		).toHaveLength(0);
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		}
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
}, 20000);

it("assigns unique increasing queue sequences to 20 simultaneous publisher processes", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly1956-stage-publish-"));
	const script = join(home, "publish.mts");
	writeFileSync(
		script,
		`import { enqueueStageEvent } from ${JSON.stringify(new URL("../stage-queue.ts", import.meta.url).href)};
process.send({ready:true});
process.once('message', async () => {
 try {
  await enqueueStageEvent({event_id:'publisher-'+process.pid, execution_id:'parallel-exec',issue_id:'FLY-1956',project_name:'flywheel',event_type:'stage_changed',source:'flywheel-comm',payload:{stage:'implement'}});
  process.disconnect();
 } catch(error) { console.error(error); process.exitCode=1; process.disconnect(); }
});`,
	);
	const children: ChildProcess[] = [];
	try {
		const ready = Array.from({ length: 20 }, () => {
			const child = spawn(process.execPath, ["--import", "tsx", script], {
				env: { PATH: process.env.PATH, HOME: home },
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			children.push(child);
			return once(child, "message");
		});
		const exits = children.map((child) => once(child, "exit"));
		await Promise.all(ready);
		for (const child of children) child.send({ go: true });
		expect(await Promise.all(exits)).toEqual(
			Array.from({ length: 20 }, () => [0, null]),
		);
		const dir = join(
			home,
			".flywheel",
			"state",
			"stage-queue",
			"parallel-exec",
		);
		const files = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.sort();
		expect(files).toHaveLength(20);
		expect(files.map((name) => Number(name.slice(0, 6)))).toEqual(
			Array.from({ length: 20 }, (_, index) => index + 1),
		);
		expect(
			new Set(
				files.map(
					(name) => JSON.parse(readFileSync(join(dir, name), "utf8")).event_id,
				),
			).size,
		).toBe(20);
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		}
		rmSync(home, { recursive: true, force: true });
	}
}, 30000);

it("keeps a gate behind a publisher paused before atomic publication", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly1956-stage-fence-"));
	const script = join(home, "race.mts");
	writeFileSync(
		script,
		`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { enqueueStageEvent, withStageQueueFence } from ${JSON.stringify(new URL("../stage-queue.ts", import.meta.url).href)};
if (process.argv[2] === "publish") {
 const rename = fs.renameSync;
 fs.renameSync = (from, to) => {
  if (String(to).endsWith(".json")) {
   process.send({paused:true});
   const deadline = Date.now() + 10000;
   while (!fs.existsSync(join(process.env.HOME, "release"))) {
    if (Date.now() > deadline) throw new Error("release timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
   }
  }
  return rename(from, to);
 };
 syncBuiltinESMExports();
 await enqueueStageEvent({event_id:"published-before-gate",execution_id:"race",issue_id:"FLY-1956",project_name:"flywheel",event_type:"stage_changed",source:"flywheel-comm",payload:{stage:"plan"}});
} else {
 globalThis.fetch = async (_url, init) => { process.send({posted:JSON.parse(init.body).event_id}); return new Response(JSON.stringify({ok:true,applied:true})); };
 process.send({starting:true});
 const result = await withStageQueueFence("race", {bridgeUrl:"http://bridge.invalid",headers:{}}, async () => { process.send({written:true}); });
 if (!result.settled) throw new Error("fence did not settle");
}
process.disconnect();
`,
	);
	const children: ChildProcess[] = [];
	const start = (role: string) => {
		const child = spawn(process.execPath, ["--import", "tsx", script, role], {
			env: { PATH: process.env.PATH, HOME: home },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		return child;
	};
	try {
		const publisher = start("publish");
		const publisherExit = once(publisher, "exit");
		expect((await once(publisher, "message"))[0]).toEqual({ paused: true });
		const fence = start("fence");
		const fenceExit = once(fence, "exit");
		const messages: unknown[] = [];
		fence.on("message", (message) => messages.push(message));
		expect((await once(fence, "message"))[0]).toEqual({ starting: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(messages).toEqual([{ starting: true }]);
		writeFileSync(join(home, "release"), "go");
		expect(await publisherExit).toEqual([0, null]);
		expect(await fenceExit).toEqual([0, null]);
		expect(messages).toEqual([
			{ starting: true },
			{ posted: "published-before-gate" },
			{ written: true },
		]);
	} finally {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		rmSync(home, { recursive: true, force: true });
	}
}, 20000);
