import { describe, expect, it, vi } from "vitest";

import {
  BodyReadError,
  ListingShapeError,
  ListingSplitter,
  MalformedBodyError,
  readListingPage,
} from "./listing-stream";

// Leaf pure-unit for the streamed listing read. The splitter only finds where each posting starts and
// ends, so its contract is: fed ANY chunking of a body, it yields exactly the postings JSON.parse would
// see, and the rest of the page with the array emptied — or it throws. A seeded fuzz pins the first half
// over adversarial strings (quotes, escapes, brackets and commas inside strings, a "jobs" that is a value
// or sits in a nested object); the cases below pin the throws and the stream handling.

const LIMITS = { maxItemChars: 100_000, maxEnvelopeChars: 100_000 };

/** Split `text` at the given cut points (clamped), feed every piece, return postings + envelope. */
function splitAll(key: string | null, text: string, cuts: number[]) {
  const splitter = new ListingSplitter(key, LIMITS);
  const items: unknown[] = [];
  let from = 0;
  for (const cut of [
    ...cuts.filter((c) => c > 0 && c < text.length).sort((a, b) => a - b),
    text.length,
  ]) {
    for (const item of splitter.push(text.slice(from, cut))) items.push(JSON.parse(item));
    from = cut;
  }
  return { items, envelope: splitter.end() };
}

/** A deterministic PRNG (mulberry32), so a failing fuzz case reproduces. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY = [
  '"',
  "\\",
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  "jobs",
  "\\u0041",
  "é",
  "😀",
  "\n",
  " ",
  " ",
];

function randomValue(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 2 ? 4 : 7));
  if (pick === 0)
    return Array.from(
      { length: Math.floor(next() * 6) },
      () => NASTY[Math.floor(next() * NASTY.length)],
    ).join("");
  if (pick === 1) return Math.floor(next() * 1e6) / 100;
  if (pick === 2) return next() < 0.5 ? null : next() < 0.5;
  if (pick === 3) return `plain ${Math.floor(next() * 1000)}`;
  if (pick === 4)
    return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 1));
  const obj: Record<string, unknown> = {};
  for (let i = Math.floor(next() * 4); i > 0; i--) {
    obj[next() < 0.2 ? "jobs" : `k${Math.floor(next() * 100)}`] = randomValue(next, depth + 1);
  }
  return obj;
}

describe("ListingSplitter", () => {
  it("yields exactly what JSON.parse sees, for any chunking (seeded fuzz)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const postings = Array.from({ length: Math.floor(next() * 8) }, () => randomValue(next, 1));
      const keyed = next() < 0.6;
      const before = { meta: randomValue(next, 1), note: next() < 0.5 ? "jobs" : "x" };
      const body = keyed ? { ...before, jobs: postings, after: randomValue(next, 1) } : postings;
      const text = next() < 0.5 ? JSON.stringify(body) : JSON.stringify(body, null, 2);
      const cuts = Array.from({ length: Math.floor(next() * 40) }, () =>
        Math.floor(next() * text.length),
      );

      const { items, envelope } = splitAll(keyed ? "jobs" : null, text, cuts);

      expect(items, `seed ${seed}`).toEqual(postings);
      expect(envelope, `seed ${seed}`).toEqual(keyed ? { ...body, jobs: [] } : []);
    }
  });

  it("splits at every single position of a body full of escapes", () => {
    const postings = [
      { t: 'a "quoted" \\ back\\slash', u: "\\\\" },
      "]}",
      ["[", { x: "\\" }],
      null,
      3,
    ];
    const text = JSON.stringify({ x: 'value with "jobs":[', jobs: postings });
    const cuts = Array.from({ length: text.length }, (_, i) => i);

    expect(splitAll("jobs", text, cuts).items).toEqual(postings);
  });

  it("takes the root key only: not a value that reads the same, not a nested key", () => {
    const text = JSON.stringify({ a: "jobs", meta: { jobs: [1] }, jobs: [2] });
    expect(splitAll("jobs", text, [])).toEqual({
      items: [2],
      envelope: { a: "jobs", meta: { jobs: [1] }, jobs: [] },
    });
  });

  it.each([
    ["no postings array", "jobs", '{"other":[]}'],
    ["a postings key that isn't an array", "jobs", '{"jobs":{"a":[1]}}'],
    ["two postings arrays", "jobs", '{"jobs":[1],"jobs":[2]}'],
    ["an array where an object belongs", "jobs", "[]"],
    ["an object where an array belongs", null, '{"jobs":[]}'],
    ["a scalar body", "jobs", '"<html>maintenance</html>"'],
    ["a null body", null, "null"],
  ])("throws a ListingShapeError on %s", (_case, key, text) => {
    expect(() => splitAll(key, text, [])).toThrow(ListingShapeError);
  });

  it.each([
    ["an HTML page", "<html>maintenance</html>"],
    ["a truncated body", '{"jobs":[{"id":1},'],
    ["an empty body", ""],
    ["a trailing comma", '{"jobs":[1,]}'],
    ["a leading comma", '{"jobs":[,1]}'],
    ["a doubled comma", '{"jobs":[1,,2]}'],
    ["text after the JSON", '{"jobs":[]} x'],
    ["a second JSON value", '{"jobs":[]}{}'],
  ])("throws a SyntaxError on %s", (_case, text) => {
    expect(() => splitAll("jobs", text, [])).toThrow(SyntaxError);
  });

  it("refuses a posting, or page text around the array, over its limit", () => {
    const small = { maxItemChars: 50, maxEnvelopeChars: 50 };
    const posting = new ListingSplitter("jobs", small);
    expect(() => posting.push(`{"jobs":[{"text":"${"x".repeat(60)}"}]}`)).toThrow(
      ListingShapeError,
    );
    const spread = new ListingSplitter("jobs", small);
    spread.push('{"jobs":[{"text":"');
    expect(() => spread.push("x".repeat(60))).toThrow(ListingShapeError); // the cap holds across chunks
    const envelope = new ListingSplitter("jobs", small);
    expect(() => envelope.push(`{"blurb":"${"x".repeat(60)}","jobs":[]}`)).toThrow(
      ListingShapeError,
    );
  });
});

/** A body served one Uint8Array per read. */
function bodyOf(chunks: Uint8Array[], fail?: Error): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
      else if (fail) controller.error(fail);
      else controller.close();
    },
  });
}

const listing = { itemsKey: "jobs" };

describe("readListingPage", () => {
  it("decodes UTF-8 split anywhere, even mid-character", async () => {
    const postings = [{ title: "Ingénieur 😀 — Zürich" }, { title: "日本語" }];
    const bytes = new TextEncoder().encode(JSON.stringify({ jobs: postings }));
    const got: unknown[] = [];

    const page = await readListingPage(
      bodyOf(Array.from(bytes, (b) => Uint8Array.of(b))),
      listing,
      (items) => {
        got.push(...items);
      },
    );

    expect(got).toEqual(postings);
    expect(page).toEqual({ jobs: [] });
  });

  it("hands over only what keepItem keeps", async () => {
    const got: unknown[] = [];
    await readListingPage(
      new Response(JSON.stringify({ jobs: [1, 2, 3] })).body,
      { itemsKey: "jobs", keepItem: (item) => item !== 2 },
      (items) => {
        got.push(...items);
      },
    );
    expect(got).toEqual([1, 3]);
  });

  it("stops early when onItems returns false, cancelling the rest of the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new TextEncoder().encode('{"jobs":[1,2,')),
      cancel,
    });

    await expect(readListingPage(body, listing, () => false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("wraps each failure by kind, and passes onItems' own error through", async () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    await expect(
      readListingPage(bodyOf([enc('{"jobs":[1,')], new TypeError("reset")), listing, () => {}),
    ).rejects.toBeInstanceOf(BodyReadError);
    await expect(
      readListingPage(bodyOf([enc("<html>")]), listing, () => {}),
    ).rejects.toBeInstanceOf(MalformedBodyError);
    await expect(
      readListingPage(bodyOf([enc('{"jobs":[{]}')]), listing, () => {}),
    ).rejects.toBeInstanceOf(MalformedBodyError);
    await expect(readListingPage(null, listing, () => {})).rejects.toBeInstanceOf(
      MalformedBodyError,
    );
    await expect(readListingPage(bodyOf([enc("{}")]), listing, () => {})).rejects.toBeInstanceOf(
      ListingShapeError,
    );
    const own = new Error("sink down");
    await expect(
      readListingPage(bodyOf([enc('{"jobs":[1]}')]), listing, () => {
        throw own;
      }),
    ).rejects.toBe(own);
  });
});
