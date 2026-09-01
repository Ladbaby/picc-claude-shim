import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const jiti = createJiti(root + "/", { interopDefault: true, esmResolve: true });
await jiti.import(root + "/test/entry.e2e.test.ts");

// The e2e test sets process.exitCode on failure; report it truthfully.
if (process.exitCode) {
  console.error(`e2e FAIL exit=${process.exitCode}`);
} else {
  console.log("e2e done");
}
