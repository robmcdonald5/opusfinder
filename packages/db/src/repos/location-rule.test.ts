import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { render } from "@test/db/render";

import { locationRule } from "./location-rule";

const JOBS = sql`j.lifecycle_state = 'active'`;

describe("locationRule — what it emits per user", () => {
  it("emits no filter and no place data for a user with no home and mode any", () => {
    const rule = locationRule({ mode: "any", home: null }, JOBS);
    expect(rule).toMatchObject({ ctes: null, join: null, passes: null });
  });

  it.each([
    ["remote_only", ["remote job (no home place set)", "on-site job; you want remote only"]],
    ["onsite_only", ["remote job; you want on-site only", "on-site job (no home place set)"]],
  ] as const)("with no home, %s filters on the remote flag alone", (mode, labels) => {
    const rule = locationRule({ mode, home: null }, JOBS);
    expect(rule.ctes).toBeNull();
    expect(rule.passes).not.toBeNull();
    expect(render(rule.verdict).params).toEqual(labels);
  });

  it("with a home, reads the place data once per query and labels every case", () => {
    const rule = locationRule({ mode: "any", home: { placeId: 4509177, radiusMiles: 25 } }, JOBS);
    const ctes = render(rule.ctes!).sql;
    expect(ctes).toContain("string_flags AS MATERIALIZED");
    expect(render(rule.verdict).params).toEqual([
      "remote job open to your country",
      "remote job naming no country",
      "remote job with a location not resolved yet",
      "remote job open only to other countries",
      "on-site job with a city within 25 mi",
      "on-site job naming your region and no city in it",
      "on-site job naming your region, with a location not resolved yet",
      "on-site job naming a city in your region beyond 25 mi",
      "on-site job with no usable place",
      "on-site job with no place near you",
    ]);
    // The pass/fail values are literals, so the CASE carries no untyped boolean params.
    expect(render(rule.passes!).params).toEqual([]);
  });
});
