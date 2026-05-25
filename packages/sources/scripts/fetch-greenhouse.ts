import { fetchJobs } from "../src/greenhouse";

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: pnpm --filter @opusfinder/sources fetch:greenhouse <slug>");
    process.exitCode = 1;
    return;
  }

  const jobs = await fetchJobs(slug);
  console.log(`Fetched ${jobs.length} jobs for "${slug}":`);
  // `raw` carries the full source payload (large HTML per job) — replace it in the
  // printout so the output stays readable. The field itself still carries `raw`.
  const printable = jobs.map((job) => ({ ...job, raw: "[omitted]" }));
  console.log(JSON.stringify(printable, null, 2));
}

// Set exitCode rather than calling process.exit(): an abrupt exit while an undici
// socket handle is still closing trips a libuv assertion on Windows. Letting the
// event loop drain exits cleanly once fetchJobs has released its handles.
main().catch((err: unknown) => {
  console.error(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
