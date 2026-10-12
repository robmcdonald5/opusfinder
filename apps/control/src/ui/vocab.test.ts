import { describe, expect, it } from "vitest";

import { changeLine } from "./vocab";

describe("changeLine", () => {
  it("shows a first value (the migration seed logs no from) as just the value", () => {
    expect(changeLine("ingest", null, "on")).toBe(
      '<a href="/stages/ingest" title="ingest">Ingest job boards</a> <span class="mode m-on">on</span>',
    );
  });
});
