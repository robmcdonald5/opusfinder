/**
 * Streams a listing page's postings out of its JSON one at a time, so a board's postings never sit in
 * memory together. Whole-body parsing held the text plus its parsed copy plus every mapped posting at once,
 * 4–5× the body in heap, and one 43.6 MB Greenhouse board (2026-10-22) took the Worker's 128 MB isolate
 * past its limit on every tick.
 *
 * The splitter only finds where each posting starts and ends (string, escape and nesting state). It does
 * not parse: each posting, and the rest of the page, goes through JSON.parse, so a boundary bug surfaces
 * as a malformed body instead of a silently wrong posting. Worker-forward: global streams, TextDecoder and
 * string work only.
 */
import type { SourceAdapter } from "./types";

/**
 * The page is valid JSON, or starts like it, but its postings array isn't where the adapter says, or a
 * posting (or the text around the array) is too large to hold. Not worth a retry: the same request gets
 * the same body.
 */
export class ListingShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingShapeError";
  }
}

/** The body isn't JSON, or is cut short: worth a retry, like a 5xx (a proxy truncating it, say). */
export class MalformedBodyError extends Error {
  constructor(options?: ErrorOptions) {
    super("malformed JSON body", options);
    this.name = "MalformedBodyError";
  }
}

/** Reading the body failed mid-stream (a reset, a timeout); `cause` holds the stream's error. */
export class BodyReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BodyReadError";
  }
}

/** Reads one chunk of a body; the caller's chance to put a timeout around each read. */
export type ChunkReader = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
) => Promise<ReadableStreamReadResult<Uint8Array>>;

/**
 * The longest one posting's JSON, or the page's JSON outside its postings array, may be: each is held
 * whole to parse it. Real postings run to tens of KB; a larger one is a vendor anomaly.
 */
const LIMITS: ListingSplitterLimits = { maxItemChars: 1_000_000, maxEnvelopeChars: 1_000_000 };

/**
 * Read one listing page a chunk at a time. Each chunk's completed postings, parsed and filtered through
 * `keepItem`, go to `onItems` in order; `onItems` returning `false` stops the read (the rest of the body
 * is cancelled). Resolves to the page with its postings array emptied, for `nextCursor`, `reportedTotal`
 * and `classifyProbe`, or to `undefined` when stopped early.
 *
 * Throws {@link MalformedBodyError} on a body that isn't JSON or ends early, {@link ListingShapeError} on
 * one without the array at `itemsKey`, {@link BodyReadError} when a read fails, and whatever `onItems`
 * throws, unwrapped.
 */
export async function readListingPage(
  body: ReadableStream<Uint8Array> | null,
  listing: Pick<SourceAdapter, "itemsKey" | "keepItem">,
  onItems: (items: unknown[]) => boolean | void | Promise<boolean | void>,
  read: ChunkReader = (reader) => reader.read(),
): Promise<unknown> {
  if (!body) throw new MalformedBodyError();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const splitter = new ListingSplitter(listing.itemsKey, LIMITS);
  let finished = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await read(reader);
      } catch (err) {
        throw new BodyReadError(err);
      }
      let items: unknown[];
      let page: unknown;
      try {
        const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        items = splitter.push(text).map((item) => JSON.parse(item) as unknown);
        if (chunk.done) page = splitter.end();
      } catch (err) {
        if (err instanceof SyntaxError) throw new MalformedBodyError({ cause: err });
        throw err;
      }
      const keep = listing.keepItem;
      const kept = keep ? items.filter((raw) => keep(raw)) : items;
      if (kept.length > 0 && (await onItems(kept)) === false) return undefined;
      if (chunk.done) {
        finished = true;
        return page;
      }
    }
  } finally {
    // Release the connection on an early stop or a failure. Not awaited: a cancel can hang on a stream
    // that never settles, and nothing here needs its outcome.
    if (!finished) void reader.cancel().catch(() => {});
  }
}

export interface ListingSplitterLimits {
  /** The longest one posting's JSON may be, in UTF-16 units (one is held whole to parse it). */
  maxItemChars: number;
  /** The longest the page's JSON outside the postings array may be (it is held whole to parse it). */
  maxEnvelopeChars: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
// Inside a string only its closing quote or an escape matters, so the scan jumps between them natively:
// the descriptions that make a board big are almost all string content.
const STRING_STOP = /["\\]/g;

/**
 * One page's splitter. `key` names the array of postings in the root object; `null` means the root is
 * that array (Lever, Gem). Feed decoded text to {@link push} in any chunking, then call {@link end}.
 */
export class ListingSplitter {
  // The current posting's text from its first character, kept when a chunk ends inside it.
  private carry = "";
  private depth = 0;
  private inString = false;
  private escaped = false; // a chunk ended right after a backslash inside a string
  private rootSeen = false;
  private rootClosed = false;
  // Root-object members: the next string at depth 1 is a key; while one is read, its text so far.
  private expectKey = false;
  private key: string | null = null;
  private lastKey: string | null = null;
  // The depth just inside the postings array while the scan is in it, else -1.
  private itemsDepth = -1;
  private itemsFound = false;
  private itemStart = -1; // the current posting's first character in the scanned text, -1 between postings
  private afterComma = false;
  private envelope = "";
  // The key as it appears between the quotes in the JSON text (keys are compared raw, unescaped).
  private readonly rawKey: string | null;

  constructor(
    private readonly itemsKey: string | null,
    private readonly limits: ListingSplitterLimits,
  ) {
    this.rawKey = itemsKey === null ? null : JSON.stringify(itemsKey).slice(1, -1);
  }

  /** Scan the next piece of decoded text; return the raw JSON of each posting it completed. */
  push(chunk: string): string[] {
    const s = this.carry + chunk;
    const out: string[] = [];
    let i = this.carry.length; // a carried posting was scanned already
    if (this.carry.length > 0) this.itemStart = 0;
    this.carry = "";
    // Where the not-yet-copied text outside the postings array starts (-1 while inside it), and where the
    // root key being read starts in this chunk.
    let outside = this.itemsKey !== null && this.itemsDepth < 0 ? i : -1;
    let keyFrom = 0;

    while (i < s.length) {
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          i++;
          continue;
        }
        STRING_STOP.lastIndex = i;
        const stop = STRING_STOP.exec(s);
        if (stop === null) break; // the string runs on into the next chunk
        i = stop.index;
        if (s.charCodeAt(i) === BACKSLASH) {
          if (i + 1 >= s.length) this.escaped = true;
          i += 2;
          continue;
        }
        this.inString = false;
        if (this.key !== null) {
          this.lastKey = this.key + s.slice(keyFrom, i);
          this.key = null;
        }
        i++;
        continue;
      }

      const c = s.charCodeAt(i);
      if (c === QUOTE) {
        if (this.depth === 0) this.openRoot(c);
        this.inString = true;
        if (this.inItems() && this.itemStart < 0) {
          this.startItem(i);
        } else if (this.depth === 1 && this.expectKey) {
          this.expectKey = false;
          this.key = "";
          keyFrom = i + 1;
        }
      } else if (c === OPEN_BRACE || c === OPEN_BRACKET) {
        let opensItems = false;
        if (this.depth === 0) {
          this.openRoot(c);
          if (this.itemsKey === null) opensItems = true;
          else this.expectKey = true;
        } else if (
          this.depth === 1 &&
          this.itemsDepth < 0 &&
          c === OPEN_BRACKET &&
          this.rawKey !== null &&
          this.lastKey === this.rawKey
        ) {
          if (this.itemsFound) throw new ListingShapeError(`two "${this.itemsKey}" arrays`);
          opensItems = true;
          this.envelope += s.slice(outside, i + 1);
          outside = -1;
        } else if (this.inItems() && this.itemStart < 0) {
          this.startItem(i);
        }
        this.depth++;
        if (opensItems) {
          this.itemsFound = true;
          this.itemsDepth = this.depth;
          this.afterComma = false;
        }
      } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
        this.depth--;
        if (this.depth < 0) throw new SyntaxError("unbalanced brackets in the listing body");
        if (this.itemsDepth >= 0 && this.depth === this.itemsDepth - 1) {
          // The postings array itself closed.
          if (this.itemStart >= 0) out.push(this.takeItem(s, i));
          else if (this.afterComma) throw new SyntaxError("a trailing comma in the postings array");
          this.itemsDepth = -1;
          if (this.itemsKey !== null) outside = i;
        }
        if (this.depth === 0) this.rootClosed = true;
      } else if (c === COMMA) {
        if (this.inItems()) {
          if (this.itemStart < 0) throw new SyntaxError("an empty posting in the postings array");
          out.push(this.takeItem(s, i));
          this.afterComma = true;
        } else if (this.depth === 1 && this.itemsKey !== null) {
          this.expectKey = true;
        } else if (this.depth === 0) {
          throw new SyntaxError("a comma outside the listing body's JSON");
        }
      } else if (!isJsonWhitespace(c)) {
        if (this.depth === 0) this.openRoot(c);
        if (this.inItems() && this.itemStart < 0) this.startItem(i); // a number / true / false / null
      }
      i++;
    }

    if (outside >= 0) {
      this.envelope += s.slice(outside);
      if (this.envelope.length > this.limits.maxEnvelopeChars) {
        throw new ListingShapeError(
          `over ${this.limits.maxEnvelopeChars} chars outside the postings`,
        );
      }
    }
    if (this.key !== null) this.key += s.slice(keyFrom);
    if (this.itemStart >= 0) {
      this.carry = s.slice(this.itemStart);
      this.itemStart = -1;
      if (this.carry.length > this.limits.maxItemChars) {
        throw new ListingShapeError(`a posting over ${this.limits.maxItemChars} chars`);
      }
    }
    return out;
  }

  /**
   * The body ended. Check it held exactly one JSON value with the postings array in place, and return
   * that value with the array emptied: what `nextCursor`, `reportedTotal` and `classifyProbe` read.
   */
  end(): unknown {
    if (!this.rootSeen || this.inString || this.depth !== 0) {
      throw new SyntaxError("the listing body ended before its JSON did");
    }
    if (!this.itemsFound) throw new ListingShapeError(`no "${this.itemsKey}" array`);
    return this.itemsKey === null ? [] : (JSON.parse(this.envelope) as unknown);
  }

  private inItems(): boolean {
    return this.itemsDepth >= 0 && this.depth === this.itemsDepth;
  }

  private startItem(i: number): void {
    this.itemStart = i;
    this.afterComma = false;
  }

  private takeItem(s: string, end: number): string {
    const item = s.slice(this.itemStart, end);
    this.itemStart = -1;
    if (item.length > this.limits.maxItemChars) {
      throw new ListingShapeError(`a posting over ${this.limits.maxItemChars} chars`);
    }
    return item;
  }

  /** The first non-whitespace character of the body: it must open the shape the adapter expects. */
  private openRoot(c: number): void {
    if (this.rootClosed) throw new SyntaxError("text after the listing body's JSON");
    if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      const want = this.itemsKey === null ? OPEN_BRACKET : OPEN_BRACE;
      if (c !== want) {
        throw new ListingShapeError(
          this.itemsKey === null ? "not a JSON array" : "not a JSON object",
        );
      }
      this.rootSeen = true;
      return;
    }
    // A string, number, true/false/null root is valid JSON of the wrong shape; anything else isn't JSON
    // (an HTML maintenance page, say), which is worth a retry.
    if (
      c === QUOTE ||
      c === 0x2d ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x74 ||
      c === 0x66 ||
      c === 0x6e
    ) {
      throw new ListingShapeError(
        this.itemsKey === null ? "not a JSON array" : "not a JSON object",
      );
    }
    throw new SyntaxError("the listing body is not JSON");
  }
}

function isJsonWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}
