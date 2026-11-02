// Child process for the #835 process-crash suite.
//
// Started twice against the same isolated database:
//   MODE=crash  -> serves the real Control API on loopback and SIGKILLs itself in the
//                  completion commit phase, i.e. after the durable receipt exists and
//                  before the HTTP response can be written;
//   MODE=replay -> serves the same routes from a fresh process so the parent can replay
//                  the original idempotency key and observe what the restarted process
//                  actually persisted.
import Fastify from "fastify";

const { DATABASE_URL, PORT, JOB_ID, TOKEN, MODE } = process.env;
if (!DATABASE_URL || !PORT || !JOB_ID || !TOKEN || !MODE) {
  console.error("crash-server: missing environment");
  process.exit(64);
}

const api = await import("./index.js");
const app = Fastify({ logger: false });
api.registerPlatformControlRoutes(app);
api.registerRuntimeHandler(JOB_ID, context => {
  if (MODE === "crash" && context.completionPhase === "commit") {
    // Persist-then-die: the receipt and semantic event are already committed, the
    // response is not. This is the window the suite is about.
    process.kill(process.pid, "SIGKILL");
  }
  if (context.completionPhase === "prepare") return { completion_prepared: true };
  if (context.completionPhase === "abort") return {};
  return {};
}, ["mark_job_done"]);

await app.listen({ host: "127.0.0.1", port: Number(PORT) });
console.log("READY");
process.stdout.write(`TOKEN=${TOKEN}\n`);