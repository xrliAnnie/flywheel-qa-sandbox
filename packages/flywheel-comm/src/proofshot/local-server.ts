/**
 * GEO-151 ProofShot — local HTTP server for 3D model serving.
 *
 * 3dviewer.net (the default 3D viewer) cannot fetch `file://` URLs. The
 * Runner-provided model path is local (`~/Dev/GeoForge3D/output/foo.glb`)
 * so we serve it over loopback HTTP.
 *
 * Security: only the directory containing the model file is served, and
 * only `basename(modelPath)` is served — any other path returns 403. This
 * prevents path traversal (`/../../etc/passwd`) and keeps the surface area
 * one file.
 *
 * Built-in `http.createServer` + `fs.createReadStream` — no `serve-static`
 * dependency (would be a new package add, Codex R5 caught this).
 *
 * Returns a `{ url, close }` handle. ALWAYS call `close()` in a finally
 * block so the port + listener don't leak across captures.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname } from "node:path";

export interface LocalModelServerHandle {
	/** Loopback URL the viewer should load (e.g., `http://127.0.0.1:8080/model.glb`). */
	url: string;
	/** Picked port. */
	port: number;
	/** Underlying Node http.Server (for tests). */
	server: Server;
	/** Shut down the listener. Idempotent. */
	close(): Promise<void>;
}

/**
 * Start a localhost HTTP server that serves only `basename(modelPath)` from
 * `dirname(modelPath)`. Other requests return 403.
 *
 * @param modelPath - Absolute path to the model file.
 * @param port - Optional preferred port. If omitted, the OS picks a free one
 *               (passing 0 to `listen()`).
 */
export async function startLocalModelServer(
	modelPath: string,
	port?: number,
): Promise<LocalModelServerHandle> {
	if (!existsSync(modelPath)) {
		throw new Error(
			`startLocalModelServer: model file not found: ${modelPath}`,
		);
	}
	const stat = statSync(modelPath);
	if (!stat.isFile()) {
		throw new Error(
			`startLocalModelServer: model path is not a regular file: ${modelPath}`,
		);
	}
	const allowedBasename = basename(modelPath);
	const docroot = dirname(modelPath);

	const server = createServer((req, res) => {
		try {
			const url = req.url ?? "/";
			// Strip query string + leading slash; reject any path that contains
			// '/' or '..' or starts with '.' (hidden file).
			const pathOnly = url.split("?")[0] ?? "";
			const requested = decodeURIComponent(pathOnly.replace(/^\/+/, ""));
			if (
				requested !== allowedBasename ||
				requested.includes("/") ||
				requested.includes("..")
			) {
				res.statusCode = 403;
				res.setHeader("Content-Type", "text/plain");
				res.end("forbidden");
				return;
			}
			const filePath = `${docroot}/${allowedBasename}`;
			res.statusCode = 200;
			res.setHeader("Content-Type", guessContentType(allowedBasename));
			res.setHeader("Content-Length", String(stat.size));
			const stream = createReadStream(filePath);
			stream.on("error", () => {
				try {
					res.destroy();
				} catch {}
			});
			stream.pipe(res);
		} catch {
			res.statusCode = 500;
			res.end("internal error");
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port ?? 0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		await closeServer(server);
		throw new Error("startLocalModelServer: failed to read server address");
	}
	const boundPort = address.port;

	return {
		url: `http://127.0.0.1:${boundPort}/${encodeURIComponent(allowedBasename)}`,
		port: boundPort,
		server,
		close() {
			return closeServer(server);
		},
	};
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		// Best-effort: also unref so we don't keep the process alive.
		try {
			server.unref();
		} catch {}
	});
}

function guessContentType(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".glb")) return "model/gltf-binary";
	if (lower.endsWith(".gltf")) return "model/gltf+json";
	if (lower.endsWith(".stl")) return "model/stl";
	if (lower.endsWith(".3mf")) return "model/3mf";
	if (lower.endsWith(".obj")) return "text/plain"; // best-effort
	return "application/octet-stream";
}
