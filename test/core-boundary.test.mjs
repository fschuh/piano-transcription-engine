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
