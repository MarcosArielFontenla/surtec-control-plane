import { parse, parseDocument } from "yaml";

const maxEntries = 64;
const maxSourceBytes = 64 * 1024;
const parsedRegistries = new Map<string, object>();

/** Reuse decoding only. Callers still read current files and validate each detached result. */
export function parseRegistryYaml(source: string): unknown {
  const cached = parsedRegistries.get(source);
  if (cached) return structuredClone(cached);

  if (Buffer.byteLength(source) > maxSourceBytes) return parse(source);
  const document = parseDocument(source);
  // Let the original parser report warnings and errors for each read.
  if (document.errors.length || document.warnings.length) return parse(source);
  const parsed: unknown = document.toJS();
  if (!parsed || typeof parsed !== "object") return parsed;

  if (parsedRegistries.size === maxEntries) {
    const first = parsedRegistries.keys().next();
    if (!first.done) parsedRegistries.delete(first.value);
  }
  parsedRegistries.set(source, structuredClone(parsed));
  return parsed;
}
