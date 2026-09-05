import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("hub runtime image integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("Hub intent runtime_image_key is validated against the project catalog and frozen into the Worker snapshot", async () => {
    // Install the explicit URL before importing db/core so a developer .env
    // cannot redirect this integration run to an existing database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { ingestEvent, preflightDeferredSemanticEvent } = await import("../../core.js");
    const { ControlInputError } = await import("../../control-input.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `hub-runtime-image-${randomUUID()}`;
    const kaliDigest = `sha256:${createHash("sha256").update(`fixture:${canvasId}:kali`).digest("hex")}`;
    const kaliRef = `cr.example.invalid/deepsonar-kali-minimal@${kaliDigest}`;

    // Fixture-owned trusted version row id, captured for finally cleanup. The
    // CI gate runs every integration step against one shared Postgres; leaving
    // running/pending Jobs or trusted version fixtures behind would poison
    // later global-claim assertions (e.g. convergence-recovery sets
    // maxGlobalJobs=4 and expects an empty active set before claiming).
    let kaliVersionId: string | null = null;
    let chromeVersionId: string | null = null;
    let thirdVersionId: string | null = null;
    let thirdImageId: string | null = null;
    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${canvasId}, 'hub-runtime-image', ${sql.json({ rules: { hubEnabled: false } })})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'hub-runtime-image', ${sql.json({ network_policy: { allow_egress: false } })})`;
      const [root] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})
        RETURNING id`;

      // Baseline catalog rows come from schema.sql; only the executable trusted
      // version + selected-channel ref are fixture-owned. deepsonar-chrome-fuzz
      // stays project_opt_in without a project enable row, so it must be absent
      // from the Hub catalog.
      const [kaliVersion] = await sql<{ id: string }[]>`
        INSERT INTO runtime_image_versions (runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        SELECT id, ${`0.1.0-${randomUUID().slice(0, 8)}`}, ${kaliRef}, ${kaliRef}, ${kaliDigest},
               ${sql.json(["linux/amd64", "linux/arm64"] as never)}, 'trusted', now()
        FROM runtime_images WHERE image_key = 'deepsonar-kali-minimal'
        RETURNING id`;
      assert.ok(kaliVersion, "baseline deepsonar-kali-minimal row must exist");
      kaliVersionId = kaliVersion?.id ?? null;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest)
        VALUES (${kaliVersion.id}, 'aliyun-acr', ${kaliRef}, ${kaliRef}, ${kaliDigest})`;

      const hubSnapshot = {
        name: "hub_reason",
        role_kind: "hub",
        platform_tools: ["list_available_roles", "list_available_runtime_images", "emit_progress", "submit_hub_decision", "mark_job_done"],
      };
      const makeHubJob = async () => {
        const id = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
          VALUES (${id}, ${projectId}, ${canvasId}, 'hub_reason', 'running', ${sql.json(hubSnapshot)}, ${sql.json({})})`;
        return id;
      };
      const intent = (description: string, runtimeImageKey?: string) => ({
        from: [root.id],
        role: "review",
        description,
        prompt: "Review the referenced root goal and report durable evidence for this fixture.",
        ...(runtimeImageKey ? { runtime_image_key: runtimeImageKey } : {}),
      });

      // 1) A catalog image_key is accepted and frozen into the derived Worker snapshot.
      const hubWithImage = await makeHubJob();
      const accepted = await ingestEvent(hubWithImage, {
        v: 1,
        event_id: randomUUID(),
        type: "hub_decision",
        payload: { intents: [intent("dispatch review on kali runtime", "deepsonar-kali-minimal")] },
      });
      assert.deepEqual(accepted, { deduped: false, seq: 1 });
      const [kaliJob] = await sql<{
        id: string;
        snapshot: { runtime_image?: { image_key?: string }; runtime_image_key?: string | null };
      }[]>`
        SELECT id, agent_snapshot_json AS snapshot FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'review' AND parent_job_id = ${hubWithImage}`;
      assert.ok(kaliJob, "accepted Hub decision must create a review Worker");
      assert.equal(kaliJob.snapshot.runtime_image?.image_key, "deepsonar-kali-minimal");
      assert.equal(kaliJob.snapshot.runtime_image_key, "deepsonar-kali-minimal");

      const { frozenSnapshotStaleDetail, requeueJob } = await import("../../domains/job-control/rerun.js");
      assert.equal(await frozenSnapshotStaleDetail(sql, {
        id: kaliJob.id,
        project_id: projectId,
        canvas_id: canvasId,
        type: "review",
        payload_json: {},
        agent_snapshot_json: kaliJob.snapshot,
      }), null, "Hub-frozen Kali must not look stale against the role default Base");
      await sql`UPDATE jobs SET status = 'failed', finished_at = now() WHERE id = ${kaliJob.id}`;
      const resumed = await requeueJob(kaliJob.id, "resume-frozen");
      assert.equal(resumed.kind, "ok", JSON.stringify(resumed));
      const [afterResume] = await sql<{ snapshot: { runtime_image?: { image_key?: string } } }[]>`
        SELECT agent_snapshot_json AS snapshot FROM jobs WHERE id = ${kaliJob.id}`;
      assert.equal(afterResume?.snapshot.runtime_image?.image_key, "deepsonar-kali-minimal");

      await sql`UPDATE jobs SET status = 'failed', finished_at = now() WHERE id = ${kaliJob.id}`;
      const rerun = await requeueJob(kaliJob.id, "rerun-current");
      assert.equal(rerun.kind, "ok", JSON.stringify(rerun));
      const [afterRerun] = await sql<{ snapshot: { runtime_image?: { image_key?: string } } }[]>`
        SELECT agent_snapshot_json AS snapshot FROM jobs WHERE id = ${kaliJob.id}`;
      assert.equal(afterRerun?.snapshot.runtime_image?.image_key, "deepsonar-kali-minimal");

      // 2) Omitting the key keeps the role default resolution (review -> deepsonar-base).
      const hubDefault = await makeHubJob();
      await ingestEvent(hubDefault, {
        v: 1,
        event_id: randomUUID(),
        type: "hub_decision",
        payload: { intents: [intent("dispatch review on default runtime")] },
      });
      const [defaultJob] = await sql<{ snapshot: { runtime_image?: { image_key?: string } } }[]>`
        SELECT agent_snapshot_json AS snapshot FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'review' AND parent_job_id = ${hubDefault}`;
      assert.equal(defaultJob?.snapshot.runtime_image?.image_key, "deepsonar-base");

      // 3) A project-opt-in image the project never enabled is rejected for the whole decision.
      const hubOptIn = await makeHubJob();
      await assert.rejects(
        preflightDeferredSemanticEvent(hubOptIn, "hub_decision", {
          intents: [intent("dispatch review on chrome fuzz", "deepsonar-chrome-fuzz")],
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_runtime_image" && error.retryable,
      );
      await assert.rejects(
        ingestEvent(hubOptIn, {
          v: 1,
          event_id: randomUUID(),
          type: "hub_decision",
          payload: { intents: [intent("dispatch review on chrome fuzz apply", "deepsonar-chrome-fuzz")] },
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_runtime_image",
      );
      const [optInJob] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'review' AND parent_job_id = ${hubOptIn}`;
      assert.equal(optInJob?.count, 0, "rejected image proposal must not create a Worker Job");

      // 4) Unknown market keys are rejected by the catalog check (not by shape).
      const hubUnknown = await makeHubJob();
      await assert.rejects(
        preflightDeferredSemanticEvent(hubUnknown, "hub_decision", {
          intents: [intent("dispatch review on ghost image", "deepsonar-ghost")],
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_runtime_image",
      );

      // 5) OCI references / tags never reach the catalog check: the strict schema rejects them.
      const hubOci = await makeHubJob();
      await assert.rejects(
        preflightDeferredSemanticEvent(hubOci, "hub_decision", {
          intents: [intent("dispatch review on raw oci ref", "ghcr.io/summersec/deepsonar-base:latest")],
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_payload",
      );

      // 6) Catalog exposes compatible_agent_clis and drops third-party keys.
      const chromeDigest = `sha256:${createHash("sha256").update(`fixture:${canvasId}:chrome`).digest("hex")}`;
      const chromeRef = `cr.example.invalid/deepsonar-chrome-fuzz@${chromeDigest}`;
      const thirdDigest = `sha256:${createHash("sha256").update(`fixture:${canvasId}:third`).digest("hex")}`;
      const thirdRef = `cr.example.invalid/third-party-custom@${thirdDigest}`;
      const [chromeImage] = await sql<{ id: string }[]>`
        SELECT id FROM runtime_images WHERE image_key = 'deepsonar-chrome-fuzz'`;
      assert.ok(chromeImage, "baseline deepsonar-chrome-fuzz row must exist");
      await sql`
        INSERT INTO project_runtime_images (project_id, runtime_image_id, enabled)
        VALUES (${projectId}, ${chromeImage.id}, true)`;
      const [chromeVersion] = await sql<{ id: string }[]>`
        INSERT INTO runtime_image_versions (runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES (${chromeImage.id}, ${`0.1.0-${randomUUID().slice(0, 8)}`}, ${chromeRef}, ${chromeRef}, ${chromeDigest},
                ${sql.json(["linux/amd64", "linux/arm64"] as never)}, 'trusted', now())
        RETURNING id`;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest)
        VALUES (${chromeVersion.id}, 'aliyun-acr', ${chromeRef}, ${chromeRef}, ${chromeDigest})`;
      const thirdImageKey = `third-party-${randomUUID().slice(0, 8)}`;
      const [thirdImage] = await sql<{ id: string }[]>`
        INSERT INTO runtime_images (image_key, name, description, publisher, source_kind, official, project_opt_in, enabled)
        VALUES (${thirdImageKey}, 'Third Party Custom', 'fixture', 'fixture', 'third_party', false, true, true)
        RETURNING id`;
      await sql`
        INSERT INTO project_runtime_images (project_id, runtime_image_id, enabled)
        VALUES (${projectId}, ${thirdImage.id}, true)`;
      const [thirdVersion] = await sql<{ id: string }[]>`
        INSERT INTO runtime_image_versions (runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES (${thirdImage.id}, ${`0.1.0-${randomUUID().slice(0, 8)}`}, ${thirdRef}, ${thirdRef}, ${thirdDigest},
                ${sql.json(["linux/amd64", "linux/arm64"] as never)}, 'trusted', now())
        RETURNING id`;
      chromeVersionId = chromeVersion?.id ?? null;
      thirdImageId = thirdImage?.id ?? null;
      thirdVersionId = thirdVersion?.id ?? null;
      const { listHubRuntimeImageCatalog } = await import("../../runtime-images.js");
      const catalog = await listHubRuntimeImageCatalog(sql, projectId);
      assert.ok(catalog.every((entry) => entry.compatible_agent_clis.length > 0));
      assert.deepEqual(
        catalog.find((entry) => entry.image_key === "deepsonar-kali-minimal")?.compatible_agent_clis,
        ["claude-code", "dsh", "pi"],
      );
      assert.deepEqual(
        catalog.find((entry) => entry.image_key === "deepsonar-chrome-fuzz")?.compatible_agent_clis,
        ["claude-code", "pi"],
      );
      assert.equal(catalog.some((entry) => entry.image_key === thirdImageKey), false);

      // 7) dsh review + chrome-fuzz is invalid_runtime_image, never an uncaught 500.
      const [reviewRole] = await sql<{ id: string }[]>`SELECT id FROM agent_roles WHERE name = 'review'`;
      await sql`UPDATE projects SET config_json = ${sql.json({
        rules: { hubEnabled: false },
        image_strategy: "project_managed",
      })} WHERE id = ${projectId}`;
      await sql`
        INSERT INTO role_configs (role_id, project_id, agent_cli)
        VALUES (${reviewRole.id}, ${projectId}, 'dsh')`;
      const hubDsh = await makeHubJob();
      await assert.rejects(
        preflightDeferredSemanticEvent(hubDsh, "hub_decision", {
          intents: [intent("dispatch dsh review on chrome fuzz", "deepsonar-chrome-fuzz")],
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_runtime_image" && error.retryable,
      );
      await assert.rejects(
        ingestEvent(hubDsh, {
          v: 1,
          event_id: randomUUID(),
          type: "hub_decision",
          payload: { intents: [intent("dispatch dsh review on chrome fuzz apply", "deepsonar-chrome-fuzz")] },
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_runtime_image",
      );
      const [dshJob] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'review' AND parent_job_id = ${hubDsh}`;
      assert.equal(dshJob?.count, 0, "CLI-incompatible image proposal must not create a Worker Job");
    } finally {
      // The gate runs every Postgres integration step against one shared DB, and
      // dispatcher claims are global: 5 'running' hub Jobs left behind would
      // consume the maxGlobalJobs budget of later tests (dispatchSlots clamps at
      // max(0, cap - active)), and a leftover trusted kali version + derived
      // pending review Jobs would bleed into runtime-image and claim assertions.
      if (kaliVersionId) {
        await sql`DELETE FROM runtime_image_version_refs WHERE version_id = ${kaliVersionId}`;
        await sql`DELETE FROM runtime_image_versions WHERE id = ${kaliVersionId}`;
      }
      if (chromeVersionId) {
        await sql`DELETE FROM runtime_image_version_refs WHERE version_id = ${chromeVersionId}`;
        await sql`DELETE FROM runtime_image_versions WHERE id = ${chromeVersionId}`;
      }
      if (thirdVersionId) {
        await sql`DELETE FROM runtime_image_versions WHERE id = ${thirdVersionId}`;
      }
      // events.job_id and canvas_nodes.job_id reference jobs without ON DELETE
      // CASCADE, so rows that point at this canvas' Jobs must go first. The
      // accepted hub decisions also write semantic events for the derived
      // Worker Jobs, so the subquery covers both hub and worker ids.
      await sql`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE canvas_id = ${canvasId})`;
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM jobs WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      if (thirdImageId) {
        await sql`DELETE FROM runtime_images WHERE id = ${thirdImageId}`;
      }
      await sql.end({ timeout: 5 });
    }
  });
}
