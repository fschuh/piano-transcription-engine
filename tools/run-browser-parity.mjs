// Browser/offline parity for the online_amt runtime. The same module,
// evals/browser/runtimeFixture.js, replays the deterministic 180-frame fixture
// through the production session and decoder in two environments: offline in
// Node against bytes from disk, and in headless Chrome against the same files
// over HTTP. Both must satisfy the fixture's own bounds, and the results that
// must not depend on the environment must be identical.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runRuntimeFixture } from "../evals/browser/runtimeFixture.js";

const CHROME = process.env.CHROME_PATH ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "google-chrome");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repositoryRoot, "evals", "fixtures", "online_amt_runtime");
const MAXIMUM_SCORE_ERROR = 2e-4;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function availableLoopbackPort() {
  const server = createSocketServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function startStaticServer() {
  const server = createServer((request, response) => {
    const requested = normalize(decodeURIComponent(new URL(
      request.url,
      "http://127.0.0.1",
    ).pathname));
    const absolute = join(repositoryRoot, requested);
    if (!absolute.startsWith(repositoryRoot)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    // Headers wait until the file is known to be readable, so a missing path is
    // a 404 the page can report rather than a stream error mid-response.
    stat(absolute).then((details) => {
      if (!details.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(absolute)] ?? "application/octet-stream",
        "Content-Length": details.size,
        "Cache-Control": "no-store",
      });
      createReadStream(absolute).pipe(response);
    }).catch(() => {
      response.writeHead(404).end(`Not found: ${requested}`);
    });
  });
  const port = await availableLoopbackPort();
  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  return { port, close: () => new Promise((done) => server.close(done)) };
}

async function waitForDevTools(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const page = (await response.json()).find((candidate) => candidate.type === "page");
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome has not opened its debugging socket yet.
    }
    await delay(100);
  }
  throw new Error(`Chrome DevTools did not start on port ${port}`);
}

function cdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  let closedReason = null;
  // A browser that dies mid-run closes this socket. Every request waiting on it
  // has to fail then, or the caller waits for a reply that can never arrive.
  const fail = (reason) => {
    closedReason ??= reason;
    for (const request of pending.values()) request.reject(new Error(closedReason));
    pending.clear();
  };
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  socket.onclose = () => fail("The Chrome DevTools connection closed.");
  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.onopen = resolveOpen;
    socket.onerror = () => {
      rejectOpen(new Error("Chrome DevTools WebSocket failed"));
      fail("The Chrome DevTools connection failed.");
    };
  });
  return {
    async send(method, params = {}) {
      await opened;
      if (closedReason !== null) throw new Error(closedReason);
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      fail("The Chrome DevTools connection was closed by the parity run.");
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "Browser evaluation failed",
    );
  }
  return response.result?.value;
}

async function runOffline() {
  const [modelData, wasmBinary] = await Promise.all([
    readFile(join(repositoryRoot, "assets", "models", "online_amt_streaming.onnx")),
    readFile(join(
      repositoryRoot, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm",
    )),
  ]);
  return runRuntimeFixture({
    load: (name) => readFile(join(fixtureDirectory, name)),
    session: { modelData: new Uint8Array(modelData), wasmBinary: new Uint8Array(wasmBinary) },
  });
}

async function runInBrowser(port) {
  const profile = await mkdtemp(join(tmpdir(), "online-amt-parity-chrome-"));
  const devToolsPort = await availableLoopbackPort();
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${devToolsPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ], { stdio: "ignore" });
  // Subscribed before anything can kill the process or wait on it. A browser
  // that fails to start, or exits on its own, emits its last event immediately;
  // listening only after kill() would wait for an event already gone.
  const closed = new Promise((settle) => {
    chrome.once("error", (error) => settle(`Chrome could not start: ${error.message}`));
    chrome.once("close", (code, signal) => settle(
      signal === null ? `Chrome exited with code ${code}` : `Chrome exited on ${signal}`,
    ));
  });
  const chromeDied = closed.then((reason) => { throw new Error(reason); });
  // The race below may never observe this rejection, and an ordinary shutdown
  // reaches it too, so it always carries a handler of its own.
  chromeDied.catch(() => undefined);
  const untilChromeDies = (work) => Promise.race([work, chromeDied]);
  let client;
  try {
    let webSocketUrl;
    try {
      webSocketUrl = await untilChromeDies(waitForDevTools(devToolsPort));
    } catch (error) {
      // Only a browser that never became reachable is worth blaming on the
      // binary; a crash later in the run is a different problem.
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { chromeStartupFailure: true },
      );
    }
    client = cdpClient(webSocketUrl);
    await untilChromeDies(client.send("Runtime.enable"));
    await untilChromeDies(client.send("Page.enable"));
    await untilChromeDies(client.send("Page.navigate", {
      url: `http://127.0.0.1:${port}/evals/browser/parity.html`,
    }));
    const deadline = Date.now() + 300_000;
    for (;;) {
      const status = await untilChromeDies(
        evaluate(client, "document.body?.dataset?.status ?? ''"),
      );
      if (status === "complete") {
        return await untilChromeDies(evaluate(client, "window.parityResult"));
      }
      if (status === "error") {
        throw new Error(await untilChromeDies(evaluate(client, "window.parityError")));
      }
      if (Date.now() > deadline) throw new Error("The browser parity page timed out.");
      await delay(250);
    }
  } finally {
    client?.close();
    chrome.kill("SIGKILL");
    // Chrome keeps writing its profile for a moment after the signal, and a
    // leftover temporary directory must never decide a parity verdict.
    await closed;
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      .catch(() => undefined);
  }
}

const IDENTICAL_FIELDS = [
  "frames",
  "stateMismatches",
  "signalActiveMismatches",
  "onsetCount",
  "noteEventCount",
  "activePitchFrameCount",
  "targetEvidenceFrameCount",
  "recognitionStructureHash",
  "statesHash",
  "signalActiveHash",
];

async function runBothEnvironments() {
  const server = await startStaticServer();
  try {
    console.log("Running the runtime fixture offline in Node…");
    const offline = await runOffline();
    console.log("Running the same module in headless Chrome…");
    return { offline, browser: await runInBrowser(server.port) };
  } finally {
    await server.close();
  }
}

let offline;
let browser;
try {
  ({ offline, browser } = await runBothEnvironments());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nBrowser/offline parity could not run: ${message}`);
  if (error?.chromeStartupFailure === true) {
    console.error(`Set CHROME_PATH to a Chrome or Chromium binary (currently ${CHROME}).`);
  }
  process.exit(1);
}

const failures = [];
for (const [environment, result] of [["offline", offline], ["browser", browser]]) {
  if (result.stateMismatches !== 0) {
    failures.push(`${environment}: ${result.stateMismatches} decoded state mismatches`);
  }
  if (result.signalActiveMismatches !== 0) {
    failures.push(`${environment}: ${result.signalActiveMismatches} signal-active mismatches`);
  }
  if (!(result.maximumAbsoluteScoreError <= MAXIMUM_SCORE_ERROR)) {
    failures.push(
      `${environment}: score error ${result.maximumAbsoluteScoreError} exceeds ${MAXIMUM_SCORE_ERROR}`,
    );
  }
  if (result.onsetCount === 0 || result.targetEvidenceFrameCount === 0) {
    failures.push(`${environment}: the decoder produced no onsets or target evidence`);
  }
}
for (const field of IDENTICAL_FIELDS) {
  if (offline[field] !== browser[field]) {
    failures.push(`${field}: offline ${offline[field]} but browser ${browser[field]}`);
  }
}

const rows = [...IDENTICAL_FIELDS, "maximumAbsoluteScoreError", "scoresHash"];
const width = Math.max(...rows.map((field) => field.length));
console.log(`\n${"field".padEnd(width)}  offline               browser`);
for (const field of rows) {
  console.log(
    `${field.padEnd(width)}  ${String(offline[field]).padEnd(20)}  ${String(browser[field])}`,
  );
}
console.log(
  offline.scoresHash === browser.scoresHash
    ? "\nInference was bit-identical in both environments."
    : "\nInference differed in its last bits, which the score bound above allows.",
);

if (failures.length > 0) {
  console.error(`\nBrowser/offline parity FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nBrowser/offline parity passed.");
