import { createHash } from "node:crypto";
import { type DefaultTreeAdapterMap, parse } from "parse5";

const skipped = new Set(["script", "style", "template", "noscript"]);
const blocks = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"div",
	"section",
	"article",
	"li",
	"tr",
	"table",
	"pre",
	"blockquote",
	"br",
]);
function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function frozenSourceText(
	body: string,
	format: "html" | "text",
): { text: string; originalDigest: string; textDigest: string } {
	if (Buffer.byteLength(body) > 262_144)
		throw new Error("source_budget_exceeded");
	let text = body;
	if (format === "html") {
		const output: string[] = [];
		const stack: (DefaultTreeAdapterMap["node"] | string)[] = [parse(body)];
		while (stack.length) {
			const node = stack.pop()!;
			if (typeof node === "string") {
				output.push(node);
				continue;
			}
			if ("tagName" in node && skipped.has(node.tagName)) continue;
			if (node.nodeName === "#text" && "value" in node) {
				output.push(node.value);
				continue;
			}
			if ("tagName" in node && blocks.has(node.tagName)) {
				output.push("\n");
				stack.push("\n");
			}
			if ("tagName" in node && ["td", "th"].includes(node.tagName))
				output.push(" ");
			if ("childNodes" in node)
				for (let index = node.childNodes.length - 1; index >= 0; index--)
					stack.push(node.childNodes[index]!);
		}
		text = output
			.join("")
			.split("\n")
			.map((line) => line.replace(/[\t\r \u00a0]+/g, " ").trim())
			.filter(Boolean)
			.join("\n");
	}
	return { text, originalDigest: digest(body), textDigest: digest(text) };
}
