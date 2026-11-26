import { exports } from "cloudflare:workers";

await exports.default.fetch(
  new Request("https://example.com/__migrate?token=test-migration-token", {
    method: "POST",
  }),
);
