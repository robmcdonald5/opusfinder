import { expect, it } from "vitest";

import { DIMENSIONS } from "@opusfinder/control";

import { SEED_LANES } from "./seed";

// The control plane's `lane` dimension (discover@lane=<name> overrides) mirrors SEED_LANES, which its pure
// package can't import. Adding a lane without its registry value (or the reverse) fails here.
it("the control registry's lane dimension lists exactly the seed lanes", () => {
  expect([...DIMENSIONS.lane].sort()).toEqual(SEED_LANES.map((l) => l.name).sort());
});
