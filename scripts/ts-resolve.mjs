/**
 * ESM resolution hook so `node scripts/sync.ts` can import the app's TypeScript
 * libraries directly.
 *
 * Node 26 strips TypeScript types natively, but it still requires fully
 * specified ESM specifiers, while the app (tsconfig `moduleResolution: bundler`)
 * imports "./db" and "@/lib/db" with no extension. This hook fills in the
 * missing extension and maps "@/" to the project root. Dependency-free; it only
 * affects processes started with `--import ./scripts/ts-resolve.mjs`.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_EXTS = [".ts", ".tsx", ".mjs", ".js", path.join("", "index.ts")];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith("node:") || /^(https?:)?\/\//.test(specifier)) throw err;

    let base;
    if (specifier === "@" || specifier.startsWith("@/")) {
      base = path.join(ROOT, specifier.slice(2));
    } else if (specifier.startsWith(".")) {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : path.join(ROOT, "x");
      base = path.resolve(path.dirname(parent), specifier);
    } else {
      throw err;
    }

    for (const ext of CANDIDATE_EXTS) {
      const candidate = base + ext;
      if (isFile(candidate)) {
        return {
          url: pathToFileURL(candidate).href,
          format: candidate.endsWith(".ts") || candidate.endsWith(".tsx") ? "module-typescript" : "module",
          shortCircuit: true,
        };
      }
    }
    throw err;
  }
}
