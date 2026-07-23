#!/usr/bin/env bun
// Compare the stock-mode producer copy against the pre-producer fork-main
// server bytes. This intentionally calls the exported production functions
// instead of reusing test constants as the oracle.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [recorderPath, forkMainServerPath] = process.argv.slice(2);
if (!recorderPath || !forkMainServerPath) {
	throw new Error(
		"usage: s5-byte-compat-audit.ts RECORDER_TS FORK_MAIN_SERVER_TS",
	);
}

const recorder = await import(pathToFileURL(recorderPath).href);
const mainBytes = readFileSync(forkMainServerPath, "utf8");
// The fork-main source escapes quote characters inside its string literals.
// Decode only those lexical escapes before comparing the runtime string values.
const decodedLiteralBytes = mainBytes
	.replaceAll('\\"', '"')
	.replaceAll("\\'", "'");
const stockMode = { kind: "disabled", reason: "stock" } as const;
const values = {
	inbound: recorder.receiptInboundInstruction(stockMode) as string,
	replyTool: recorder.receiptReplyToolDescription(stockMode) as string,
	replyTo: recorder.receiptReplyToDescription(stockMode) as string,
};
const matches = Object.fromEntries(
	Object.entries(values).map(([name, value]) => [
		name,
		decodedLiteralBytes.includes(value),
	]),
);
process.stdout.write(
	`${JSON.stringify(
		{
			forkMainServerPath,
			recorderPath,
			lengths: Object.fromEntries(
				Object.entries(values).map(([name, value]) => [name, value.length]),
			),
			matches,
		},
		null,
		2,
	)}\n`,
);
if (Object.values(matches).some((match) => !match)) process.exit(1);
