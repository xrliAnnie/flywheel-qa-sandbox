#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 200;

function usageError() {
	console.error(
		"[qa-report-host] usage: qa-report-host.mjs --root <dir> --expected-parent <pid>",
	);
	process.exit(64);
}

const args = process.argv.slice(2);
if (
	args.length !== 4 ||
	args[0] !== "--root" ||
	args[2] !== "--expected-parent"
) {
	usageError();
}
const root = args[1];
const expectedParent = Number(args[3]);
if (!root || !Number.isSafeInteger(expectedParent) || expectedParent <= 0) {
	usageError();
}
if (process.ppid !== expectedParent) process.exit(66); // PARENT_GUARD_START

function configurationError(message) {
	console.error(`[qa-report-host] ${message}`);
	process.exit(64);
}

let rootReal;
try {
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		configurationError("root must be a real directory");
	}
	rootReal = realpathSync(root);
} catch {
	configurationError("root must be a real directory");
}

const tokenPath = resolve(rootReal, "token");
let token;
try {
	const tokenStat = lstatSync(tokenPath);
	if (
		tokenStat.isSymbolicLink() ||
		!tokenStat.isFile() ||
		(tokenStat.mode & 0o777) !== 0o600
	) {
		configurationError("token must be a 0600 regular file");
	}
	const rawToken = readFileSync(tokenPath, "utf8");
	if (!/^[^\r\n]+\n?$/.test(rawToken)) {
		configurationError("token must contain exactly one non-empty line");
	}
	token = rawToken.endsWith("\n") ? rawToken.slice(0, -1) : rawToken;
} catch {
	configurationError("token must be a 0600 regular file");
}

const sitesRoot = resolve(rootReal, "sites");
try {
	if (existsSync(sitesRoot)) {
		const sitesStat = lstatSync(sitesRoot);
		if (sitesStat.isSymbolicLink() || !sitesStat.isDirectory()) {
			configurationError("sites must be a real directory");
		}
	} else {
		mkdirSync(sitesRoot, { mode: 0o700 });
	}
	if (dirname(realpathSync(sitesRoot)) !== rootReal) {
		configurationError("sites must live directly under root");
	}
} catch {
	configurationError("sites must be a real directory under root");
}

function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}

function authorized(req) {
	return req.headers.authorization === `Bearer ${token}`;
}

function decodedPath(req) {
	const rawPath = (req.url ?? "/").split("?", 1)[0];
	let decoded;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return undefined;
	}
	if (
		decoded.includes("\\") ||
		decoded.includes("\0") ||
		decoded.split("/").includes("..")
	) {
		return undefined;
	}
	return decoded;
}

function validDeployment(body) {
	if (
		!body ||
		typeof body !== "object" ||
		!Object.hasOwn(body, "name") ||
		typeof body.name !== "string" ||
		!/^[a-z0-9-]{1,64}$/.test(body.name) ||
		body.target !== "production" ||
		!Array.isArray(body.files) ||
		body.files.length === 0 ||
		body.files.length > MAX_FILES
	) {
		return false;
	}
	const paths = new Set();
	for (const file of body.files) {
		if (
			!file ||
			typeof file !== "object" ||
			typeof file.file !== "string" ||
			typeof file.data !== "string" ||
			file.encoding !== "utf-8" ||
			file.file.length === 0 ||
			file.file.startsWith("/") ||
			file.file.includes("\\") ||
			file.file.includes("\0") ||
			file.file.split("/").includes("..") ||
			paths.has(file.file)
		) {
			return false;
		}
		paths.add(file.file);
	}
	return true;
}

let deploySequence = 0;
const deploymentIds = new Set();
let deployChain = Promise.resolve();

async function readJsonBody(req, res) {
	return new Promise((resolveBody) => {
		const chunks = [];
		let bytes = 0;
		let settled = false;
		req.on("data", (chunk) => {
			if (settled) return;
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				settled = true;
				writeJson(res, 413, { error: "request body too large" });
				req.destroy();
				resolveBody(undefined);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			try {
				resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				writeJson(res, 400, { error: "invalid JSON" });
				resolveBody(undefined);
			}
		});
		req.on("aborted", () => {
			if (!settled) {
				settled = true;
				resolveBody(undefined);
			}
		});
	});
}

function installDeployment(body) {
	const suffix = `${++deploySequence}-${randomBytes(4).toString("hex")}`;
	const staging = resolve(sitesRoot, `.staging-${body.name}-${suffix}`);
	const previous = resolve(sitesRoot, `.prev-${body.name}-${suffix}`);
	const destination = resolve(sitesRoot, body.name);
	let movedPrevious = false;
	mkdirSync(staging, { mode: 0o700 });
	try {
		for (const file of body.files) {
			const destinationFile = resolve(staging, file.file);
			const rel = relative(staging, destinationFile);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error("invalid file containment");
			}
			mkdirSync(dirname(destinationFile), { recursive: true, mode: 0o700 });
			writeFileSync(destinationFile, file.data, { mode: 0o600 });
		}
		if (existsSync(destination)) {
			const destinationStat = lstatSync(destination);
			if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
				throw new Error("destination is not a real directory");
			}
			renameSync(destination, previous);
			movedPrevious = true;
		}
		renameSync(staging, destination);
		if (movedPrevious) rmSync(previous, { recursive: true, force: true });
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		if (movedPrevious && !existsSync(destination) && existsSync(previous)) {
			renameSync(previous, destination);
		}
		throw error;
	}

	const id = `dpl_${randomBytes(6).toString("hex")}`;
	deploymentIds.add(id);
	return id;
}

async function handleDeployment(req, res) {
	if (!authorized(req)) {
		writeJson(res, 401, { error: "unauthorized" });
		return;
	}
	const body = await readJsonBody(req, res);
	if (body === undefined || res.writableEnded) return;
	if (!validDeployment(body)) {
		writeJson(res, 400, { error: "invalid deployment" });
		return;
	}

	const run = deployChain.then(() => installDeployment(body));
	deployChain = run.then(
		() => undefined,
		() => undefined,
	);
	try {
		const id = await run;
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		writeJson(res, 200, {
			id,
			url: `http://127.0.0.1:${port}/${body.name}`,
			readyState: "READY",
		});
	} catch {
		writeJson(res, 500, { error: "deployment failed" });
	}
}

function serveStatic(pathname, res) {
	const requested = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
	const candidate = resolve(sitesRoot, `.${requested}`);
	const rel = relative(sitesRoot, candidate);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		writeJson(res, 404, { error: "not found" });
		return;
	}
	try {
		const realCandidate = realpathSync(candidate);
		const realRel = relative(realpathSync(sitesRoot), realCandidate);
		const stat = lstatSync(realCandidate);
		if (
			!realRel ||
			realRel.startsWith("..") ||
			isAbsolute(realRel) ||
			stat.isSymbolicLink() ||
			!stat.isFile()
		) {
			throw new Error("not a contained file");
		}
		res.writeHead(200, {
			"content-type": realCandidate.endsWith(".html")
				? "text/html; charset=utf-8"
				: "text/plain; charset=utf-8",
		});
		res.end(readFileSync(realCandidate));
	} catch {
		writeJson(res, 404, { error: "not found" });
	}
}

const server = createServer(async (req, res) => {
	const pathname = decodedPath(req);
	if (!pathname) {
		writeJson(res, 404, { error: "not found" });
		return;
	}
	if (req.method === "POST" && pathname === "/v13/deployments") {
		await handleDeployment(req, res);
		return;
	}
	if (req.method === "GET" && pathname === "/v13/deployments/self-check") {
		if (!authorized(req)) {
			writeJson(res, 401, { error: "unauthorized" });
			return;
		}
		writeJson(res, 200, {});
		return;
	}
	if (req.method === "GET" && pathname.startsWith("/v13/deployments/")) {
		if (!authorized(req)) {
			writeJson(res, 401, { error: "unauthorized" });
			return;
		}
		const id = pathname.slice("/v13/deployments/".length);
		if (!deploymentIds.has(id)) {
			writeJson(res, 404, { error: "not found" });
			return;
		}
		writeJson(res, 200, { readyState: "READY" });
		return;
	}
	if (req.method === "GET") {
		serveStatic(pathname, res);
		return;
	}
	writeJson(res, 404, { error: "not found" });
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;

function probe(port) {
	return new Promise((resolveProbe, rejectProbe) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path: "/v13/deployments/self-check",
				headers: { Authorization: `Bearer ${token}` },
			},
			(res) => {
				res.resume();
				res.once("end", () =>
					res.statusCode === 200
						? resolveProbe()
						: rejectProbe(new Error("self-check failed")),
				);
			},
		);
		req.once("error", rejectProbe);
		req.end();
	});
}

function shutdown(code = 0) {
	server.close(() => process.exit(code));
	setTimeout(() => process.exit(code), 1_000).unref();
}
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
server.once("error", () => process.exit(70));

server.listen(0, "127.0.0.1", async () => {
	try {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		await probe(port);
		const temporaryPortPath = resolve(rootReal, `port.tmp.${process.pid}`);
		writeFileSync(temporaryPortPath, `${port}\n`, { mode: 0o600 });
		chmodSync(temporaryPortPath, 0o600);
		renameSync(temporaryPortPath, resolve(rootReal, "port"));
	} catch {
		shutdown(70);
	}
});

setInterval(() => {
	if (process.ppid !== expectedParent) process.exit(0); // PARENT_GUARD_POLL
}, 500);
