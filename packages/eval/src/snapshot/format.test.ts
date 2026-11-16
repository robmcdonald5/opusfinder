import { describe, expect, it } from "vitest";

import { snapshotJob } from "@test/eval/snapshot";

import {
  decodeJsonl,
  decodeVectors,
  encodeJsonl,
  encodeVectors,
  jobFlags,
  jobsPartPath,
  SHORT_DESCRIPTION_CHARS,
  sliceOfPart,
  SnapshotJobSchema,
  snapshotEmbedText,
  TEXT_CAP_CHARS,
  truncateVector,
  vectorsPartPath,
} from "./format";

describe("jobFlags", () => {
  const long = "x".repeat(SHORT_DESCRIPTION_CHARS);

  it("flags nothing on an ordinary posting, including a two-letter title", () => {
    expect(jobFlags({ title: "RN", descriptionText: long })).toEqual([]);
  });

  it("flags a blank description, and a short one, but never both", () => {
    expect(jobFlags({ title: "Cook", descriptionText: "  \n " })).toEqual(["blank_description"]);
    expect(jobFlags({ title: "Cook", descriptionText: long.slice(1) })).toEqual([
      "short_description",
    ]);
  });

  it("flags a title with fewer than two letters or digits", () => {
    expect(jobFlags({ title: "d", descriptionText: long })).toEqual(["short_title"]);
    expect(jobFlags({ title: "--", descriptionText: long })).toEqual(["short_title"]);
    expect(jobFlags({ title: "看护", descriptionText: long })).toEqual([]);
  });

  it("flags text longer than the shared cap", () => {
    expect(jobFlags({ title: "Analyst", descriptionText: "y".repeat(TEXT_CAP_CHARS) })).toEqual([
      "capped",
    ]);
  });
});

describe("snapshotEmbedText", () => {
  it("is production's title + description, untouched under the cap", () => {
    expect(snapshotEmbedText({ title: "Nurse", descriptionText: "Night shift." })).toEqual({
      text: "Nurse\n\nNight shift.",
      capped: false,
    });
  });

  it("cuts at the cap without splitting a surrogate pair", () => {
    // The emoji's two code units straddle the cap, so the cut lands one unit earlier.
    const descriptionText = `${"a".repeat(TEXT_CAP_CHARS - "T\n\n".length - 1)}😀tail`;
    const { text, capped } = snapshotEmbedText({ title: "T", descriptionText });
    expect(capped).toBe(true);
    expect(text).toHaveLength(TEXT_CAP_CHARS - 1);
    expect(text.endsWith("a")).toBe(true);
  });
});

describe("object paths", () => {
  it("pairs a vectors part with its jobs part and reads the slice back", () => {
    const jobs = jobsPartPath("public", 12);
    expect(jobs).toBe("jobs/public-0012.jsonl.gz");
    const vectors = vectorsPartPath("qwen3-embedding-8b", jobs);
    expect(vectors).toBe("vectors/qwen3-embedding-8b/public-0012.f32");
    expect(sliceOfPart(jobs)).toBe("public");
    expect(sliceOfPart(vectors)).toBe("public");
    expect(() => vectorsPartPath("m", "companies/part-0000.jsonl.gz")).toThrow(/not a jobs part/);
  });
});

describe("jsonl objects", () => {
  it("round-trips rows and gives equal bytes for equal rows", () => {
    const rows = [snapshotJob(1), snapshotJob(2, { title: "Línea ✓" })];
    const bytes = encodeJsonl(rows);
    expect(decodeJsonl(bytes, SnapshotJobSchema, "p")).toEqual(rows);
    expect(Buffer.from(encodeJsonl(rows)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("names the object and line of a row that breaks the schema", () => {
    const bytes = encodeJsonl([snapshotJob(1), { ...snapshotJob(2), remote: "yes" }]);
    expect(() => decodeJsonl(bytes, SnapshotJobSchema, "jobs/ats-0000.jsonl.gz")).toThrow(
      /jobs\/ats-0000\.jsonl\.gz line 2/,
    );
  });
});

describe("vector objects", () => {
  it("round-trips float32 rows", () => {
    const bytes = encodeVectors(
      [
        [0.5, -0.25, 0],
        [1, 2, 3],
      ],
      3,
    );
    expect(bytes.byteLength).toBe(2 * 3 * 4);
    expect(Array.from(decodeVectors(bytes, 3, "v"))).toEqual([0.5, -0.25, 0, 1, 2, 3]);
  });

  it("refuses a wrong width, a non-finite value, and a ragged block", () => {
    expect(() => encodeVectors([[1, 2]], 3)).toThrow(/2 dims; expected 3/);
    expect(() => encodeVectors([[1, Number.NaN, 3]], 3)).toThrow(/non-finite/);
    expect(() => decodeVectors(new Uint8Array(13), 3, "vectors/m/ats-0000.f32")).toThrow(
      /vectors\/m\/ats-0000\.f32: 13 bytes/,
    );
  });
});

describe("truncateVector", () => {
  it("keeps the leading components and restores unit length", () => {
    const cut = truncateVector([0.6, 0.8, 0.5, 0.5], 2);
    expect(Array.from(cut)).toEqual(Array.from(new Float32Array([0.6, 0.8])));
    const rescaled = truncateVector([3, 4, 12], 2);
    expect(rescaled[0]).toBeCloseTo(0.6, 6);
    expect(rescaled[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves an all-zero vector as zeros and refuses to widen", () => {
    expect(Array.from(truncateVector([0, 0, 0], 2))).toEqual([0, 0]);
    expect(() => truncateVector([1, 0], 3)).toThrow(/cannot widen/);
  });
});
