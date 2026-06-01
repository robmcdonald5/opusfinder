/**
 * One consistent failure tail for every tsx CLI entry point in the repo, so the
 * teardown contract (and the Windows caveat below) lives in ONE place instead of
 * being re-derived by copy-paste in each script — which is how two db scripts
 * drifted onto the crash-prone `process.exit(1)` and one script forgot the catch
 * entirely.
 *
 * Runs `main`; on a thrown error logs `${label} failed: <message>` and sets
 * `process.exitCode = 1`. It deliberately does NOT call `process.exit()`: an abrupt
 * exit while an undici / neon-http socket handle is still closing trips a libuv
 * assertion on Windows (UV_HANDLE_CLOSING, exit code 3221226505). Setting exitCode
 * lets the event loop drain those handles and then exit cleanly with the right code.
 *
 * A body that handles its own non-throwing failure (e.g. a usage error that sets
 * `process.exitCode = 1` and returns) is left untouched — runScript only owns the
 * thrown path.
 */
export async function runScript(label: string, main: () => void | Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    console.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
