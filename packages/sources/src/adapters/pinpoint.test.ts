import { companySlug } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { pinpointAdapter } from "./pinpoint";
import type { SourceContext } from "./types";

// Phase 1 leaf pure-unit (no DB/network). Locks pinpointAdapter.mapItem — the raw postings.json item →
// NormalizedJob mapping. Load-bearing pinpoint quirks: (1) postedAt is ALWAYS null (the only date is
// deadline_at, an application-CLOSE date that must never be treated as a post date); (2) `remote` comes
// from the structured lowercase `workplace_type` enum and falls back to location text ONLY when the enum
// is absent/unknown; (3) `location.name` is an internal office label (literally "Remote" sometimes) and is
// a TRAP — locations compose from city + province and name must never leak into geography OR the remote
// signal; (4) the apply URL is the explicit `url` field (never slug-derived) and a missing url drops the job.

// Frozen, deterministic context — the branded slug the runAdapter would have produced upstream.
const CTX: SourceContext = Object.freeze({
  slug: companySlug("acme-corp"),
  rawSlug: "Acme-Corp",
});

// A realistic, frozen postings.json item: explicit UUID-based apply url, single-encoded HTML description
// with a <!--block--> marker + entity, an office-label `location.name`, the structured remote enum, and a
// deadline_at + nested job.id that the mapper must IGNORE.
const RAW_REMOTE = Object.freeze({
  id: "8a1b2c3d",
  title: "Senior Platform Engineer",
  url: "https://acme-corp.pinpointhq.com/en/postings/4f1e2d3c-9b8a-4c1d-8e2f-1a2b3c4d5e6f",
  description: "<p>Build &amp; ship the <strong>platform.</strong><!--block--></p>",
  workplace_type: "remote",
  location: Object.freeze({ name: "London HQ", city: "Austin", province: "Texas" }),
  job: Object.freeze({ id: 99201 }),
  deadline_at: "2026-08-01T00:00:00Z",
});

describe("pinpointAdapter.mapItem", () => {
  it("maps a full raw posting field-by-field", () => {
    expect(pinpointAdapter.mapItem(RAW_REMOTE, CTX)).toEqual({
      source: "pinpoint",
      externalId: "8a1b2c3d",
      title: "Senior Platform Engineer",
      companySlug: "acme-corp",
      locations: ["Austin, Texas"],
      remote: true,
      descriptionText: "Build & ship the platform.",
      applyUrl: "https://acme-corp.pinpointhq.com/en/postings/4f1e2d3c-9b8a-4c1d-8e2f-1a2b3c4d5e6f",
      postedAt: null,
      raw: RAW_REMOTE,
    });
  });

  it("always sets postedAt to null even when deadline_at is present", () => {
    // deadline_at is an application-CLOSE date — never a post date.
    expect(pinpointAdapter.mapItem(RAW_REMOTE, CTX)?.postedAt).toBeNull();
  });

  it("preserves the company slug from context (no re-derivation from the item)", () => {
    expect(pinpointAdapter.mapItem(RAW_REMOTE, CTX)?.companySlug).toBe("acme-corp");
  });

  it("preserves title casing verbatim (no title-case transform)", () => {
    const raw = { ...RAW_REMOTE, title: "iOS engineer (UK) — REMOTE-friendly" };
    expect(pinpointAdapter.mapItem(raw, CTX)?.title).toBe("iOS engineer (UK) — REMOTE-friendly");
  });

  it("trims the posting id into the branded externalId", () => {
    const raw = { ...RAW_REMOTE, id: "  posting-77  " };
    expect(pinpointAdapter.mapItem(raw, CTX)?.externalId).toBe("posting-77");
  });

  it("keeps the untouched raw object on the normalized job", () => {
    expect(pinpointAdapter.mapItem(RAW_REMOTE, CTX)?.raw).toBe(RAW_REMOTE);
  });

  it("coerces a missing description to an empty string instead of throwing", () => {
    const { description: _drop, ...raw } = RAW_REMOTE;
    expect(pinpointAdapter.mapItem(raw, CTX)?.descriptionText).toBe("");
  });

  it("decodes exactly ONE entity layer (single-encoded, never Greenhouse-style double-decode)", () => {
    // Pinpoint descriptions are SINGLE-encoded, so `&amp;amp;` must resolve to a literal `&amp;`
    // — not `&`. A regression to a second decode pass would corrupt any literal entity text.
    const raw = { ...RAW_REMOTE, description: "<p>Tom &amp;amp; Jerry</p>" };
    expect(pinpointAdapter.mapItem(raw, CTX)?.descriptionText).toBe("Tom &amp; Jerry");
  });
});

describe("pinpointAdapter.mapItem — locations", () => {
  it.each([
    {
      name: "city + province compose",
      location: { name: "HQ", city: "Austin", province: "Texas" },
      expected: ["Austin, Texas"],
    },
    {
      name: "city only",
      location: { city: "Berlin" },
      expected: ["Berlin"],
    },
    {
      name: "province only",
      location: { province: "Ontario" },
      expected: ["Ontario"],
    },
    {
      name: "drops blank parts",
      location: { city: "  ", province: "California" },
      expected: ["California"],
    },
    {
      name: "name is ignored — never leaks into geography",
      location: { name: "Remote", city: "Austin", province: "Texas" },
      expected: ["Austin, Texas"],
    },
    {
      name: "no usable parts → empty array",
      location: { name: "Remote Office" },
      expected: [],
    },
    {
      name: "non-object location → empty array",
      location: "London",
      expected: [],
    },
    {
      name: "missing location → empty array",
      location: undefined,
      expected: [],
    },
  ])("$name", ({ location, expected }) => {
    // Strip workplace_type + the fixture's own location so composition is the sole concern under test.
    const { workplace_type: _wt, location: _loc, ...rest } = RAW_REMOTE;
    const raw = location === undefined ? rest : { ...rest, location };
    expect(pinpointAdapter.mapItem(raw, CTX)?.locations).toEqual(expected);
  });
});

describe("pinpointAdapter.mapItem — remote flag", () => {
  // The structured enum is authoritative; only an absent/unknown value falls back to location text.
  it.each([
    { name: "enum 'remote' → true", workplace_type: "remote", location: { city: "Austin" }, expected: true },
    { name: "enum 'hybrid' → false (text ignored)", workplace_type: "hybrid", location: { city: "Remote" }, expected: false },
    { name: "enum 'onsite' → false", workplace_type: "onsite", location: { city: "Austin" }, expected: false },
  ])("$name", ({ workplace_type, location, expected }) => {
    const raw = { ...RAW_REMOTE, workplace_type, location };
    expect(pinpointAdapter.mapItem(raw, CTX)?.remote).toBe(expected);
  });

  it.each([
    { name: "absent enum + remote location text → true", location: { city: "Remote" }, expected: true },
    { name: "absent enum + onsite location text → false", location: { city: "Austin", province: "Texas" }, expected: false },
    { name: "absent enum + name 'Remote' trap → false (name not a remote signal)", location: { name: "Remote", city: "Austin" }, expected: false },
    { name: "unknown enum spelling 'Remote' (wrong case) → falls back to text", workplace_type: "Remote", location: { city: "Austin" }, expected: false },
    { name: "unknown enum 'flexible' + remote text → true (fallback)", workplace_type: "flexible", location: { city: "Remote" }, expected: true },
  ])("$name", ({ workplace_type, location, expected }) => {
    const { workplace_type: _drop, ...rest } = RAW_REMOTE;
    const raw = workplace_type === undefined ? { ...rest, location } : { ...rest, workplace_type, location };
    expect(pinpointAdapter.mapItem(raw, CTX)?.remote).toBe(expected);
  });
});

describe("pinpointAdapter.mapItem — skip (returns null)", () => {
  it.each([
    { name: "null", raw: null },
    { name: "non-object string", raw: "nope" },
    { name: "non-object number", raw: 42 },
  ])("$name → null", ({ raw }) => {
    expect(pinpointAdapter.mapItem(raw, CTX)).toBeNull();
  });

  it.each([
    { name: "missing id", patch: { id: undefined } },
    { name: "empty id", patch: { id: "" } },
    { name: "whitespace-only id", patch: { id: "   " } },
    { name: "non-string id", patch: { id: 99201 } },
    { name: "missing title", patch: { title: undefined } },
    { name: "non-string title", patch: { title: 123 } },
    { name: "missing url", patch: { url: undefined } },
    { name: "empty url", patch: { url: "" } },
    { name: "non-string url", patch: { url: 12 } },
  ])("$name → null", ({ patch }) => {
    const raw = { ...RAW_REMOTE, ...patch };
    expect(pinpointAdapter.mapItem(raw, CTX)).toBeNull();
  });

  // interior-whitespace id → skip (null), never throw — mapItem contract; regression for the jobId throw.
  it("skips an interior-whitespace id without throwing", () => {
    expect(() => pinpointAdapter.mapItem({ ...RAW_REMOTE, id: "ab cd" }, CTX)).not.toThrow();
    expect(pinpointAdapter.mapItem({ ...RAW_REMOTE, id: "ab cd" }, CTX)).toBeNull();
  });
});
