import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@test/msw/server";

import { fetchHnAlgoliaLane } from "./hn";

// The HN "Who is hiring" seed lane over MSW. Its fetch half runs today only behind the HN_LIVE_TEST gate
// and is never selected by discover.integration.test.ts's fetch-router (which drives the outscal/greenhouse
// boundary), so the two-hop search→items chain, the title filter, the id-null short-circuit, and the
// non-2xx throw are otherwise uncovered offline. MSW (not the URL-only fetch-router) is required because the
// load-bearing checks are wire-contract: method=GET, the tags/hitsPerPage query, and the accept header.
// parseHnThread edge cases stay in the pure hn.test.ts; here a non-empty tree only needs to FLOW THROUGH.

const HN = "https://hn.algolia.com/api/v1";
const BOARD_URL = "https://boards.greenhouse.io/acme/jobs/4001";

/** A minimal /items tree: one hiring comment carrying a covered board URL, one that carries none. */
function itemsTree(id: string) {
  return {
    id,
    children: [
      { text: `We're hiring backend engineers — apply: ${BOARD_URL}`, children: [] },
      { text: "Just here to comment, no roles.", children: [] },
    ],
  };
}

function searchHits(hits: { objectID?: string; title?: string }[]) {
  return { hits };
}

describe("HN Algolia seed lane over MSW", () => {
  it("resolves the newest whoishiring thread, fetches its item tree, and parses covered-board records", async () => {
    let itemsId: string | undefined;
    server.use(
      http.get(`${HN}/search_by_date`, () =>
        HttpResponse.json(searchHits([{ objectID: "42155957", title: "Ask HN: Who is hiring? (July 2026)" }])),
      ),
      http.get(`${HN}/items/:id`, ({ params }) => {
        itemsId = String(params.id);
        return HttpResponse.json(itemsTree(String(params.id)));
      }),
    );

    const records = await fetchHnAlgoliaLane();

    expect(itemsId).toBe("42155957");
    expect(records.some((r) => r.ats_links?.includes(BOARD_URL))).toBe(true);
  });

  it("sends the exact Algolia search contract (GET, tags + hitsPerPage query, accept header)", async () => {
    let method = "";
    let accept: string | null = null;
    let tags: string | null = null;
    let hitsPerPage: string | null = null;
    server.use(
      http.get(`${HN}/search_by_date`, ({ request }) => {
        method = request.method;
        accept = request.headers.get("accept");
        const url = new URL(request.url);
        tags = url.searchParams.get("tags");
        hitsPerPage = url.searchParams.get("hitsPerPage");
        return HttpResponse.json(searchHits([])); // no match → lane returns [] without a second hop
      }),
    );

    await fetchHnAlgoliaLane();

    expect(method).toBe("GET");
    expect(accept).toBe("application/json");
    expect(tags).toBe("story,author_whoishiring");
    expect(hitsPerPage).toBe("30");
  });

  it("title-filters to the 'who is hiring' story and picks the FIRST (newest-first) match", async () => {
    let itemsId: string | undefined;
    server.use(
      http.get(`${HN}/search_by_date`, () =>
        HttpResponse.json(
          searchHits([
            { objectID: "D", title: "Ask HN: Who wants to be hired? (July 2026)" }, // decoy from the same account
            { objectID: "A", title: "Ask HN: Who is hiring? (July 2026)" }, // newest real match
            { objectID: "B", title: "Ask HN: Who is hiring? (June 2026)" }, // older match
          ]),
        ),
      ),
      http.get(`${HN}/items/:id`, ({ params }) => {
        itemsId = String(params.id);
        return HttpResponse.json(itemsTree(String(params.id)));
      }),
    );

    await fetchHnAlgoliaLane();

    expect(itemsId).toBe("A"); // not the decoy D, not the older B
  });

  it("skips a hit missing objectID or title and falls through to the next valid match", async () => {
    let itemsId: string | undefined;
    server.use(
      http.get(`${HN}/search_by_date`, () =>
        HttpResponse.json(
          searchHits([
            { title: "Ask HN: Who is hiring? (no id)" }, // missing objectID
            { objectID: "X" }, // missing title
            { objectID: "Y", title: "Ask HN: Who is hiring? (July 2026)" }, // first fully-valid hit
          ]),
        ),
      ),
      http.get(`${HN}/items/:id`, ({ params }) => {
        itemsId = String(params.id);
        return HttpResponse.json(itemsTree(String(params.id)));
      }),
    );

    await fetchHnAlgoliaLane();

    expect(itemsId).toBe("Y");
  });

  it("returns [] and never fetches /items when no title matches", async () => {
    let itemsCalls = 0;
    server.use(
      http.get(`${HN}/search_by_date`, () =>
        HttpResponse.json(searchHits([{ objectID: "D", title: "Ask HN: Who wants to be hired?" }])),
      ),
      http.get(`${HN}/items/:id`, () => {
        itemsCalls += 1;
        return HttpResponse.json(itemsTree("unused"));
      }),
    );

    const records = await fetchHnAlgoliaLane();

    expect(records).toEqual([]);
    expect(itemsCalls).toBe(0); // the id===null short-circuit skips the second hop
  });

  it("throws on a non-2xx search (body drained) and never reaches /items", async () => {
    let itemsCalls = 0;
    // Null body on purpose: fetchJson's non-2xx branch calls `res.body?.cancel()`, and cancelling an
    // MSW-MOCKED response body deadlocks (the body-drain matters only on a real socket — a live-gate
    // concern). A null body skips the optional-chain, so the throw + short-circuit are exercised cleanly.
    server.use(
      http.get(`${HN}/search_by_date`, () => new HttpResponse(null, { status: 500 })),
      http.get(`${HN}/items/:id`, () => {
        itemsCalls += 1;
        return HttpResponse.json(itemsTree("unused"));
      }),
    );

    await expect(fetchHnAlgoliaLane()).rejects.toThrow(/HN Algolia 500/);
    expect(itemsCalls).toBe(0);
  });

  it("throws on a non-2xx item fetch after a successful search", async () => {
    server.use(
      http.get(`${HN}/search_by_date`, () =>
        HttpResponse.json(searchHits([{ objectID: "A", title: "Ask HN: Who is hiring? (July 2026)" }])),
      ),
      http.get(`${HN}/items/:id`, () => new HttpResponse(null, { status: 503 })), // null body: see the 500 test
    );

    await expect(fetchHnAlgoliaLane()).rejects.toThrow(/HN Algolia 503/);
  });
});
