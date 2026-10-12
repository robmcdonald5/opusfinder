import { describe, expect, it } from "vitest";

import { createDb } from "./client";

const CONN = "postgresql://neondb_owner:npg_s3cret@ep-x.neon.tech/neondb";

function createDbError(connectionString: string): Error {
  let caught: unknown;
  try {
    createDb(connectionString);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

// The scrapers Worker builds its client from a pasted secret, and anything createDb throws there lands in
// Workers Logs: a malformed value must never echo the password.
describe("createDb", () => {
  it.each([
    ["single-quoted", `'${CONN}'`],
    ["leading space", ` ${CONN}`],
    ["unencoded # in the password", CONN.replace("s3cret", "s3#cret")],
  ])("names only the shape of a malformed connection string (%s)", (_, value) => {
    const err = createDbError(value);

    expect(err.message).not.toMatch(/s3#?cret|neondb_owner|neon\.tech/);
    expect(err.message).toContain(`length ${value.length}`);
    expect(err.cause).toBeUndefined();
  });
});
