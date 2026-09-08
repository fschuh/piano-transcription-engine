/**
 * Establishes which engine build a capture ran from.
 *
 * A package version is not an identity: several revisions share one, and a
 * working tree can differ from every revision that exists. A trace that only
 * carried a version would let two runs of different code be compared as one, so
 * the revision is established here and recorded with every trace.
 *
 * There are two honest sources, and they are not equal. A local checkout is
 * asked directly, which measures both the revision and whether the tree carried
 * uncommitted changes — the case where a version alone is most misleading,
 * because the code may exist nowhere else. A consumer that installed this
 * package at a pinned revision knows that revision from its own lockfile and
 * supplies it; npm does not leave it inside the installed package, and this
 * module will not guess at it.
 *
 * A measurement beats an assertion, so a checkout is preferred whenever there is
 * one. A caller's revision is still recorded, so a claim that turns out to
 * disagree with the code that actually ran is visible rather than lost.
 */

import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OnlineAmtTraceEngine } from "./traceStore.js";

interface PackageManifest {
  name: string;
  version: string;
}

let manifestPromise: Promise<{ root: string; manifest: PackageManifest }> | null = null;

/**
 * Finds this package's own directory by walking up to its manifest.
 *
 * A fixed number of steps up from this module would depend on where the
 * compiler happened to put it; the manifest that names this package is the
 * thing being looked for, so it is what is searched for.
 */
function locatePackage(): Promise<{ root: string; manifest: PackageManifest }> {
  manifestPromise ??= (async () => {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = join(directory, "package.json");
      const manifest = await readFile(candidate, "utf8")
        .then((text) => JSON.parse(text) as PackageManifest)
        .catch(() => null);
      if (manifest !== null && manifest.name === "@fschuh/piano-transcription-engine") {
        return { root: directory, manifest };
      }
      const parent = dirname(directory);
      if (parent === directory) {
        throw new Error("This package's own manifest is not above the module that looked for it.");
      }
      directory = parent;
    }
  })();
  return manifestPromise;
}

function git(root: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout.toString().trim() : null),
    );
  });
}

/**
 * Reads the revision of this package's own checkout, when it has one.
 *
 * The work tree's root must be this package's directory. An installed copy
 * often sits inside the consumer's repository, and asking Git about it there
 * would answer with the consumer's revision — a confident, wrong provenance.
 */
async function checkoutRevision(
  packageRoot: string,
): Promise<{ revision: string; uncommitted: boolean } | null> {
  const [toplevel, revision] = await Promise.all([
    git(packageRoot, ["rev-parse", "--show-toplevel"]),
    git(packageRoot, ["rev-parse", "HEAD"]),
  ]);
  if (toplevel === null || revision === null) return null;
  const [realToplevel, realPackageRoot] = await Promise.all([
    realpath(toplevel).catch(() => null),
    realpath(packageRoot).catch(() => null),
  ]);
  if (realToplevel === null || realPackageRoot === null) return null;
  if (realToplevel !== realPackageRoot) return null;
  const status = await git(packageRoot, ["status", "--porcelain"]);
  // An unreadable status is reported as unknown by the caller, never as clean.
  if (status === null) return null;
  return { revision, uncommitted: status !== "" };
}

/**
 * Identifies the engine build, preferring what can be measured.
 *
 * When this package is its own checkout, that checkout is the code that ran, and
 * it is used even if the caller asserted something else: a caller naming a pin
 * cannot know that the working tree in front of it differs. A caller-supplied
 * revision is used for an installed copy, where nothing can be measured; its
 * working-tree state is not something this process can check, so it is recorded
 * as unknown rather than assumed clean.
 */
export async function identifyEngine(
  callerRevision?: string | undefined,
): Promise<OnlineAmtTraceEngine> {
  const { root, manifest } = await locatePackage();
  const asserted = callerRevision === undefined || callerRevision.trim() === ""
    ? null
    : callerRevision.trim();
  const base = {
    name: manifest.name,
    version: manifest.version,
    callerRevision: asserted,
  };
  const checkout = await checkoutRevision(root);
  if (checkout !== null) {
    return {
      ...base,
      revision: checkout.revision,
      revisionSource: "checkout",
      uncommitted: checkout.uncommitted,
    };
  }
  if (asserted !== null) {
    return { ...base, revision: asserted, revisionSource: "caller", uncommitted: null };
  }
  return { ...base, revision: null, revisionSource: "none", uncommitted: null };
}

/** How a report should describe an engine build, warnings included. */
export function describeEngine(engine: OnlineAmtTraceEngine): string {
  const revision = engine.revision === null
    ? "no revision established"
    : `${engine.revision.slice(0, 12)} (${engine.revisionSource})`;
  const tree = engine.uncommitted === true
    ? ", UNCOMMITTED CHANGES"
    : engine.uncommitted === null
      ? ", working tree unknown"
      : "";
  return `${engine.name} ${engine.version}, ${revision}${tree}`;
}

/**
 * What is wrong with this build's provenance, or null when nothing is.
 *
 * A caller-supplied revision leaves the working tree unknown, and that is not a
 * fault: the caller named a revision it installed, and the trace records that
 * the revision is self-reported. The two real problems are a build that names
 * no revision at all, and one whose tree carried changes that may exist nowhere
 * but on the machine that ran the capture.
 */
export function engineProvenanceWarning(engine: OnlineAmtTraceEngine): string | null {
  if (engine.revision === null) {
    return "no engine revision could be established. Pass --engine-revision with the revision " +
      "this package was installed at.";
  }
  if (engine.uncommitted === true) {
    return `the working tree carried uncommitted changes on ${engine.revision}, so the code that ` +
      "produced this exists nowhere else.";
  }
  return null;
}

/** True when a trace from this build cannot be attributed to committed code. */
export function engineIsUnattributable(engine: OnlineAmtTraceEngine): boolean {
  return engineProvenanceWarning(engine) !== null;
}

/** One capture's provenance, as a run needs to judge it. */
export interface CaptureProvenance {
  recordingId: string;
  /** True when the trace was reused rather than produced by this run. */
  cached: boolean;
  engine: OnlineAmtTraceEngine;
  converterVersion: string;
}

function example(entries: readonly CaptureProvenance[]): CaptureProvenance {
  return entries[0] as CaptureProvenance;
}

/**
 * Everything a capture run cannot vouch for, as warnings a report must show.
 *
 * A reused trace carries its own provenance, and that is what is judged: a
 * matching revision string does not make a trace attributable when the build
 * that wrote it had uncommitted changes, and a clean checkout does not launder
 * evidence produced by a dirty one at the same commit. The current build is
 * judged only when this run actually wrote something.
 */
export function captureProvenanceWarnings(
  engine: OnlineAmtTraceEngine,
  converterVersion: string,
  captured: readonly CaptureProvenance[],
): string[] {
  const lines: string[] = [];
  const written = captured.filter((entry) => !entry.cached);
  const reused = captured.filter((entry) => entry.cached);

  if (
    engine.callerRevision !== null &&
    engine.revisionSource === "checkout" &&
    engine.callerRevision !== engine.revision
  ) {
    lines.push(
      `WARNING: --engine-revision named ${engine.callerRevision}, but this package is a checkout ` +
      `at ${engine.revision}, which is the code that ran. The supplied revision was ignored.`,
    );
  }

  if (written.length > 0) {
    const provenance = engineProvenanceWarning(engine);
    if (provenance !== null) {
      lines.push(
        `WARNING: ${written.length} trace(s) captured by this run cannot be attributed to ` +
        `committed code — ${provenance}`,
      );
    }
  }

  const unattributable = reused.filter((entry) => engineIsUnattributable(entry.engine));
  if (unattributable.length > 0) {
    const first = example(unattributable);
    lines.push(
      `WARNING: ${unattributable.length} reused trace(s) cannot be attributed to committed code, ` +
      `such as ${first.recordingId} — ${engineProvenanceWarning(first.engine)} Recapture them ` +
      "with --force from a committed build before reporting them as evidence.",
    );
  }

  const otherEngine = reused.filter((entry) => entry.engine.revision !== engine.revision);
  if (otherEngine.length > 0) {
    const first = example(otherEngine);
    lines.push(
      `WARNING: ${otherEngine.length} reused trace(s) were captured by a different engine build, ` +
      `such as ${first.recordingId} (${describeEngine(first.engine)}).`,
    );
  }

  const otherConverter = reused.filter((entry) => entry.converterVersion !== converterVersion);
  if (otherConverter.length > 0) {
    const first = example(otherConverter);
    lines.push(
      `WARNING: ${otherConverter.length} reused trace(s) were decoded by a different converter, ` +
      `such as ${first.recordingId} (${first.converterVersion}).`,
    );
  }
  return lines;
}
