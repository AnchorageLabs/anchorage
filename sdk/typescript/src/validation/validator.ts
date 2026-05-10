import { createRequire } from "node:module";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import {
  agentManifestSchema,
  artifactReferenceSchema,
  protocolEventSchema,
  taskEnvelopeSchema,
} from "../schemas/index.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly ErrorObject[] };

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(ajv);

for (const schema of [
  artifactReferenceSchema,
  agentManifestSchema,
  protocolEventSchema,
  taskEnvelopeSchema,
]) {
  ajv.addSchema(schema);
}

export function validateWithSchema<T>(schemaId: string, value: unknown): ValidationResult<T> {
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }

  return runValidation(validate, value);
}

function runValidation<T>(validate: ValidateFunction, value: unknown): ValidationResult<T> {
  if (validate(value)) {
    return { ok: true, value: value as T };
  }

  return { ok: false, errors: validate.errors ?? [] };
}
