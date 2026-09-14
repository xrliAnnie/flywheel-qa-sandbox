import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

for (const lane of ["mode", "startup"]) {
	test(`${lane} synchronous SQLite failure survives and next timer tick runs`, () => {
		const plugin = readFileSync(
			new URL("../../packages/teamlead/src/bridge/plugin.ts", import.meta.url),
			"utf8",
		);
		const start = plugin.indexOf(
			"\n\tif (!process.env.VITEST) {",
			plugin.indexOf("\n\tgatePoller.start();"),
		);
		const end = plugin.indexOf(
			"\n\ttry {\n\t\tconst activateWakeHolder",
			start,
		);
		assert.ok(start > 0 && end > start, "production startup boundary exists");
		const block = plugin.slice(start, end);
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
import { StateStore } from './packages/teamlead/dist/StateStore.js';
import { ShipJudgmentRuntime } from './packages/teamlead/dist/ship-judgment/runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'judgment-timer-'));
const store=await StateStore.create(join(root,'test.db'));
let calls=0, failed=false; const errors=[];
const runtime=new ShipJudgmentRuntime({store,owner:'test',mode:()=>{calls++; if (${JSON.stringify(lane)}==='mode' && calls===4) {failed=true; throw new Error('SQLITE_BUSY');} return 'off';},collect:async()=>null,evaluate:async()=>null,material(){},unavailable(){},onError:code=>errors.push(code)});
const shipJudgmentRuntime=${JSON.stringify(lane)}==='startup'?{start(){failed=true; throw new Error('SQLITE_BUSY');}}:runtime;
const shipJudgmentHistoryRuntime={start(){runtime.start();}};
${lane === "startup" ? block : "runtime.start();"}
await new Promise(resolve=>setTimeout(resolve,6500));
await runtime.stop(); store.close(); rmSync(root,{recursive:true,force:true});
console.log(JSON.stringify({failed,calls,errors}));
`,
			],
			{ encoding: "utf8", timeout: 15000, env: { ...process.env, VITEST: "" } },
		);
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
		assert.equal(result.failed, true);
		assert.ok(result.calls >= 5);
		if (lane === "mode") assert.ok(result.errors.includes("mode_read_failed"));
		else assert.match(child.stderr, /mode_read_failed/);
	});
}
