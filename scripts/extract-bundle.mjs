// One-off: decode the standalone design bundle HTML into its source assets.
// Usage: node scripts/extract-bundle.mjs "<html file>" [outdir]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync, inflateSync } from "node:zlib";

const file = process.argv[2];
const out = process.argv[3] ?? "extracted-design";
const html = readFileSync(file, "utf8");

function block(type) {
  const open = `<script type="${type}">`;
  const i = html.indexOf(open);
  if (i < 0) return null;
  const start = i + open.length;
  const end = html.indexOf("</script>", start);
  return html.slice(start, end).trim();
}

const manifest = JSON.parse(block("__bundler/manifest"));
mkdirSync(out, { recursive: true });

const idx = [];
for (const [uuid, e] of Object.entries(manifest)) {
  let bytes = Buffer.from(e.data, "base64");
  if (e.compressed) {
    try { bytes = gunzipSync(bytes); }
    catch { try { bytes = inflateSync(bytes); } catch {} }
  }
  const mime = e.mime || "";
  const rawName = e.name || e.path || e.filename || uuid;
  const name = String(rawName).replace(/[^A-Za-z0-9._/-]/g, "_").replace(/^\/+/, "");
  const isText = /text|json|javascript|css|html|svg|xml/.test(mime) ||
    /\.(js|jsx|ts|tsx|css|html|json|svg|md)$/.test(name);
  idx.push({ uuid, mime, name: rawName, bytes: bytes.length, isText });
  if (isText) {
    const full = out + "/" + name;
    mkdirSync(full.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(full, bytes);
  }
}
writeFileSync(out + "/_index.json", JSON.stringify(idx, null, 2));
console.log("assets:", idx.length);
console.log(idx.map((x) => `${x.isText ? "T" : "B"} ${String(x.bytes).padStart(8)}  ${x.mime.padEnd(28)} ${x.name ?? x.uuid}`).join("\n"));
