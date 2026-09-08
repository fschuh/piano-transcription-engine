import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { moduleSpecifiersOf } from "./moduleSpecifiers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Repository paths are written with POSIX separators here and in package.json,
// so the Windows separators relative() hands back have to be normalised before
// any of them is compared or reported.
const repositoryPath = (absolute) => relative(repositoryRoot, absolute).split(sep).join("/");
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
  "dist/browser/browserOnlineAmtRecognizer.js",
  "dist/browser/browserOnlineAmtRecognizer.d.ts",
  "dist/eval/index.js",
  "dist/eval/index.d.ts",
  "dist/eval/functionalEvaluation.js",
  "dist/eval/functionalEvaluation.d.ts",
  "dist/eval/functionalFixtures.js",
  "dist/eval/functionalFixtures.d.ts",
  "dist/eval/audioFile.js",
  "dist/eval/audioFile.d.ts",
  "dist/eval/audioDecoder.js",
  "dist/eval/audioDecoder.d.ts",
  "dist/eval/engineIdentity.js",
  "dist/eval/engineIdentity.d.ts",
  "dist/eval/evaluationProtocol.js",
  "dist/eval/evaluationProtocol.d.ts",
  "dist/eval/onlineAmtCapture.js",
  "dist/eval/onlineAmtCapture.d.ts",
  "dist/eval/traceStore.js",
  "dist/eval/traceStore.d.ts",
  "dist/eval/midiFile.js",
  "dist/eval/midiFile.d.ts",
  "dist/eval/recordingCorpus.js",
  "dist/eval/recordingCorpus.d.ts",
  "dist/eval/inventoryCli.js",
  "dist/eval/captureCli.js",
  "dist/eval/scoreCli.js",
  "dist/eval/recognitionEvaluation.js",
  "dist/eval/recognitionEvaluation.d.ts",
  "assets/models/online_amt_streaming.onnx",
  "assets/models/online_amt.LICENSE.txt",
  "assets/worklets/online-amt-capture.js",
];
const skippedDirectories = new Set([".git", "dist", "node_modules"]);
const privateCorpusExtensions = new Set([".mid", ".midi", ".mp3"]);
const viewerReferences = ["sheet-music-viewer", "webapp/src"];

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
    privateCorpusFiles.map(repositoryPath).join(", "),
  );
}

const modelFiles = repositoryFiles
  .filter((path) => extname(path).toLowerCase() === ".onnx")
  .map(repositoryPath);
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
  for (const specifier of moduleSpecifiersOf(source)) {
    const forbidden = viewerReferences.find((reference) => specifier.includes(reference));
    if (forbidden !== undefined) {
      throw new Error(
        `${repositoryPath(path)} imports viewer source (${specifier}).`,
      );
    }
  }
}

// The README ships inside the package, so every relative link it carries has to
// resolve there too. Repository-only documents need an absolute URL.
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const packagedEntries = manifest.files;
const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
let checkedLinks = 0;
for (const [, target] of readme.matchAll(/\]\(([^)\s]+)/g)) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
  const path = target.split("#")[0];
  checkedLinks += 1;
  const packaged = packagedEntries.some((entry) => (
    entry.endsWith("/") ? path.startsWith(entry) : path === entry
  ));
  if (!packaged) {
    throw new Error(
      `README.md links to ${target}, which the package does not include. ` +
      "Use an absolute repository URL or add the file to the package allowlist.",
    );
  }
}

console.log(
  `Verified ${requiredPackageFiles.length} package files, ${checkedLinks} packaged ` +
  "README links, and no private recording corpus.",
);
