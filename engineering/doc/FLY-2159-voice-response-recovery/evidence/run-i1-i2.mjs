import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [binary, expectedShape] = process.argv.slice(2);
if (!binary || !["patched", "official"].includes(expectedShape)) {
  throw new Error("usage: node run-i1-i2.mjs <codex-bin> <patched|official>");
}

const codexHome = mkdtempSync(join(tmpdir(), `fly-2159-${expectedShape}-`));
writeFileSync(
  join(codexHome, "config.toml"),
  "[features]\nrealtime_conversation = true\n",
);

const child = spawn(binary, ["app-server"], {
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["pipe", "pipe", "pipe"],
});

const messages = [];
const waiters = new Set();
let childFailure = null;
let shuttingDown = false;

function recordChildFailure(error) {
  if (!childFailure) {
    childFailure =
      error instanceof Error ? error : new Error(String(error));
  }
  for (const waiter of waiters) waiter();
}

child.once("error", recordChildFailure);
child.stdin.on("error", recordChildFailure);
child.once("exit", (code, signal) => {
  if (!shuttingDown) {
    recordChildFailure(
      new Error(
        `app-server exited before probe completion (code=${code}, signal=${signal})`,
      ),
    );
  }
});

function emit(direction, payload) {
  process.stdout.write(
    `${JSON.stringify({ direction, expectedShape, payload })}\n`,
  );
}

function observe(message) {
  messages.push(message);
  emit("server", message);
  for (const waiter of waiters) waiter();
}

createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    observe(JSON.parse(line));
  } catch {
    emit("server-non-json", line);
  }
});
createInterface({ input: child.stderr }).on("line", (line) => {
  emit("server-stderr", line);
});

function send(message) {
  if (childFailure) throw childFailure;
  emit("client", message);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitFor(predicate, description, timeoutMs = 15_000) {
  if (childFailure) return Promise.reject(childFailure);
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`timed out waiting for ${description}`));
    }, timeoutMs);
    function check() {
      if (childFailure) {
        clearTimeout(timeout);
        waiters.delete(check);
        reject(childFailure);
        return;
      }
      const match = messages.find(predicate);
      if (!match) return;
      clearTimeout(timeout);
      waiters.delete(check);
      resolve(match);
    }
    waiters.add(check);
  });
}

function request(id, method, params) {
  send({ id, method, params });
  return waitFor(
    (message) => message.id === id,
    `${method} response id=${id}`,
  );
}

try {
  const initialized = await request(1, "initialize", {
    clientInfo: {
      name: "fly-2159-i1-i2-probe",
      title: null,
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  if (initialized.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
  }
  send({ method: "initialized" });

  const started = await request(2, "thread/start", {
    approvalPolicy: "on-request",
    cwd: process.cwd(),
    environments: [],
    ephemeral: true,
    sandbox: "read-only",
  });
  const threadId = started.result?.thread?.id;
  if (!threadId) {
    throw new Error(`thread/start failed: ${JSON.stringify(started)}`);
  }

  const createResponse = await request(3, "thread/realtime/createResponse", {
    threadId,
  });
  if (expectedShape === "official") {
    if (createResponse.error?.code !== -32600) {
      throw new Error(
        `expected official -32600 Invalid request, got ${JSON.stringify(createResponse)}`,
      );
    }
  } else {
    if (
      createResponse.error ||
      JSON.stringify(createResponse.result) !== JSON.stringify({})
    ) {
      throw new Error(
        `expected patched acceptance {}, got ${JSON.stringify(createResponse)}`,
      );
    }
    const notification = await waitFor(
      (message) =>
        typeof message.method === "string" &&
        JSON.stringify(message).includes("conversation is not running"),
      "patched asynchronous conversation-not-running notification",
    );
    if (notification.id !== undefined) {
      throw new Error(
        `expected an asynchronous notification, got ${JSON.stringify(notification)}`,
      );
    }
  }

  emit("verdict", {
    status: "PASS",
    temporaryCodexHomeRemoved: true,
    shape: expectedShape,
  });
} finally {
  shuttingDown = true;
  child.kill("SIGTERM");
  rmSync(codexHome, { force: true, recursive: true });
}
