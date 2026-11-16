/**
 * Pins which apply URLs the liveness probe will request at all: http(s) only, never localhost, never a
 * literal address in a private, loopback, link-local or carrier-NAT range (IPv4, IPv6, or IPv4-mapped
 * IPv6), in every spelling a URL allows. A refused URL reads `error` (kept, never closed) with no status;
 * a requested one here reads `live` with the stub's 200.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { probeLiveness } from "./probe";

const REFUSED = [
  // IPv4 ranges, first and last address of each
  "http://0.0.0.0/a",
  "http://0.255.255.255/a",
  "http://10.0.0.0/a",
  "http://10.255.255.255/a",
  "http://100.64.0.0/a",
  "http://100.127.255.255/a",
  "http://127.0.0.0/a",
  "http://127.255.255.255/a",
  "http://169.254.0.0/a",
  "http://169.254.169.254/a",
  "http://169.254.255.255/a",
  "http://172.16.0.0/a",
  "http://172.31.255.255/a",
  "http://192.168.0.0/a",
  "http://192.168.255.255/a",
  // other spellings of an IPv4 address (the URL parser normalizes them)
  "http://2130706433/a",
  "http://0x7f.0.0.1/a",
  "http://0177.0.0.1/a",
  "http://127.1/a",
  "http://0x7f000001/a",
  "http://017700000001/a",
  "http://167772161/a",
  "http://127.0.0.1:8080/a",
  "http://user:pw@10.0.0.1/a",
  // IPv6
  "http://[::]/a",
  "http://[::1]/a",
  "http://[0:0:0:0:0:0:0:1]/a",
  "http://[::1]:8080/a",
  "http://[fc00::]/a",
  "http://[fc00::1]/a",
  "http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/a",
  "http://[fe80::]/a",
  "http://[fe80::1]/a",
  "http://[febf:ffff::1]/a",
  // IPv4-mapped IPv6
  "http://[::ffff:127.0.0.1]/a",
  "http://[::ffff:7f00:1]/a",
  "http://[::ffff:10.0.0.1]/a",
  "http://[::ffff:192.168.1.1]/a",
  "http://[::ffff:169.254.169.254]/a",
  "http://[::ffff:100.64.0.1]/a",
  "http://[::ffff:172.16.0.1]/a",
  "http://[::ffff:0.0.0.1]/a",
  // localhost
  "http://localhost/a",
  "http://LOCALHOST/a",
  "http://localhost:3000/a",
  "http://app.localhost/a",
  "http://a.b.localhost/a",
  // not http(s), or not a URL
  "ftp://jobs.example.com/a",
  "file:///etc/passwd",
  "data:text/plain,x",
  "javascript:alert(1)",
  "//jobs.example.com/a",
  "http://999.1.1.1/a",
  "not a url",
  "",
];

const REQUESTED = [
  // the addresses on either side of each IPv4 range
  "http://1.0.0.0/a",
  "http://9.255.255.255/a",
  "http://11.0.0.0/a",
  "http://100.63.255.255/a",
  "http://100.128.0.0/a",
  "http://126.255.255.255/a",
  "http://128.0.0.0/a",
  "http://169.253.255.255/a",
  "http://169.255.0.0/a",
  "http://172.15.255.255/a",
  "http://172.32.0.0/a",
  "http://192.167.255.255/a",
  "http://192.169.0.0/a",
  "http://224.0.0.1/a",
  "http://255.255.255.255/a",
  "http://134744072/a",
  "http://1.2.3/a",
  "https://1.1.1.1/a",
  // IPv6 outside the ranges
  "http://[::2]/a",
  "http://[fbff:ffff::1]/a",
  "http://[fe00::1]/a",
  "http://[fe7f:ffff::1]/a",
  "http://[fec0::1]/a",
  "http://[ff02::1]/a",
  "http://[2001:db8::1]/a",
  "http://[2606:4700:4700::1111]/a",
  // IPv4-mapped public addresses
  "http://[::ffff:1.1.1.1]/a",
  "http://[::ffff:8.8.8.8]/a",
  "http://[::ffff:11.0.0.1]/a",
  "http://[::ffff:172.32.0.1]/a",
  // only the ::ffff:0:0/96 mapping is read as IPv4
  "http://[::127.0.0.1]/a",
  "http://[::10.0.0.1]/a",
  "http://[64:ff9b::7f00:1]/a",
  "http://[::ffff:0:7f00:1]/a",
  // names
  "https://jobs.example.com/a",
  "HTTP://JOBS.EXAMPLE.COM/a",
  "http://jobs.example.com:8080/a",
  "http://user:pw@jobs.example.com/a",
  "http://localhost.example.com/a",
  "http://localhost./a",
  "http://notlocalhost/a",
  "http://mylocalhost/a",
  "http://1.1.1.1.example.com/a",
  "http://127.0.0.1.nip.io/a",
];

describe("probeLiveness — which URLs it requests", () => {
  const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
  beforeAll(() => vi.stubGlobal("fetch", fetchStub));
  afterAll(() => vi.unstubAllGlobals());

  it.each(REFUSED)("refuses %s", async (url) => {
    fetchStub.mockClear();
    await expect(probeLiveness(url)).resolves.toEqual({ verdict: "error" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each(REQUESTED)("requests %s", async (url) => {
    fetchStub.mockClear();
    await expect(probeLiveness(url)).resolves.toEqual({ verdict: "live", status: 200 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
