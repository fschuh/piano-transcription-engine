import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { moduleSpecifiersOf } from "../tools/moduleSpecifiers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles(directory, suffixes) {
  const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, suffixes);
    return entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))
      ? [path]
      : [];
  }));
  return paths.flat();
}

async function importsOf(path) {
  return moduleSpecifiersOf(await readFile(join(repositoryRoot, path), "utf8"));
}

/** Application, viewer, and historical-artifact material an active eval may never reach. */
const forbiddenEverywhere = [
  "legacy",
  "react",
  "sheet-music-viewer",
  "webapp",
  "app.tsx",
  "listenroundtwo",
  "candidatemanifest",
  "eligibilitymanifest",
  "tracemanifest",
  "liveevidence",
  "benchmark-results",
  "verify_listen_benchmark_evidence",
];

test("evaluation modules import only the public production entry and their siblings", async () => {
  const paths = (await sourceFiles("src/eval", [".ts"]))
    .filter((path) => !path.startsWith("src/eval/experiments/"));
  assert.ok(paths.length > 0);
  for (const path of paths) {
    for (const specifier of await importsOf(path)) {
      const allowed = specifier === "../index.js" ||
        specifier.startsWith("node:") ||
        /^\.\/[A-Za-z0-9]+\.js$/.test(specifier) ||
        // The candidate directory is the one subdirectory of the eval layer. The
        // runner and the entry point reach into it; nothing else does.
        /^\.\/experiments\/[A-Za-z0-9]+\.js$/.test(specifier);
      assert.ok(allowed, `${path} imports ${specifier}`);
      for (const forbidden of forbiddenEverywhere) {
        assert.equal(specifier.toLowerCase().includes(forbidden), false, `${path}: ${specifier}`);
      }
    }
  }
});

/**
 * Candidate decoders are written inside a research loop, so the narrow thing
 * they are allowed to reach has to be enforced rather than described. A decoder
 * sees its own frozen contract and the public production entry, and that is all:
 * no evaluation module, so it cannot reach the reference, the protocol, the
 * MIDI, or the scorer it is about to be measured by, and nothing from `node:`,
 * so it cannot read a file, open a socket, or consult the clock.
 */
test("candidate decoders reach only their own contract and the production entry", async () => {
  const paths = await sourceFiles("src/eval/experiments", [".ts"]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    if (path.endsWith("types.ts")) {
      assert.deepEqual(await importsOf(path), [], "the contract itself imports nothing");
      continue;
    }
    for (const specifier of await importsOf(path)) {
      assert.ok(
        specifier === "../../index.js" || /^\.\/[A-Za-z0-9]+\.js$/.test(specifier),
        `${path} imports ${specifier}; a candidate may reach only ./<sibling>.js and ../../index.js`,
      );
    }
    const source = await readFile(join(repositoryRoot, path), "utf8");
    for (const forbidden of ["process.", "fetch(", "require(", "node:", "import("]) {
      assert.equal(source.includes(forbidden), false, `${path} uses ${forbidden}`);
    }
  }
});

test("every candidate module declares the id of the file it lives in", async () => {
  for (const path of await sourceFiles("src/eval/experiments", [".ts"])) {
    if (path.endsWith("types.ts")) continue;
    const expected = path.slice(path.lastIndexOf("/") + 1, -".ts".length);
    const source = await readFile(join(repositoryRoot, path), "utf8");
    assert.match(
      source,
      new RegExp(`id:\\s*"${expected}"`),
      `${path} must declare id: "${expected}" so one id names exactly one file`,
    );
  }
});

test("the functional replayer and its fixtures reach no file, network, or process state", async () => {
  for (const path of ["src/eval/functionalEvaluation.ts", "src/eval/functionalFixtures.ts"]) {
    for (const specifier of await importsOf(path)) {
      assert.equal(
        specifier.startsWith("node:"),
        false,
        `${path} imports the runtime module ${specifier}; fixtures must stay in code.`,
      );
    }
    const source = await readFile(join(repositoryRoot, path), "utf8");
    for (const forbidden of ["process.", "fetch(", "require("]) {
      assert.equal(source.includes(forbidden), false, `${path} uses ${forbidden}`);
    }
  }
});

test("production modules never import evaluation code", async () => {
  const paths = [
    "src/index.ts",
    ...await sourceFiles("src/core", [".ts"]),
    ...await sourceFiles("src/runtime", [".ts"]),
    ...await sourceFiles("src/browser", [".ts"]),
  ];
  for (const path of paths) {
    for (const specifier of await importsOf(path)) {
      assert.equal(
        /(^|\/)eval(\/|\.|$)/.test(specifier),
        false,
        `${path} imports evaluation module ${specifier}`,
      );
    }
  }
});

test("active tests use the eval entry point and no application or historical artifact", async () => {
  const paths = await sourceFiles("test", [".test.ts", ".test.mjs"]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    for (const specifier of await importsOf(path)) {
      for (const forbidden of forbiddenEverywhere) {
        assert.equal(
          specifier.toLowerCase().includes(forbidden),
          false,
          `${relative(".", path)} imports ${specifier}`,
        );
      }
      if (!specifier.includes("/eval/")) continue;
      // Tests may sit one directory deeper, so the number of steps up varies;
      // the rule being enforced is that they stop at the entry point.
      assert.match(
        specifier,
        /^(\.\.\/)+(src|dist)\/eval\/index\.js$/,
        `${path} reaches past the eval entry point with ${specifier}`,
      );
    }
  }
});

test("test sources do not read historical archive paths", async () => {
  const guardPath = fileURLToPath(import.meta.url);
  for (const path of await sourceFiles("test", [".ts", ".mjs", ".js"])) {
    // Only this file defines the forbidden token and is exempt from this scan.
    if (resolve(repositoryRoot, path) === guardPath) continue;
    const source = await readFile(join(repositoryRoot, path), "utf8");
    assert.equal(/\blegacy\b/i.test(source), false, `${path} references the historical archive`);
  }
});
