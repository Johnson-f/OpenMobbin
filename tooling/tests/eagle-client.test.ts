import { expect, test } from "bun:test";
import { EagleHttpAdapter } from "../src/internal/eagle-client";

test("waits for Eagle folder deletion when counts lag behind Trash", async () => {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/script/inject") {
        attempts += 1;
        return Response.json({ status: "success" });
      }
      const data = attempts < 2 ? [{ id: "old-flow", name: "Onboarding", children: [] }] : [];
      return Response.json({ status: "success", data: { data, total: data.length } });
    },
  });
  try {
    await new EagleHttpAdapter(server.url.toString()).removeFolders(["old-flow"]);
    expect(attempts).toBe(2);
  } finally {
    server.stop(true);
  }
});
