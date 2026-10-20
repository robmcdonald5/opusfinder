import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  answerMatches,
  loadGolden,
  scoreGolden,
  type GoldenEntry,
  type GoldenExpected,
} from "./locations-golden";

const DUBLIN_OH: GoldenExpected = {
  places: [{ geonamesId: 5152333, name: "Dublin", region: "Ohio", country: "US", kind: "city" }],
  remoteCountries: [],
  areas: [],
};

function entry(over: Partial<GoldenEntry> = {}): GoldenEntry {
  return {
    id: "g001",
    category: "bare",
    company: { slug: "acme", source: "greenhouse" },
    raw: "Dublin",
    jobs: 3,
    otherStrings: ["Columbus, OH"],
    expected: DUBLIN_OH,
    ...over,
  };
}

describe("golden set", () => {
  it("loads labeled and unlabeled entries, rejecting duplicates and bad shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    const good = join(dir, "good.jsonl");
    const { expected: _drop, ...unlabeled } = entry({ id: "g002" });
    writeFileSync(good, `${JSON.stringify(entry())}\n\n${JSON.stringify(unlabeled)}\n`);
    expect(loadGolden(good).map((e) => [e.id, Boolean(e.expected)])).toEqual([
      ["g001", true],
      ["g002", false],
    ]);

    const dup = join(dir, "dup.jsonl");
    writeFileSync(dup, `${JSON.stringify(entry())}\n${JSON.stringify(entry())}\n`);
    expect(() => loadGolden(dup)).toThrow(/duplicate id g001/);

    const bad = join(dir, "bad.jsonl");
    writeFileSync(
      bad,
      JSON.stringify({ ...entry(), expected: { places: [{ name: "x" }], remoteCountries: [] } }),
    );
    expect(() => loadGolden(bad)).toThrow(/geonamesId/);

    const alias = join(dir, "alias.jsonl");
    writeFileSync(
      alias,
      JSON.stringify({
        ...entry(),
        expected: { places: [], remoteCountries: [], areas: ["LATAM"] },
      }),
    );
    expect(() => loadGolden(alias)).toThrow(/"LATAM", which is not an area's name/);
  });

  it("scores expected areas as the countries they cover, and an area off the list as a miss", () => {
    const dach: GoldenExpected = { places: [], remoteCountries: ["US"], areas: ["DACH"] };
    expect(answerMatches(dach, { placeIds: [], remoteCountries: ["AT", "CH", "DE", "US"] })).toBe(
      true,
    );
    expect(answerMatches(dach, { placeIds: [], remoteCountries: ["DE", "US"] })).toBe(false);
    expect(
      answerMatches(
        { places: [], remoteCountries: [], areas: [] },
        {
          placeIds: [],
          remoteCountries: [],
          unmatched: [{ kind: "area", name: "Atlantic Rim", why: "unknown-area" }],
        },
      ),
    ).toBe(false);
  });

  it("matches exactly on place-id and remote-country sets, in any order", () => {
    const two: GoldenExpected = {
      places: [
        { geonamesId: 1, name: "A", region: null, country: "US", kind: "city" },
        { geonamesId: 2, name: "B", region: null, country: "US", kind: "city" },
      ],
      remoteCountries: ["CA", "US"],
      areas: [],
    };
    expect(answerMatches(two, { placeIds: [2, 1], remoteCountries: ["US", "CA"] })).toBe(true);
    expect(answerMatches(two, { placeIds: [1], remoteCountries: ["US", "CA"] })).toBe(false);
    expect(answerMatches(two, { placeIds: [1, 2, 3], remoteCountries: ["US", "CA"] })).toBe(false);
    expect(answerMatches(two, { placeIds: [1, 2], remoteCountries: ["US"] })).toBe(false);
  });

  it("scores overall, by category, and without the strings the prompt quotes", () => {
    const score = scoreGolden(
      [
        { entry: entry({ id: "a", raw: "Dublin" }), correct: true },
        { entry: entry({ id: "b", raw: "Columbus, OH", category: "plain" }), correct: true },
        { entry: entry({ id: "c", raw: "Cambridge" }), correct: false },
      ],
      new Set(["Columbus, OH"]),
    );
    expect(score).toMatchObject({
      n: 3,
      correct: 2,
      byCategory: { bare: { n: 2, correct: 1 }, plain: { n: 1, correct: 1 } },
    });
    expect(score.unseen).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
  });
});
