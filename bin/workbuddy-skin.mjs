#!/usr/bin/env node
// WorkBuddy Skin CLI entry point. Delegates to scripts/cli.mjs.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Dynamic import needs a file:// URL for absolute paths on Windows.
await import(pathToFileURL(join(here, "..", "scripts", "cli.mjs")).href);
