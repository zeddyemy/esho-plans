import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker routing", () => {
  it("serves the health check on the app host", async () => {
    const response = await exports.default.fetch("https://postplan.esho.dev/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    "https://esho-plans.test-account.workers.dev/healthz",
    "https://other.test-account.workers.dev/healthz",
    "https://postplan.esho.dev.example.com/healthz",
    "http://localhost:8787/healthz",
    "http://127.0.0.1:8787/healthz",
  ])("rejects the health check at %s", async (url) => {
    const response = await exports.default.fetch(url);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns 404 for an undefined app route", async () => {
    const response = await exports.default.fetch("https://postplan.esho.dev/sitemap.xml");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("ignores a forwarded app hostname on an unknown host", async () => {
    const response = await exports.default.fetch("https://unknown.example/healthz", {
      headers: { "X-Forwarded-Host": "postplan.esho.dev" },
    });

    expect(response.status).toBe(404);
  });
});
