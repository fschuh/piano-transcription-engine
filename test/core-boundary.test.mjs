import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = join(repositoryRoot, "src", "core");
const forbiddenImportFragments = [
  "react",
  "dom",
  "sheet-music-viewer",
  "webapp",
  "benchmark",
  "report",
  "node:fs",
];
const moduleSpecifierPattern = /(?:from\s+|import\s*\(|export\s+[^;]*?from\s+)["']([^"']+)["']/g;

test("core modules import only other platform-neutral core modules", async () => {
  const paths = (await readdir(coreRoot))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(coreRoot, name));
  assert.ok(paths.length > 0);

  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(moduleSpecifierPattern)) {
      const specifier = match[1] ?? "";
      assert.ok(specifier.startsWith("./"), `${path} has non-core import ${specifier}`);
      for (const fragment of forbiddenImportFragments) {
        assert.equal(
          specifier.toLowerCase().includes(fragment),
          false,
          `${path} imports forbidden module ${specifier}`,
        );
      }
    }
  }
});

test("canonical engine-core fixture bytes match the Task 01 baseline", async () => {
  const fixture = await readFile(join(
    repositoryRoot,
    "test",
    "fixtures",
    "engineCoreBaseline.fixture.json",
  ));
  assert.equal(
    createHash("sha256").update(fixture).digest("hex"),
    "566453d6d14949768a5d1506580f0709cb39ac61c1147819c203c2429039df15",
  );
});

test("canonical runtime fixture bytes match the Task 01 baseline", async () => {
  const expectedHashes = {
    "audio.f32": "33c32d4cb06fa3eef9c1fa81d84213a33227120cc94cec8c274e575e315fa33c",
    "metadata.json": "b3c048309207d9936cdffce6aa3d1974e61087f4906918923e95f3f1651c7bf6",
    "scores.f32": "b1a148b928e632f3871f59f76390a251fd78f7a20fe4711e5a816615f6922006",
    "signal-active.u8": "59278ecd80902c8e0f8efaf1aa8f4bb09aed7d3dfbc14309e17528466cbdd1d2",
    "states.u8": "507c9d05c9e2b2c0b58de23d9721ee27511549beacae59b5089da3742d5a4617",
  };
  for (const [name, expectedHash] of Object.entries(expectedHashes)) {
    const fixture = await readFile(join(
      repositoryRoot,
      "evals",
      "fixtures",
      "online_amt_runtime",
      name,
    ));
    assert.equal(createHash("sha256").update(fixture).digest("hex"), expectedHash, name);
  }
});

test("browser recognizer contains no viewer asset or worker construction assumptions", async () => {
  const source = await readFile(join(
    repositoryRoot,
    "src",
    "browser",
    "browserOnlineAmtRecognizer.ts",
  ), "utf8");
  for (const forbidden of [
    "document.baseURI",
    "onlineAmtWorker.ts",
    "models/online_amt_streaming.onnx",
    "worklets/online-amt-capture.js",
    "new Worker(",
    "sheet-music-viewer",
    "webapp/src",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /modelUrl: this\.options\.modelUrl/);
  assert.match(source, /addModule\(this\.options\.workletUrl\)/);
  assert.match(source, /this\.options\.createWorker\(\)/);
});
