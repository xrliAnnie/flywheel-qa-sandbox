import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EGRESS_PROBE_URL_PREFIX } from "./browser-egress-proxy.js";
import { buildLeadModelEnv, type LeadModelEnvPins } from "./model-env.js";
import {
	LEAD_PERMISSION_PROFILE,
	leadModelWritableRoot,
} from "./permission-profile.js";

export interface ModelIsolationOptions {
	codexExecutable: string;
	nodeExecutable: string;
	pins: LeadModelEnvPins;
	projectRoot: string;
	deploymentRoot: string;
	credentialProbePath: string;
	proxyPort: number;
	/** The activation egress proxy's record of answered chain probes (consumed). */
	egressProbeSeen(nonce: string): boolean;
	env: NodeJS.ProcessEnv;
	assertCurrent(): void | Promise<void>;
}

const unproven = () => new Error("model_isolation_unproven");
// Fixed trusted program; only synthetic paths/ports/nonce are passed as data.
// Codex (>=0.153) starts its own managed proxy for the sandbox and announces it
// in HTTP_PROXY; that loopback proxy is the only permitted egress (FLY-2886).
// OPENSSL_CONF is the parent-pinned file every sandboxed node reads at startup.
// The chain probe goes through that managed proxy; only the activation egress
// proxy (its upstream) answers it, so it proves the upstream hop is in the path.
const PROBE = `
const fs=require('node:fs'),net=require('node:net'),p=JSON.parse(process.argv[1]);
const denied=e=>e && ['EACCES','EPERM'].includes(e.code);
const attempt=f=>{try{f();return false;}catch(e){return denied(e);}};
const succeeds=f=>{try{f();return true;}catch{return false;}};
const writeDenied=path=>{try{fs.writeFileSync(path,'probe',{flag:'wx'});}catch(e){return denied(e);}try{fs.unlinkSync(path);}catch{}return false;};
const connect=port=>new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const done=v=>{s.destroy();resolve(v);};s.once('connect',()=>done('connected'));s.once('error',e=>done(denied(e)?'denied':'unknown'));s.setTimeout(1500,()=>done('unknown'));});
const listen=()=>new Promise(resolve=>{const s=net.createServer();s.once('error',e=>resolve(denied(e)));s.listen(0,'127.0.0.1',()=>s.close(()=>resolve(false)));});
const chained=(port)=>new Promise(resolve=>{const req=require('node:http').request({host:'127.0.0.1',port,method:'GET',path:p.egressProbeUrl,headers:{host:'example.com',connection:'close'},agent:false},res=>{res.resume();resolve(res.statusCode===204);});req.once('error',()=>resolve(false));req.setTimeout(8000,()=>{req.destroy();resolve(false);});req.end();});
const sandboxProxy=()=>{try{const u=new URL(process.env.HTTP_PROXY);const port=Number(u.port);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number.isInteger(port)&&port>0?port:undefined;}catch{return undefined;}};
(async()=>{
 let writable=false;try{fs.writeFileSync(p.scratch,'ok',{flag:'wx'});fs.unlinkSync(p.scratch);writable=true;}catch{}
 const proxy=sandboxProxy();
 const result={nonce:p.nonce,writable,readDenied:attempt(()=>fs.readFileSync(p.secret)),credentialDenied:attempt(()=>fs.readFileSync(p.credential)),symlinkDenied:attempt(()=>fs.readFileSync(p.link)),writeDenied:writeDenied(p.outside),artifactWriteDenied:writeDenied(p.artifact),deploymentWriteDenied:writeDenied(p.deployment),proxyAllowed:proxy!==undefined&&(await connect(proxy))==='connected',privateDenied:(await connect(p.privatePort))==='denied',listenDenied:await listen(),opensslConfRead:process.env.OPENSSL_CONF===p.opensslConf&&succeeds(()=>fs.readFileSync(p.opensslConf)),egressChained:proxy!==undefined&&await chained(proxy),cryptoReady:succeeds(()=>{if(require('node:crypto').randomBytes(1).length!==1)throw new Error();})};
 process.stdout.write(JSON.stringify(result));
})().catch(()=>process.exit(1));
`;
/** Executes fixed synthetic file/network probes with Codex's actual named profile.
 * Failure to launch or incomplete evidence is not confinement proof. This does
 * not cover keychain/process inspection, browser isolation, or QA acceptance. */
export async function verifyModelIsolation(
	options: ModelIsolationOptions,
): Promise<void> {
	const unconfinedPaths = [
		options.codexExecutable,
		options.nodeExecutable,
		options.credentialProbePath,
		options.pins.opensslConf ?? "",
	];
	if (
		unconfinedPaths.some((p) => !isAbsolute(p)) ||
		!Number.isInteger(options.proxyPort) ||
		options.proxyPort < 1024 ||
		options.proxyPort > 65535
	)
		throw unproven();
	await options.assertCurrent();
	const credential = realpathSync(options.credentialProbePath);
	if (!lstatSync(credential).isFile()) throw unproven();
	const writableRoot = realpathSync(leadModelWritableRoot(options));
	const scratchRoot = realpathSync(options.pins.modelTempRoot);
	if (!scratchRoot.startsWith(`${writableRoot}/`)) throw unproven();
	const env = buildLeadModelEnv(options.env, options.pins);

	const outer = realpathSync(mkdtempSync(join(tmpdir(), "model-isolation-")));
	let inner: string | undefined;
	const server = createServer((socket) => socket.end());
	try {
		const qaRoot = scratchRoot;
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
		const probeNonce = randomUUID();
		const data = {
			nonce,
			secret,
			credential,
			link,
			scratch: join(inner, "scratch"),
			outside: join(outer, "write"),
			artifact: join(options.pins.artifactRoot, `isolation-${nonce}`),
			deployment: join(options.deploymentRoot, `isolation-${nonce}`),
			privatePort: address.port,
			opensslConf: options.pins.opensslConf,
			egressProbeUrl: `${EGRESS_PROBE_URL_PREFIX}${probeNonce}`,
		};
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(
				options.codexExecutable,
				[
					"sandbox",
					"--permission-profile",
					LEAD_PERMISSION_PROFILE,
					"--cd",
					options.projectRoot,
					"--",
					options.nodeExecutable,
					"-e",
					PROBE,
					JSON.stringify(data),
				],
				{
					cwd: options.projectRoot,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					shell: false,
					detached: true,
				},
			);
			let output = "",
				exceeded = false;
			const timer = setTimeout(() => {
				exceeded = true;
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				}
			}, 15_000);
			child.stderr.resume();
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (Buffer.byteLength(output) > 4096) {
					exceeded = true;
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
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
			"credentialDenied",
			"symlinkDenied",
			"writeDenied",
			"artifactWriteDenied",
			"deploymentWriteDenied",
			"proxyAllowed",
			"privateDenied",
			"listenDenied",
			"opensslConfRead",
			"egressChained",
			"cryptoReady",
		];
		if (
			result.nonce !== nonce ||
			Object.keys(result).length !== checks.length + 1 ||
			checks.some((key) => result[key] !== true) ||
			// The activation egress proxy itself must have answered this nonce.
			!options.egressProbeSeen(probeNonce)
		)
			throw unproven();
		await options.assertCurrent();
	} catch {
		throw unproven();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (inner) rmSync(inner, { recursive: true, force: true });
		rmSync(outer, { recursive: true, force: true });
	}
}
