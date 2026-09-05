#!/usr/bin/env node

import { inventoryRecordingFiles } from "./recordingInventory.js";

const recordingRoot = process.argv[2] ?? "evals/fixtures";

try {
  const inventory = await inventoryRecordingFiles(recordingRoot);
  console.log(JSON.stringify(inventory, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not inventory ${recordingRoot}: ${message}`);
  process.exitCode = 1;
}

