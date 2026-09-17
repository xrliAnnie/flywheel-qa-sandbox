import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("moves two real listening Unix sockets to fd3/fd4 and serves both through inherited Node listeners", async () => {
	const root = mkdtempSync("/tmp/xhs-launcher-");
	try {
		const source = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-authority-launcher.c",
				import.meta.url,
			),
		);
		const harness = join(root, "harness.c"),
			binary = join(root, "harness");
		writeFileSync(
			harness,
			`
#define main launcher_main
#include "${source}"
#undef main
static int listener(const char *path) {
 int fd=socket(AF_UNIX,SOCK_STREAM,0); struct sockaddr_un address={0}; address.sun_family=AF_UNIX;
 if(fd<0 || strlen(path)>=sizeof(address.sun_path)) return -1;
 strcpy(address.sun_path,path);
 if(bind(fd,(struct sockaddr*)&address,sizeof(address)) || listen(fd,8)) return -1;
 return fd;
}
int main(int argc,char **argv) {
 if(argc==4 && !strcmp(argv[1],"--verify-listeners")) return launcher_main(argc,argv);
 if(argc<4) return 2;
 int a=listener(argv[2]), b=listener(argv[3]);
 if(a<0||b<0) return 3;
 if(!strcmp(argv[1],"alias")) return xhs_adopt_listeners(a,a)==0?4:0;
 if(!strcmp(argv[1],"tcp")) { int tcp=socket(AF_INET,SOCK_STREAM,0); return xhs_adopt_listeners(a,tcp)==0?5:0; }
 if(xhs_adopt_listeners(b,a)) { struct sockaddr_un aa,bb; int va=listener_name(a,&aa), vb=listener_name(b,&bb); fprintf(stderr,"fds=%d,%d valid=%d,%d errno=%d\\n",a,b,va,vb,errno); return 6; }
 struct sockaddr_un pub={0},priv={0}; socklen_t n=sizeof(pub);
 if(getsockname(3,(struct sockaddr*)&pub,&n)) return 7;
 n=sizeof(priv); if(getsockname(4,(struct sockaddr*)&priv,&n)) return 8;
 if(strcmp(pub.sun_path,argv[3])||strcmp(priv.sun_path,argv[2])) return 9;
 if((fcntl(3,F_GETFD)&FD_CLOEXEC)||(fcntl(4,F_GETFD)&FD_CLOEXEC)) return 10;
 if(!strcmp(argv[1],"exec")) {execv(argv[4],&argv[4]);return 11;}
 return 0;
}
`,
		);
		execFileSync("cc", [
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			harness,
			"-o",
			binary,
		]);
		for (const mode of ["swap", "alias", "tcp"]) {
			const result = spawnSync(binary, [
				mode,
				join(root, `${mode}-a.sock`),
				join(root, `${mode}-b.sock`),
			]);
			expect(result.status, result.stderr.toString()).toBe(0);
		}
		const entry = join(root, "entry.mts");
		const listenerSource = fileURLToPath(
			new URL("../inherited-listeners.ts", import.meta.url),
		);
		const a = join(root, "exec-a.sock"),
			b = join(root, "exec-b.sock");
		writeFileSync(
			entry,
			`import assert from "node:assert/strict";
import { startInheritedAuthorityListeners } from ${JSON.stringify(listenerSource)};
let release;
const held = new Promise(resolve => { release = resolve; });
let active = false;
const options = { launcher: ${JSON.stringify({ path: binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") })}, ingressPath: ${JSON.stringify(b)}, authorityPath: ${JSON.stringify(a)}, ingress: async (req,res)=>{ if(req.url === "/drain") { active = true; res.end("held"); await held; active = false; } else res.end("ingress"); }, authority: (_,res)=>res.end("authority") };
await assert.rejects(startInheritedAuthorityListeners({...options, ingressPath: options.authorityPath, authorityPath: options.ingressPath}), /authority_listener_unavailable/);
await assert.rejects(startInheritedAuthorityListeners({...options, launcher: {...options.launcher, sha256: "0".repeat(64)}}), /authority_listener_unavailable/);
const listener = await startInheritedAuthorityListeners(options);
process.on("SIGTERM", async()=>{
  assert.equal(active, true);
  let closed = false;
  const closing = listener.close().then(()=>{closed = true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed, false, "listener close must wait for handler after response/socket closes");
  release();
  await closing;
  assert.equal(active, false);
  await listener.close();
  process.exit(0);
});
process.stdout.write("ready\\n");
`,
		);
		const child = spawn(
			binary,
			[
				"exec",
				a,
				b,
				process.execPath,
				"--import",
				createRequire(import.meta.url).resolve("tsx"),
				entry,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const deadline = AbortSignal.timeout(10000);
		try {
			const ready = once(child.stdout, "data", { signal: deadline });
			const stopped = once(child, "exit", { signal: deadline }).then(() => {
				throw Error(stderr || "listener stopped");
			});
			await Promise.race([ready, stopped]);
			const get = (socketPath: string, path = "/") =>
				new Promise<string>((resolve, reject) => {
					const req = request({ socketPath, path, signal: deadline }, (res) => {
						let body = "";
						res.on("data", (chunk) => {
							body += chunk;
						});
						res.on("end", () => resolve(body));
					});
					req.on("error", reject);
					req.end();
				});
			expect(await get(b)).toBe("ingress");
			expect(await get(a)).toBe("authority");
			expect(await get(b, "/drain")).toBe("held");
		} finally {
			if (child.exitCode === null) {
				const ended = once(child, "exit");
				child.kill("SIGTERM");
				await ended;
			}
		}
		expect(child.exitCode, stderr).toBe(0);
		expect(existsSync(a)).toBe(true);
		expect(existsSync(b)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
