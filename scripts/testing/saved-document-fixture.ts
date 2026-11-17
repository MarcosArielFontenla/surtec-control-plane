import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect } from "vitest";

const prefix = "surtec-saved-document-";

export function verifySavedDocumentFixture(fileName: string, bytes: Buffer, check: (path: string) => void) {
  if (!/^[a-z][a-z-]*\.json$/.test(fileName)) throw new Error("Invalid saved document fixture file name.");

  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, prefix));
  const original = lstatSync(root, { bigint: true });
  const file = join(root, fileName);
  try {
    writeFileSync(file, bytes, { flag: "wx" });
    try {
      check(file);
    } finally {
      expect(readdirSync(root), "the read preserves the temporary inventory").toEqual([fileName]);
      expect(lstatSync(file).isFile(), "the saved document remains a regular file").toBe(true);
      expect(readFileSync(file), "the read preserves the saved bytes").toEqual(bytes);
    }
  } finally {
    const current = lstatSync(root, { bigint: true });
    if (dirname(root) !== parent || !basename(root).startsWith(prefix) || !current.isDirectory()
      || current.isSymbolicLink() || realpathSync.native(root) !== root
      || original.ino === 0n || current.ino !== original.ino || current.dev !== original.dev) {
      throw new Error("Unable to verify the saved document fixture root for cleanup.");
    }
    rmSync(root, { recursive: true });
    expect(lstatSync(root, { throwIfNoEntry: false }), "the owned fixture was removed").toBeUndefined();
  }
}
