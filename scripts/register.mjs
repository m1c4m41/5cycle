/**
 * Resolution shim so the CLI scripts can import the app's TypeScript modules
 * with Node's native type stripping.
 *
 * Node 26 runs .ts directly but still demands fully specified ESM specifiers,
 * while the app (tsconfig `moduleResolution: bundler`) imports "./db" and
 * "@/lib/db" with no extension. This fills in the extension and maps "@/" to the
 * project root. Dependency-free; used as `node --import ./scripts/register.mjs …`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import module from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const TRY = [".ts", ".tsx", ".mjs", ".js", "/index.ts"];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Extensionless relative import or "@/…" -> a real file URL, or null. */
function fromProjectLayout(specifier, context) {
  let base;
  if (specifier === "@" || specifier.startsWith("@/")) {
    base = path.join(ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    const parent = context?.parentURL ? fileURLToPath(context.parentURL) : path.join(ROOT, "_");
    base = path.resolve(path.dirname(parent), specifier);
  } else {
    return null;
  }
  for (const ext of TRY) {
    if (isFile(base + ext)) return pathToFileURL(base + ext).href;
  }
  return null;
}

// Node 26 runs hooks in-thread; fall back to the worker-based API on older ones.
if (typeof module.registerHooks === "function") {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const url = fromProjectLayout(specifier, context);
        if (!url) throw err;
        return { url, shortCircuit: true };
      }
    },
  });
} else {
  module.register(new URL("./ts-resolve.mjs", import.meta.url).href);
}
