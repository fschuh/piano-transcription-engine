import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredPackageFiles = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/core/chordMatcher.js",
  "dist/core/chordMatcher.d.ts",
  "dist/core/listenMatcherProfiles.js",
  "dist/core/listenMatcherProfiles.d.ts",
  "dist/core/onlineAmtOutput.js",
  "dist/core/onlineAmtOutput.d.ts",
  "dist/core/recognitionTypes.js",
  "dist/core/recognitionTypes.d.ts",
  "dist/runtime/onlineAmtProtocol.js",
  "dist/runtime/onlineAmtProtocol.d.ts",
  "dist/runtime/onlineAmtSession.js",
  "dist/runtime/onlineAmtSession.d.ts",
  "dist/browser/index.js",
  "dist/browser/index.d.ts",
  "dist/eval/index.js",
  "dist/eval/index.d.ts",
  "assets/models/online_amt_streaming.onnx",
  "assets/models/online_amt.LICENSE.txt",
  "assets/worklets/online-amt-capture.js",
];
const skippedDirectories = new Set([".git", "dist", "node_modules"]);
const privateCorpusExtensions = new Set([".mid", ".midi", ".mp3"]);
const viewerReferences = ["sheet-music-viewer", "webapp/src"];
const moduleSpecifierPattern = /(?:from\s+|import\s*\(|export\s+[^;]*?from\s+)["']([^"']+)["']/g;

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

for (const path of requiredPackageFiles) {
  const details = await stat(join(repositoryRoot, path));
  if (!details.isFile() || details.size === 0) {
    throw new Error(`Required package file is empty: ${path}`);
  }
}

const repositoryFiles = await walk(repositoryRoot);
const privateCorpusFiles = repositoryFiles.filter((path) => (
  privateCorpusExtensions.has(extname(path).toLowerCase())
));
if (privateCorpusFiles.length > 0) {
  throw new Error(
    "Private recording/MIDI formats are not allowed in this repository: " +
    privateCorpusFiles.map((path) => relative(repositoryRoot, path)).join(", "),
  );
}

const modelFiles = repositoryFiles
  .filter((path) => extname(path).toLowerCase() === ".onnx")
  .map((path) => relative(repositoryRoot, path));
if (
  modelFiles.length !== 1 ||
  modelFiles[0] !== "assets/models/online_amt_streaming.onnx"
) {
  throw new Error(
    "Expected exactly one canonical ONNX model, found: " + modelFiles.join(", "),
  );
}

const sourceFiles = repositoryFiles.filter((path) => path.endsWith(".ts"));
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(moduleSpecifierPattern)) {
    const specifier = match[1] ?? "";
    const forbidden = viewerReferences.find((reference) => specifier.includes(reference));
    if (forbidden !== undefined) {
      throw new Error(
        `${relative(repositoryRoot, path)} imports viewer source (${specifier}).`,
      );
    }
  }
}

console.log(
  `Verified ${requiredPackageFiles.length} package files and no private recording corpus.`,
);
