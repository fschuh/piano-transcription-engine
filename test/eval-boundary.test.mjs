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
  const paths = await sourceFiles("src/eval", [".ts"]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    for (const specifier of await importsOf(path)) {
      const allowed = specifier === "../index.js" ||
        specifier.startsWith("node:") ||
        /^\.\/[A-Za-z0-9]+\.js$/.test(specifier);
      assert.ok(allowed, `${path} imports ${specifier}`);
      for (const forbidden of forbiddenEverywhere) {
        assert.equal(specifier.toLowerCase().includes(forbidden), false, `${path}: ${specifier}`);
      }
    }
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
      assert.match(
        specifier,
        /^\.\.\/(src|dist)\/eval\/index\.js$/,
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
