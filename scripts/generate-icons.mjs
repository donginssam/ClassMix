import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@tauri-apps/cli";

const iconDirectory = fileURLToPath(new URL("../src-tauri/icons/", import.meta.url));
const outputDirectory = await mkdtemp(join(tmpdir(), "classmix-icons-"));

try {
  await run(["icon", join(iconDirectory, "app-icon.svg"), "--output", outputDirectory], "pnpm icons");

  // Tauri writes desktop icons at the output root and mobile icons in subdirectories.
  for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
    if (entry.isFile()) {
      await copyFile(join(outputDirectory, entry.name), join(iconDirectory, entry.name));
    }
  }
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
