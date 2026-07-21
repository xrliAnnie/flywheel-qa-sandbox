#!/usr/bin/env node
import { readFile } from "node:fs/promises";
// FLY-1354 mock 本地静态服务(每次请求重读文件 → 改完刷新即可)。
// 用法: node serve.mjs   → http://127.0.0.1:9354
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 9354;
const TYPES = {
	".html": "text/html; charset=utf-8",
	".mjs": "text/javascript",
	".js": "text/javascript",
	".css": "text/css",
};

createServer(async (req, res) => {
	try {
		let path = decodeURIComponent((req.url || "/").split("?")[0]);
		if (path === "/") path = "/index.html";
		const abs = normalize(join(ROOT, path));
		if (!abs.startsWith(ROOT)) {
			res.writeHead(403).end("forbidden");
			return;
		}
		const body = await readFile(abs);
		res.writeHead(200, {
			"content-type": TYPES[extname(abs)] || "application/octet-stream",
		});
		res.end(body);
	} catch {
		res
			.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
			.end("not found");
	}
}).listen(PORT, "127.0.0.1", () => {
	process.stdout.write(`FLY-1354 mocks → http://127.0.0.1:${PORT}\n`);
});
