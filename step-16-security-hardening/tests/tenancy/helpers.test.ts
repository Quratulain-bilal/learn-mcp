import { describe, expect, it } from "vitest";
import { envelope, tenantKey, tenantObjectName } from "../../src/tenant";
import { tenantCtx } from "../../test/helpers";

// Unit tests for the tenant helpers every later step builds on. No database needed.

const acme = tenantCtx({ orgId: "acme", userId: "ali", requestId: "req-1" });

describe("tenantKey", () => {
  it("always starts with the company", () => {
    expect(tenantKey(acme, "settings")).toBe("org:acme:settings");
    expect(tenantKey(acme, "user", "ali", "draft")).toBe("org:acme:user:ali:draft");
    expect(tenantKey(acme)).toBe("org:acme");
  });

  it("refuses parts that could pose as another company's prefix", () => {
    expect(() => tenantKey(acme, "x:org:globex")).toThrow(/Invalid key part/);
    expect(() => tenantKey(acme, "")).toThrow(/Invalid key part/);
    expect(() => tenantKey({ orgId: "acme:org:globex" }, "settings")).toThrow(/Invalid key part/);
  });

  it("gives two companies different keys for the same thing", () => {
    expect(tenantKey({ orgId: "acme" }, "settings")).not.toBe(tenantKey({ orgId: "globex" }, "settings"));
  });
});

describe("tenantObjectName", () => {
  it("names per-user and company-wide objects from the verified context", () => {
    expect(tenantObjectName(acme)).toBe("org:acme:user:ali");
    expect(tenantObjectName(acme, "company")).toBe("org:acme");
  });
});

describe("TenantEnvelope", () => {
  it("carries exactly the company, user and request, and nothing else", () => {
    expect(envelope(acme)).toEqual({ orgId: "acme", userId: "ali", requestId: "req-1" });
  });
});
