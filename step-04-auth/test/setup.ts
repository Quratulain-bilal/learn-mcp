import { exports } from "cloudflare:workers";

const response = await exports.default.fetch(
  new Request("https://example.com/__migrate?token=test-migration-token", {
    method: "POST",
  }),
);

if (!response.ok) {
  throw new Error(`Test migration failed: ${await response.text()}`);
}
