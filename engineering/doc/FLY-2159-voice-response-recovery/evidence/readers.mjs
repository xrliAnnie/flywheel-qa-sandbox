import { readFileSync } from "node:fs";

export function readJsonIfComplete(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readJsonLinesIgnoringTornTail(path) {
  try {
    const contents = readFileSync(path, "utf8");
    const lines = contents.split("\n");
    const events = [];
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        const isTornTail =
          error instanceof SyntaxError &&
          index === lines.length - 1 &&
          !contents.endsWith("\n");
        if (isTornTail) break;
        throw error;
      }
    }
    return events;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
