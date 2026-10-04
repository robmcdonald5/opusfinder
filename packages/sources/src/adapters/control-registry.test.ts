import { expect, it } from "vitest";

import { DIMENSIONS } from "@opusfinder/control";

import { SOURCE_NAMES } from "./index";

// The control plane's `source` dimension (ingest@source=<name> overrides) mirrors the adapter registry,
// which its pure package can't import. Adding an adapter without its registry value (or the reverse)
// fails here, so the panel and `pnpm ctl` can always narrow every source.
it("the control registry's source dimension lists exactly the adapters", () => {
  expect([...DIMENSIONS.source].sort()).toEqual([...SOURCE_NAMES].sort());
});
