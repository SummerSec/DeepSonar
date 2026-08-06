import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { planePollOnce } from "../../plane-sync.js";

export function registerPlaneRoutes(app: FastifyInstance): void {
  app.post("/webhooks/plane", async (req, reply) => {
    if (config.plane.webhookSecret) {
      const signature = (req.headers["x-plane-signature"] ?? "") as string;
      const expected = createHmac("sha256", config.plane.webhookSecret)
        .update(JSON.stringify(req.body))
        .digest("hex");
      const actualBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expected);
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    }
    const body = req.body as { event?: string; action?: string };
    if (body.event === "issue") {
      void planePollOnce().catch((error) => console.error("[webhook] poll 失败:", error));
    }
    return { ok: true };
  });
}
