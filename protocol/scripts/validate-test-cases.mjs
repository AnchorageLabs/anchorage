import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemasDir = path.join(root, "schemas");
const testCasesDir = path.join(root, "test-cases");

const schemaFiles = [
  "artifact-reference.schema.json",
  "agent-manifest.schema.json",
  "protocol-event.schema.json",
  "task-envelope.schema.json",
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

for (const file of schemaFiles) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
  ajv.addSchema(schema);
}

const checks = [
  ["valid/tasks", "https://anchorage.dev/schemas/task-envelope.schema.json", true],
  ["invalid/tasks", "https://anchorage.dev/schemas/task-envelope.schema.json", false],
  ["valid/events", "https://anchorage.dev/schemas/protocol-event.schema.json", true],
  ["invalid/events", "https://anchorage.dev/schemas/protocol-event.schema.json", false],
  ["valid/manifests", "https://anchorage.dev/schemas/agent-manifest.schema.json", true],
  ["invalid/manifests", "https://anchorage.dev/schemas/agent-manifest.schema.json", false],
];

let failures = 0;

for (const [relativeDir, schemaId, expected] of checks) {
  const dir = path.join(testCasesDir, relativeDir);
  if (!fs.existsSync(dir)) continue;

  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`Schema not registered: ${schemaId}`);

  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const valid = validate(data);
    if (valid !== expected) {
      failures += 1;
      const errors = validate.errors ? JSON.stringify(validate.errors, null, 2) : "none";
      console.error(`${relativeDir}/${file}: expected valid=${expected}, got ${valid}`);
      console.error(errors);
    }
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
