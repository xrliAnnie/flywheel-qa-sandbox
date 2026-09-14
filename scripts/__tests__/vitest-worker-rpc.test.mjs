import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
const pkgPath = require.resolve("vitest/package.json");
const rootPackage = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url)),
);
const chunks = join(dirname(pkgPath), "dist/chunks");
const rpcPath = join(
	chunks,
	readdirSync(chunks).find((name) => /^rpc\..*\.js$/.test(name)),
);

test("pinned Vitest worker RPC patch is registered and installed; upgrades fail explicitly", () => {
	assert.equal(JSON.parse(readFileSync(pkgPath)).version, "3.2.4");
	assert.equal(
		rootPackage.pnpm.patchedDependencies["vitest@3.2.4"],
		"patches/vitest@3.2.4.patch",
	);
	assert.match(readFileSync(rpcPath, "utf8"), /timeout: 120_000/);
});

test("real worker RPC waits 120 seconds and still rejects an unanswered onTaskUpdate", () => {
	const run = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
    import assert from 'node:assert/strict';
    const timers=[];
    globalThis.setTimeout=(fn,ms)=>{const timer={fn,ms,unref(){return this}};timers.push(timer);return timer};
    globalThis.clearTimeout=()=>{};
    const {c:createRuntimeRpc}=await import(${JSON.stringify(pathToFileURL(rpcPath).href)});
    const {rpc}=createRuntimeRpc({post(){},on(){}});
    const result=rpc.onTaskUpdate([]);
    const rejection=assert.rejects(result, {message:'[vitest-worker]: Timeout calling "onTaskUpdate"'});
    assert.equal(timers.length,1);
    assert.equal(timers[0].ms,120_000);
    timers[0].fn();
    await rejection;
  `,
		],
		{ encoding: "utf8" },
	);
	assert.equal(run.status, 0, run.stderr);
});
