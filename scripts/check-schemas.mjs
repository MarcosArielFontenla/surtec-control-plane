import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = join(root, "schemas");
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
const files = readdirSync(schemaDirectory).filter((name) => name.endsWith(".schema.json")).sort();
const schemas = files.map((file) => JSON.parse(readFileSync(join(schemaDirectory, file), "utf8")));

for (const schema of schemas) ajv.addSchema(schema);
for (const schema of schemas) {
  if (!ajv.getSchema(schema.$id)) throw new Error(`Schema was not compiled: ${schema.$id ?? "missing $id"}`);
}

console.log(`Validated ${files.length} JSON Schemas.`);
