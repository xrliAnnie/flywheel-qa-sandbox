// Inline the mmdc-rendered SVGs into founder-report.html (build-time only; no runtime fetch).
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const read = (f) => readFileSync(new URL(f, here), "utf8");
const svg = (f) => read(f).replace(/<\?xml[^>]*>/, "");
const review = process.argv[2] ?? "";
const html = read("founder-report.template.html")
	.replace("{{D1}}", () => svg("probe-flow.svg"))
	.replace("{{D2}}", () => svg("probe-model.svg"))
	.replace("{{REVIEW}}", () => review);
writeFileSync(new URL("founder-report.html", here), html);
console.log("wrote founder-report.html", html.length);
