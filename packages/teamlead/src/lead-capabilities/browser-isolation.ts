import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
	browserCredentialProbeRoot,
	type buildBrowserSandboxSpec,
} from "./browser-sandbox.js";

const unproven = () => new Error("browser_isolation_unproven");
// Fixed trusted program; only synthetic paths/ports/nonce are passed as data.
const PROBE = `
const fs=require('node:fs'),net=require('node:net'),p=JSON.parse(process.argv[1]);
const denied=e=>e && ['EACCES','EPERM'].includes(e.code);
const attempt=f=>{try{f();return false;}catch(e){return denied(e);}};
const connect=port=>new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const done=v=>{s.destroy();resolve(v);};s.once('connect',()=>done('connected'));s.once('error',e=>done(denied(e)?'denied':'unknown'));s.setTimeout(1500,()=>done('unknown'));});
const listen=()=>new Promise(resolve=>{const s=net.createServer();s.once('error',e=>resolve(denied(e)));s.listen(0,'127.0.0.1',()=>s.close(()=>resolve(false)));});
(async()=>{
 let writable=false;try{fs.writeFileSync(p.scratch,'ok',{flag:'wx'});fs.unlinkSync(p.scratch);writable=true;}catch{}
 const result={nonce:p.nonce,writable,readDenied:attempt(()=>fs.readFileSync(p.secret)),symlinkDenied:attempt(()=>fs.readFileSync(p.link)),writeDenied:attempt(()=>fs.writeFileSync(p.outside,'forbidden',{flag:'wx'})),proxyAllowed:(await connect(p.proxyPort))==='connected',privateDenied:(await connect(p.privatePort))==='denied',listenDenied:await listen()};
 process.stdout.write(JSON.stringify(result));
})().catch(()=>process.exit(1));
`;
/** Real Seatbelt file/network probes against the exact worker policy and env.
 * This proves these probes only; Chrome compatibility and broader model canaries
 * remain separate deployment requirements. Never reads existing credential data. */
export async function verifyBrowserIsolation(
	launch: ReturnType<typeof buildBrowserSandboxSpec>,
	options: { proxyPort: number },
): Promise<void> {
	if (
		launch.command !== "/usr/bin/sandbox-exec" ||
		launch.args[0] !== "-p" ||
		launch.args[1] !== launch.policy ||
		!launch.args[2] ||
		!Number.isInteger(options.proxyPort) ||
		options.proxyPort < 1024 ||
		options.proxyPort > 65535
	)
		throw unproven();
	const outer = browserCredentialProbeRoot(realpathSync(launch.cwd));
	// The final policy denies this exact sibling, which the worker cannot write.
	// Exclusive mkdir rejects a pre-existing directory or symlink; never reuse it.
	mkdirSync(outer, { mode: 0o700 });
	let inner: string | undefined;
	const server = createServer((socket) => socket.end());
	try {
		const qaRoot = realpathSync(launch.cwd);
		if (outer === qaRoot || outer.startsWith(`${qaRoot}/`)) throw unproven();
		inner = mkdtempSync(join(qaRoot, "isolation-"));
		const secret = join(outer, "synthetic-credential"),
			link = join(inner, "link");
		writeFileSync(secret, randomUUID(), { mode: 0o600, flag: "wx" });
		symlinkSync(secret, link);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw unproven();
		const nonce = randomUUID();
		const data = {
			nonce,
			secret,
			link,
			scratch: join(inner, "scratch"),
			outside: join(outer, "write"),
			proxyPort: options.proxyPort,
			privatePort: address.port,
		};
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(
				launch.command,
				[
					"-p",
					launch.policy,
					launch.args[2]!,
					"-e",
					PROBE,
					JSON.stringify(data),
				],
				{
					cwd: launch.cwd,
					env: { ...launch.env },
					stdio: ["ignore", "pipe", "pipe"],
					shell: false,
				},
			);
			let output = "",
				exceeded = false;
			const timer = setTimeout(() => {
				exceeded = true;
				child.kill("SIGKILL");
			}, 5000);
			child.stderr.resume();
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (Buffer.byteLength(output) > 4096) {
					exceeded = true;
					child.kill("SIGKILL");
				}
			});
			child.once("error", () => {
				clearTimeout(timer);
				reject(unproven());
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (code !== 0 || exceeded) reject(unproven());
				else resolve(output);
			});
		});
		const result = JSON.parse(output) as Record<string, unknown>;
		const checks = [
			"writable",
			"readDenied",
			"symlinkDenied",
			"writeDenied",
			"proxyAllowed",
			"privateDenied",
			"listenDenied",
		];
		if (
			result.nonce !== nonce ||
			Object.keys(result).length !== checks.length + 1 ||
			checks.some((key) => result[key] !== true)
		)
			throw unproven();
	} catch {
		throw unproven();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (inner) rmSync(inner, { recursive: true, force: true });
		rmSync(outer, { recursive: true, force: true });
	}
}
