import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readJsonIfComplete,
  readJsonLinesIgnoringTornTail,
} from "./readers.mjs";

test("readJsonIfComplete waits through a torn atomic rewrite", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fly2159-readers-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const path = join(root, "session.json");

  writeFileSync(path, '{"activeRun":');
  assert.equal(readJsonIfComplete(path), null);

  writeFileSync(path, '{"activeRun":{"bootId":"boot-1"}}');
  assert.deepEqual(readJsonIfComplete(path), {
    activeRun: { bootId: "boot-1" },
  });
});

test("readJsonLinesIgnoringTornTail keeps complete events", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fly2159-readers-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const path = join(root, "events.jsonl");

  writeFileSync(path, '{"id":1}\n{"id":');
  assert.deepEqual(readJsonLinesIgnoringTornTail(path), [{ id: 1 }]);

  writeFileSync(path, '{"id":1}\n{"id":2}');
  assert.deepEqual(readJsonLinesIgnoringTornTail(path), [{ id: 1 }, { id: 2 }]);
});

test("readJsonLinesIgnoringTornTail rejects a malformed complete line", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fly2159-readers-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const path = join(root, "events.jsonl");

  writeFileSync(path, '{"id":1}\nnot-json\n');
  assert.throws(() => readJsonLinesIgnoringTornTail(path), SyntaxError);
});

test("missing evidence files remain an empty polling state", () => {
  const path = join(tmpdir(), `fly2159-missing-${process.pid}`);
  assert.equal(readJsonIfComplete(path), null);
  assert.deepEqual(readJsonLinesIgnoringTornTail(path), []);
});
