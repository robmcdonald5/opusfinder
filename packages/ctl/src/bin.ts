import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

import { main } from "./cli";

// Entry point for `pnpm ctl`. Wires the real environment into main()'s injected deps. Sets
// process.exitCode instead of calling process.exit(): exiting mid-teardown of undici's sockets crashes
// libuv on Windows (memory: scripts-fetch-use-exitcode-not-exit).
process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  fileMode: (path) => {
    if (process.platform === "win32") return null;
    try {
      return statSync(path).mode;
    } catch {
      return null;
    }
  },
  fetch: (url, init) => fetch(url, init),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
});
