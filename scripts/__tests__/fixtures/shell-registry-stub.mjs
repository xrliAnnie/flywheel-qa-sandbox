import fs from "node:fs";
import http from "node:http";

const [tarballPath, portFile, version, tag, tagVersion = version] =
	process.argv.slice(2);
if (!tarballPath || !portFile || !version || !tag) process.exit(64);
const bytes = fs.readFileSync(tarballPath);
const server = http.createServer((request, response) => {
	if (request.url?.endsWith(".tgz")) {
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.end(bytes);
		return;
	}
	const name = "@flywheel-ai/onboard";
	response.writeHead(200, { "content-type": "application/json" });
	response.end(
		JSON.stringify({
			_id: name,
			name,
			"dist-tags": { [tag]: tagVersion },
			versions: {
				[version]: {
					name,
					version,
					dist: {
						tarball: `http://${request.headers.host}/onboard-${version}.tgz`,
					},
				},
			},
		}),
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(portFile, `${base}/\n`);
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
