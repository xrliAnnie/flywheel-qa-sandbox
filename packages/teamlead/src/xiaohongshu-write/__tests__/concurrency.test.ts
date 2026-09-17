import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { fixture, NOW } from "./store-fixture.js";

it("claims once across independent processes released at the same barrier", async () => {
	const f = fixture();
	const children: ChildProcess[] = [];
	try {
		f.approve();
		const worker = join(dirname(f.path), "claim-worker.mjs");
		const moduleUrl = new URL("../store.ts", import.meta.url).href;
		writeFileSync(
			worker,
			`import { XhsWriteStore } from ${JSON.stringify(moduleUrl)};
   const store = new XhsWriteStore(process.argv[2], {providerGeneration:'generation-a'});
   process.send({kind:'ready'});
   process.once('message', request => {
    try { process.send(store.claim(request, ${NOW + 3000})); }
    finally { store.close(); process.disconnect(); }
   });`,
		);
		const starts = [0, 1].map(async () => {
			const child = spawn(
				process.execPath,
				["--import", "tsx", worker, f.path],
				{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
			);
			children.push(child);
			let errorText = "";
			child.stderr?.on("data", (bytes) => {
				errorText += String(bytes);
			});
			const ready = await Promise.race([
				once(child, "message"),
				once(child, "exit").then(() => {
					throw Error(errorText || "worker exited before ready");
				}),
			]);
			expect(ready[0]).toEqual({ kind: "ready" });
			return child;
		});
		const ready = await Promise.all(starts);
		const results = ready.map((child) => once(child, "message"));
		const exits = ready.map((child) => once(child, "exit"));
		for (const [index, child] of ready.entries())
			child.send({ ...f.request, executeRequestId: `process-${index}` });
		const claims = (await Promise.all(results)).map(
			([result]) => result as { kind: string },
		);
		expect(claims.map((result) => result.kind).sort()).toEqual([
			"claimed",
			"existing",
		]);
		expect(await Promise.all(exits)).toEqual([
			[0, null],
			[0, null],
		]);
		f.restart();
		expect(
			f.store.claim(
				{ ...f.request, executeRequestId: "after-restart" },
				NOW + 4000,
			).kind,
		).toBe("existing");
		const db = new Database(f.path, { readonly: true });
		try {
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM xhs_write_attempt").get(),
			).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		f.close();
	}
}, 30_000);
