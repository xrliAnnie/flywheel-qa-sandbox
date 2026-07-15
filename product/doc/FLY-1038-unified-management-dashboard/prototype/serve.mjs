import { readFileSync } from "node:fs";
import http from "node:http";

const FILE =
	"/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1038/587b7c6d-ce96-45fc-8b38-936dee42b019/scratchpad/fly1038-dashboard.html";
const PORT = Number(process.env.PORT || 9920);
http
	.createServer((req, res) => {
		if (req.url === "/" || req.url.startsWith("/?")) {
			res.setHeader("content-type", "text/html; charset=utf-8");
			try {
				res.end(readFileSync(FILE, "utf-8"));
			} catch (e) {
				// per-request → refresh picks up edits
				res.statusCode = 500;
				res.end(`read error: ${e.message}`);
			}
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	})
	.listen(PORT, "127.0.0.1", () =>
		console.log(`[fly1038-dashboard] http://127.0.0.1:${PORT}/`),
	);
