import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Imports ./env KNOWINGLY: the import runs loadPackageEnv(import.meta.url), so on a dev box the
// real packages/auth/.env WILL have populated BETTER_AUTH_SECRET (and possibly BETTER_AUTH_URL) in
// process.env before the first test. Every case therefore forces its own env state explicitly —
// never relying on ambient absence. vi.stubEnv(name, undefined) is a true unset in vitest 4
// (deletes the key from process.env and restores the original on unstub).
import { getAuthBaseURL, getAuthSecret } from "./env";

const NOT_SET_MESSAGE =
  "BETTER_AUTH_SECRET is not set. Generate one (`openssl rand -base64 32`) and paste it into " +
  "packages/auth/.env (git-ignored).";

/** Call getAuthSecret expecting a throw; returns the Error for exact-message assertions. */
function captureSecretThrow(): Error {
  let caught: unknown;
  try {
    getAuthSecret();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

beforeEach(() => {
  // Deterministic baseline regardless of the dev box's packages/auth/.env: both vars start UNSET;
  // each test layers its own value on top.
  vi.stubEnv("BETTER_AUTH_URL", undefined);
  vi.stubEnv("BETTER_AUTH_SECRET", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAuthBaseURL", () => {
  it("returns the localhost:5173 default when BETTER_AUTH_URL is unset", () => {
    // beforeEach already unsets BETTER_AUTH_URL — this is the baseline case, no per-test stub needed.
    expect(getAuthBaseURL()).toBe("http://localhost:5173");
  });

  // The ?.trim() || default fallthrough: a set-but-blank value is treated as absent.
  it.each(["", "   "])("returns the default when BETTER_AUTH_URL is blank or whitespace-only (%j)", (value) => {
    vi.stubEnv("BETTER_AUTH_URL", value);
    expect(getAuthBaseURL()).toBe("http://localhost:5173");
  });

  it("returns the trimmed value when set with surrounding whitespace", () => {
    vi.stubEnv("BETTER_AUTH_URL", "  https://auth.example.test  ");
    expect(getAuthBaseURL()).toBe("https://auth.example.test");
  });
});

describe("getAuthSecret", () => {
  it("returns the trimmed secret when set", () => {
    // Padding makes the trim load-bearing: an untrimmed passthrough would return the padded value.
    vi.stubEnv("BETTER_AUTH_SECRET", "  unit-test-fake-secret-0123456789abcdef  ");
    expect(getAuthSecret()).toBe("unit-test-fake-secret-0123456789abcdef");
  });

  it("throws the actionable, secret-free guidance message when unset", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    // Exact-match (not substring): proves the full openssl guidance AND that nothing else — no
    // value, no partial secret — is ever echoed into the message.
    expect(captureSecretThrow().message).toBe(NOT_SET_MESSAGE);
  });

  it("throws when the value is whitespace-only — trim runs before the presence check", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "   ");
    // Same exact message as the unset case: the whitespace value itself is not echoed.
    expect(captureSecretThrow().message).toBe(NOT_SET_MESSAGE);
  });

  it("reads at call time — a secret stubbed after import is seen by the next call", () => {
    // The module was imported at file load (with the dev box's .env value, if any); both stubs
    // below land AFTER import. A getter that captured the value at import/creation time would
    // return the stale value on the second call.
    vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-fake-first-secret-value");
    expect(getAuthSecret()).toBe("unit-test-fake-first-secret-value");

    vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-fake-second-secret-value");
    expect(getAuthSecret()).toBe("unit-test-fake-second-secret-value");
  });
});
