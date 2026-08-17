import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const jiti = createJiti(root + "/", { interopDefault: true, esmResolve: true });
await jiti.import(root + "/test/entry.e2e.test.ts");
console.log("e2e done");
