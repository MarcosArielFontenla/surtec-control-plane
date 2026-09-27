import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = join(root, "schemas");
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
ajv.addFormat("date", {
  type: "string",
  validate: (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day >= 1 && day <= daysInMonth;
  },
});
const files = readdirSync(schemaDirectory).filter((name) => name.endsWith(".schema.json")).sort();
const schemas = files.map((file) => JSON.parse(readFileSync(join(schemaDirectory, file), "utf8")));

for (const schema of schemas) ajv.addSchema(schema);
for (const schema of schemas) {
  if (!ajv.getSchema(schema.$id)) throw new Error(`Schema was not compiled: ${schema.$id ?? "missing $id"}`);
}

console.log(`Validated ${files.length} JSON Schemas.`);
