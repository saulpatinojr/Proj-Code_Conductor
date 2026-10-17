import { readFileSync } from 'node:fs';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

export type ContractName = 'TaskEnvelope' | 'AgentAssignment' | 'AgentResult' | 'Evidence' | 'Finding' | 'GateResult' | 'ReviewResult' | 'MergeDecision' | 'ApprovalRecord' | 'WorktreeRecord' | 'HandoffPacket' | 'RunManifest' | 'GateCatalog';
export interface ContractValidationResult { ok: boolean; errors: ErrorObject[] }

type AjvInstance = {
  addSchema(schema: object): void;
  getSchema(ref: string): ValidateFunction | undefined;
};
type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;
type AddFormats = (ajv: AjvInstance) => unknown;

// Use Ajv's 2020 constructor because the contract schema declares JSON Schema
// draft 2020-12. Resolve the CommonJS/ESM boundary explicitly under NodeNext.
const loadedAjv: unknown = ajvModule;
const Ajv2020 = ((loadedAjv as { default?: AjvConstructor }).default ?? loadedAjv) as AjvConstructor;
const loadedFormats: unknown = formatsModule;
const addFormats = ((loadedFormats as { default?: AddFormats }).default ?? loadedFormats) as AddFormats;

// The schema is read and compiled on first use, not on import: a bundle that only reaches
// this package's types (the VS Code extension) then leaves Ajv and the schema out entirely
// (the package declares "sideEffects": false).
let compiled: { ajv: AjvInstance; id: string } | undefined;
function contracts(): { ajv: AjvInstance; id: string } {
  if (compiled) return compiled;
  const schema = JSON.parse(readFileSync(new URL('../schema/contracts.schema.json', import.meta.url), 'utf8')) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  compiled = { ajv, id: schema.$id };
  return compiled;
}
const validators = new Map<ContractName, ValidateFunction>();

function validatorFor(name: ContractName): ValidateFunction {
  const cached = validators.get(name);
  if (cached) return cached;
  const { ajv, id } = contracts();
  const validate = ajv.getSchema(`${id}#/$defs/${name}`);
  if (!validate) throw new Error(`JSON Schema definition not found: ${name}`);
  validators.set(name, validate);
  return validate;
}

export function validateContract(name: ContractName, value: unknown): ContractValidationResult {
  const validate = validatorFor(name);
  const ok = Boolean(validate(value));
  return { ok, errors: ok ? [] : [...(validate.errors ?? [])] };
}

export function assertContract(name: ContractName, value: unknown): void {
  const result = validateContract(name, value);
  if (!result.ok) throw new Error(`${name} failed schema validation: ${result.errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join('; ')}`);
}
