import { unsafeCompanySlug } from "@opusfinder/shared";
import type { SourceName } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { adapters, SOURCE_NAMES } from "./index";
import { ListingShapeError, readListingPage } from "./listing-stream";
import type { SourceContext } from "./types";

// Leaf pure-unit for each adapter's listing request and response envelope. The query params are
// load-bearing (without `?content=true` / `?details=true` every description arrives blank, and the
// blank-description guard hides it), and reading a broken envelope must THROW: an empty array would
// read as an empty board, which discovery's probe counts as proof the slug exists.
const ctx: SourceContext = { slug: unsafeCompanySlug("acme"), rawSlug: "acme" };

const LISTINGS = {
  greenhouse: {
    url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    envelope: (jobs: unknown[]) => ({ jobs, meta: { total: jobs.length } }),
  },
  lever: {
    url: "https://api.lever.co/v0/postings/acme?mode=json",
    envelope: (jobs: unknown[]) => jobs,
  },
  ashby: {
    url: "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
    envelope: (jobs: unknown[]) => ({ jobs, apiVersion: "1" }),
  },
  workable: {
    url: "https://apply.workable.com/api/v1/widget/accounts/acme?details=true",
    envelope: (jobs: unknown[]) => ({ name: "Acme", description: "<p>About Acme</p>", jobs }),
  },
  smartrecruiters: {
    url: "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=0",
    envelope: (jobs: unknown[]) => ({ content: jobs, totalFound: jobs.length }),
  },
  recruitee: {
    url: "https://acme.recruitee.com/api/offers/",
    envelope: (jobs: unknown[]) => ({ offers: jobs }),
  },
  pinpoint: {
    url: "https://acme.pinpointhq.com/postings.json",
    envelope: (jobs: unknown[]) => ({ data: jobs }),
  },
  gem: {
    url: "https://api.gem.com/job_board/v0/acme/job_posts/",
    envelope: (jobs: unknown[]) => jobs,
  },
  trakstar: {
    url: "https://jsapi.recruiterbox.com/v1/openings/?client_name=acme&limit=20&offset=0",
    envelope: (jobs: unknown[]) => ({ meta: { total: jobs.length }, objects: jobs }),
  },
} satisfies Record<SourceName, { url: string; envelope: (jobs: unknown[]) => unknown }>;

/** The postings `source`'s adapter streams out of `body`, served as JSON the way its API sends it. */
async function postingsOf(source: SourceName, body: unknown): Promise<unknown[]> {
  const postings: unknown[] = [];
  await readListingPage(new Response(JSON.stringify(body)).body, adapters[source], (items) => {
    postings.push(...items);
  });
  return postings;
}

describe("adapter listing request + envelope", () => {
  it.each(SOURCE_NAMES)("%s requests the exact first-page URL", (source) => {
    expect(adapters[source].jobsRequest(ctx, null).url).toBe(LISTINGS[source].url);
  });

  it.each(SOURCE_NAMES)("%s finds the postings array in its envelope", async (source) => {
    const postings = [{ id: "1" }, { id: "2" }];
    expect(await postingsOf(source, LISTINGS[source].envelope(postings))).toEqual(postings);
  });

  it.each(SOURCE_NAMES)("%s throws on a broken envelope", async (source) => {
    const bareArray = Array.isArray(LISTINGS[source].envelope([]));
    for (const body of [null, "<html>maintenance</html>", 42, {}, bareArray ? { jobs: [] } : []]) {
      await expect(postingsOf(source, body)).rejects.toBeInstanceOf(ListingShapeError);
    }
  });

  it("the offset-paged adapters request the cursor's offset", () => {
    const cursor = { kind: "offset", offset: 100 } as const;
    expect(adapters.smartrecruiters.jobsRequest(ctx, cursor).url).toBe(
      "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=100",
    );
    expect(adapters.trakstar.jobsRequest(ctx, cursor).url).toBe(
      "https://jsapi.recruiterbox.com/v1/openings/?client_name=acme&limit=20&offset=100",
    );
  });
});
