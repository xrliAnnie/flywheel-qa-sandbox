import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { startGuardedProviderProcess } from "../provider-process.js";

it("spawns a pinned child with fixed argv and clean environment, then confirms its exact exit", async () => {
	const root = mkdtempSync("/tmp/xhs-process-");
	const source = join(root, "probe.c"),
		binary = join(root, "probe"),
		policy = join(root, "policy.json");
	writeFileSync(
		source,
		`#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <signal.h>\n#include <unistd.h>\nstatic void done(int s){(void)s;_exit(0);}\nint main(int argc,char **argv){if(argc!=3||strcmp(argv[1],"-guarded-config"))return 2;char out[4096];snprintf(out,sizeof(out),"%s.observed",argv[2]);signal(SIGTERM,done);FILE *f=fopen(out,"w");if(!f)return 3;fprintf(f,"%d",getenv("NODE_OPTIONS")==NULL && getenv("HTTP_PROXY")==NULL && getenv("HOME")==NULL);fclose(f);for(;;)pause();}`,
	);
	execFileSync("cc", [source, "-o", binary]);
	writeFileSync(policy, "{}");
	const pin = (path: string) => ({
		path,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	});
	const input = {
		serviceUid: process.getuid!(),
		serviceGid: process.getgid!(),
		providerBinary: pin(binary),
		providerConfig: pin(policy),
	};
	let child:
		| Awaited<ReturnType<typeof startGuardedProviderProcess>>
		| undefined;
	try {
		await expect(
			startGuardedProviderProcess({
				...input,
				providerBinary: { ...input.providerBinary, sha256: "0".repeat(64) },
			}),
		).rejects.toThrow("provider_process_unavailable");
		expect(existsSync(`${policy}.observed`)).toBe(false);
		child = await startGuardedProviderProcess(input);
		for (let n = 0; n < 100 && !existsSync(`${policy}.observed`); n++)
			await delay(10);
		expect(readFileSync(`${policy}.observed`, "utf8")).toBe("1");
		await child.stop();
		await child.stop();
		expect(await child.exited).toEqual({ code: 0, signal: null });
		expect(() => process.kill(child!.pid, 0)).toThrow();
	} finally {
		if (child) await child.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
it("rejects a process principal mismatch before spawning", async () => {
	await expect(
		startGuardedProviderProcess({
			serviceUid: process.getuid!() + 1,
			serviceGid: process.getgid!(),
			providerBinary: { path: "/absent", sha256: "a".repeat(64) },
			providerConfig: { path: "/absent-policy", sha256: "b".repeat(64) },
		}),
	).rejects.toThrow("provider_process_unavailable");
});
it("reports abnormal child exit as unconfirmed cleanup instead of a successful stop", async () => {
	const root = mkdtempSync("/tmp/xhs-process-exit-");
	try {
		const source = join(root, "exit.c"),
			binary = join(root, "exit"),
			policy = join(root, "policy.json");
		writeFileSync(source, "int main(void){return 7;}");
		execFileSync("cc", [source, "-o", binary]);
		writeFileSync(policy, "{}");
		const pin = (path: string) => ({
			path,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		});
		const child = await startGuardedProviderProcess({
			serviceUid: process.getuid!(),
			serviceGid: process.getgid!(),
			providerBinary: pin(binary),
			providerConfig: pin(policy),
		});
		expect(await child.exited).toEqual({ code: 7, signal: null });
		await expect(child.stop()).rejects.toThrow("provider_stop_unconfirmed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
