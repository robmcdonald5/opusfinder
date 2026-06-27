/**
 * Build the real labeled set from the gitignored candidates export + the profiles and labels
 * below, writing data/dataset.jsonl (the committed, hermetic source of truth).
 *
 * Why a generator instead of hand-authoring: each example's candidate pool is the FULL ingested
 * board (all jobs, no curation bias) — too large to hand-type and must stay in sync with real
 * jobs.id values. Regeneration path: re-run export:candidates, then this.
 *
 * PROFILES are anonymized from real CVs — NO PII (no names, contact, employers, schools, URLs),
 * only role focus / skills / target roles, per the package README's PII rule.
 *
 * LABELS are agent-drafted; the CV owner is the authority and may refine `goodIds` directly in
 * dataset.jsonl (or here + re-run).
 *
 *   pnpm --filter @opusfinder/eval build:dataset
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";

import { parseDatasetLines } from "../src/dataset";
import { PKG_ROOT } from "../src/runner";
import type { EvalExample, EvalJob, EvalProfile } from "../src/types";

interface ExportJob {
  id: number;
  title: string;
  descriptionText: string;
  locations: string[];
  remote: boolean;
  source: string;
  companyId: number;
}

interface Labeled {
  profile: EvalProfile;
  goodIds: number[];
  notes: string;
}

const LABELS: Labeled[] = [
  {
    profile: {
      id: "swe-fullstack-ai",
      summary:
        "Recent computer science graduate and software engineer focused on Python development, " +
        "machine learning, and scalable web applications. Experience building automated solutions, " +
        "data pipelines, and server infrastructure; recent work on AI/ML dataset training and " +
        "annotation (RLHF), and earlier backend development for high-concurrency game servers. " +
        "Personal projects include a developer-tooling scaffolding CLI, a Rust/WebAssembly " +
        "image-to-SVG vectorizer, and an NLP-based ordering chatbot. Seeking a software engineering " +
        "role contributing in a modern engineering team.",
      skills: [
        "Python",
        "JavaScript",
        "TypeScript",
        "SQL",
        "Rust",
        "PyTorch",
        "scikit-learn",
        "spaCy",
        "LangChain",
        "LangGraph",
        "Pandas",
        "NumPy",
        "SvelteKit",
        "React",
        "Flask",
        "FastAPI",
        "REST APIs",
        "WebAssembly",
        "PostgreSQL",
        "MongoDB",
        "Supabase",
        "Prisma",
        "Docker",
        "Kubernetes",
        "Azure",
        "GitHub Actions",
      ],
      targetRoles: [
        "Software Engineer",
        "Backend Engineer",
        "Full-Stack Engineer",
        "Machine Learning Engineer",
        "AI Engineer",
      ],
      preferences: { remote: true },
    },
    // Good = product software-engineering IC roles that fit Python/AI/full-stack skills.
    // 9 Design Engineer, 31 Media Engineer (Social), 56-68 the "Software Engineer, *" roles.
    goodIds: [9, 31, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68],
    notes:
      "Anonymized from a real CV (recent-grad full-stack/AI software engineer). Good = product " +
      "software-engineering IC roles matching Python/AI/full-stack skills. Excluded as weaker " +
      "matches: customer-facing eng (Solutions Architect, Forward-Deployed, Developer Success, " +
      "Customer Support Engineer), engineering managers, senior-only roles (Sr SWE Trust & Safety), " +
      "and stack mismatches (Mobile Engineer). Borderline excluded: GTM Engineer, Site Engineer, " +
      "IT Ops Engineer. Agent-drafted; CV owner is the authority and may refine.",
  },
  {
    profile: {
      id: "finance-systems-eng",
      summary:
        "Finance systems engineer with an accounting background and 4+ years owning NetSuite and " +
        "surrounding finance/operations SaaS platforms (procurement, contract management, spend). " +
        "Primary technical owner of six finance systems; builds Python/iPaaS ETL integrations " +
        "(Dell Boomi, Rivery), full-stack internal web apps (JavaScript, Firebase, PostgreSQL), and " +
        "BigQuery/PostgreSQL executive dashboards; leads governance, controls, and an AI-enablement " +
        "initiative. Drawn to roles shaping how finance and operations systems are architected, " +
        "integrated, and governed, not just maintained.",
      skills: [
        "NetSuite",
        "Coupa",
        "Dell Boomi",
        "Rivery",
        "Python",
        "JavaScript",
        "SQL",
        "ETL/ELT pipelines",
        "integration architecture",
        "Google BigQuery",
        "PostgreSQL",
        "Firebase",
        "financial reporting",
        "reconciliations",
        "month-end close",
        "controls and governance",
        "executive dashboards",
      ],
      targetRoles: [
        "Finance Systems Engineer",
        "Enterprise Systems Analyst",
        "ERP/NetSuite Administrator",
        "Integration Engineer",
        "FP&A Systems Analyst",
      ],
      preferences: { remote: false, locations: ["Dallas, TX"] },
    },
    // Hard case: this dev-tools board has no finance-systems-engineering role. Good = closest
    // finance / operations / internal-systems matches: 20 FP&A Manager, 28 IT Ops Engineer,
    // 37 Revenue Manager, 46 Sr Manager Corporate Accounting.
    goodIds: [20, 28, 37, 46],
    notes:
      "Anonymized from a real CV (finance-systems engineer; accounting background, NetSuite/ETL/" +
      "governance). HARD CASE: the board has no finance-systems-engineering role, so good = the " +
      "closest finance/operations/internal-systems matches (FP&A, Revenue, Corporate Accounting " +
      "management, IT Ops Engineer). Pure SWE, sales, legal, and other non-finance roles excluded. " +
      "Intentionally conservative — few strong fits exist here; this example stresses precision.",
  },
];

function main(): void {
  const exportPath = join(PKG_ROOT, "data", "candidates-export.json");
  if (!existsSync(exportPath)) {
    throw new Error(
      `${exportPath} not found — run \`pnpm --filter @opusfinder/eval export:candidates\` first.`,
    );
  }
  // Guard the parse: a truncated (interrupted export) or hand-edited file would otherwise
  // throw a raw SyntaxError, defeating the friendly missing/empty-file guidance right above.
  let jobs: ExportJob[];
  try {
    jobs = JSON.parse(readFileSync(exportPath, "utf8")) as ExportJob[];
  } catch (err) {
    throw new Error(
      `${exportPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        "Re-run `pnpm --filter @opusfinder/eval export:candidates` to regenerate it.",
      { cause: err },
    );
  }
  if (jobs.length === 0) {
    throw new Error(
      "candidates-export.json is empty — run `pnpm --filter @opusfinder/eval export:candidates` first.",
    );
  }
  // Drop contentless rows (blank title AND description): production never embeds them
  // (jobsNeedingEmbedding filters them in SQL because the embedder 400s on ""), so the eval
  // pool must exclude them too, or the embedding ranker crashes on them. Log the count — a
  // silent drop would read as "the whole board was labeled" when it wasn't.
  const embeddable = jobs.filter((j) => j.title.trim() !== "" || j.descriptionText.trim() !== "");
  const droppedContentless = jobs.length - embeddable.length;
  if (droppedContentless > 0) {
    console.error(`Dropped ${droppedContentless} contentless job(s) (blank title + description).`);
  }
  const byId = new Map(embeddable.map((j) => [j.id, j]));
  const candidateJobs: EvalJob[] = embeddable.map((j) => ({
    id: j.id,
    // Store the RAW title (not trimmed): production's jobEmbeddingText composes from the raw
    // jobs.title, so trimming here would make the eval embed different text than what ships,
    // breaking the harness's "embed identically to ingestion" invariant. descriptionText is
    // likewise raw. (The audit print below trims for readability only.)
    title: j.title,
    descriptionText: j.descriptionText,
    locations: j.locations,
    remote: j.remote,
  }));

  const lines: string[] = [];
  for (const { profile, goodIds, notes } of LABELS) {
    console.error(`\n[${profile.id}] ${goodIds.length} good of ${candidateJobs.length}:`);
    for (const goodId of goodIds) {
      const j = byId.get(goodId);
      if (!j) {
        throw new Error(
          `good id ${goodId} (${profile.id}) is not in the embeddable export — stale id, or a ` +
            `contentless job that was dropped?`,
        );
      }
      console.error(`  ${String(goodId).padStart(3)}  ${j.title.trim()}`);
    }
    const example: EvalExample = { profile, candidateJobs, expectedGoodIds: goodIds, notes };
    lines.push(JSON.stringify(example));
  }

  const header =
    "# Real labeled set (Phase 5). Profiles anonymized from real CVs (NO PII). Candidate pool =\n" +
    "# all ingested jobs. Labels agent-drafted; the CV owner is the authority. Regenerate via\n" +
    "# `pnpm --filter @opusfinder/eval build:dataset` (after export:candidates). One example/line.\n";
  const content = `${header}${lines.join("\n")}\n`;
  // Validate through the EXACT load-time path before committing: the generation boundary must not
  // emit a dataset.jsonl the loader would reject (contentless profile/job, duplicate candidate ids,
  // out-of-pool good id). parseDatasetLines throws with a line number on any violation.
  parseDatasetLines(content, "build-dataset output");
  writeFileSync(join(PKG_ROOT, "data", "dataset.jsonl"), content, "utf8");
  console.error(
    `\nWrote data/dataset.jsonl: ${LABELS.length} examples, ${candidateJobs.length} candidates each.`,
  );
}

await runScript("Build", main);
