import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiDocument } from "./openapi.js";

test("canvas delta OpenAPI exposes a required since query parameter", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths as Record<string, Record<string, unknown>>)["/canvases/{id}/delta"]?.get as Record<string, unknown>;
  const parameters = operation.parameters as Array<Record<string, unknown>>;
  const since = parameters.find((parameter) => parameter.name === "since");
  assert.deepEqual(since, {
    name: "since",
    in: "query",
    required: true,
    schema: { type: "string", pattern: "^[0-9]+$" },
  });
  assert.equal(parameters.some((parameter) => parameter.name === "type"), false);
});

test("credential OpenAPI exposes safe metadata, health and impact/model APIs", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, unknown>>;
  assert.ok(paths["/credentials/{id}"]?.get);
  assert.ok(paths["/credentials/{id}/impact"]?.get);
  assert.ok(paths["/credentials/{id}/models"]?.get);
  assert.ok(paths["/credentials/{id}/compatibility"]?.get);
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, unknown>>;
  assert.equal(schemas.CredentialMetadata?.additionalProperties, false);
  assert.deepEqual(schemas.CredentialHealth?.properties && (schemas.CredentialHealth.properties as Record<string, unknown>).status, {
    type: "string",
    enum: ["unknown", "ok", "error"],
  });
});

test("credential project-reference OpenAPI documents scoped impact and global rejection", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, any>>;
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  assert.ok(schemas.CredentialImpact.required.includes("project_references"));
  assert.match(schemas.CredentialImpact.properties.project_references.description, /actor 可见项目/);
  const deletion = paths["/credentials/{id}"].delete;
  const rejection = deletion.responses["409"].content["application/json"].schema.allOf[1].properties;
  assert.ok(rejection.error_code.enum.includes("CREDENTIAL_PROJECT_REFERENCE"));
  assert.equal(rejection.next_action.type, "string");
  assert.match(deletion.description, /所有项目/);
  assert.doesNotMatch(deletion.responses["409"].description, /RoleConfig/);
  const settings = paths["/projects/{id}/settings"].patch;
  assert.match(settings.description, /provider_credential_allowlist_stale/);
  assert.ok(settings.requestBody.content["application/json"].schema.properties.fallback_model_refs);
});

test("credential batch and picker OpenAPI contracts are strict and typed", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, unknown>>;
  const providers = paths["/credentials/providers"]?.get as Record<string, any>;
  const bindable = paths["/role-configs/bindable"]?.get as Record<string, any>;
  assert.equal(providers.responses["200"].content["application/json"].schema.type, "array");
  assert.equal(bindable.responses["200"].content["application/json"].schema.type, "array");
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  assert.equal(schemas.ProviderAccountCatalogItem.additionalProperties, false);
});

test("RoleConfig and role registry OpenAPI documents project-scope boundaries", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, any>>;
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  assert.ok(schemas.Error?.properties?.error_code);
  for (const [path, method] of [
    ["/role-configs/global/{roleId}", "put"],
    ["/agent-roles", "post"],
    ["/agent-roles/{id}", "patch"],
    ["/agent-roles/{id}", "delete"],
  ] as const) {
    assert.match(String(paths[path]?.[method]?.description), /PROJECT_SCOPE_FORBIDDEN/);
  }
  assert.match(String(paths["/role-configs/global"]?.get?.description), /#690/);
  assert.match(String(paths["/role-configs/bindable"]?.get?.description), /can_bind/);
  assert.match(String(paths["/role-configs/global"]?.get?.description), /凭据绑定/);
  const globalPut = paths["/role-configs/global/{roleId}"]?.put;
  const roleIdParam = (globalPut.parameters as Array<Record<string, any>>).find((parameter) => parameter.name === "roleId");
  assert.deepEqual(roleIdParam?.schema, { type: "string", format: "uuid" });
  assert.match(String(globalPut.description), /INVALID_ROLE_ID/);
  assert.match(String(globalPut.description), /不是角色名/);
  assert.match(String(paths["/role-configs/{id}/agent-cli"]?.patch?.description), /INVALID_ROLE_CONFIG_ID/);
  assert.match(String(paths["/projects/{id}/role-configs/{roleId}"]?.put?.description), /INVALID_ROLE_ID/);
  assert.match(String(paths["/projects/{id}/role-configs/{roleId}"]?.delete?.description), /INVALID_ROLE_ID/);
});

test("/health OpenAPI includes deploy version", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, any>>;
  const health = paths["/health"]?.get as Record<string, any>;
  const schema = health.responses["200"].content["application/json"].schema;
  assert.deepEqual(schema.required, ["ok", "ready", "version"]);
  assert.deepEqual(schema.oneOf, [
    { required: ["git_revision", "runtime_images", "dispatcher", "opensandbox", "ts"] },
    { required: ["maintenance", "maintenance_ready", "upgrade_phase", "upgrade_generation", "upgrade_runtime_role", "upgrade_target_version"] },
  ]);
  assert.deepEqual(schema.properties.maintenance.enum, [true]);
  assert.equal(schema.properties.git_revision.type, "string");
  assert.deepEqual(schema.properties.opensandbox.required, ["level", "domain", "ready"]);
  assert.equal(schema.properties.version.type, "string");
});

test("runtime registry channel OpenAPI is strict and project-scope aware", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, any>>;
  const registry = paths["/runtime-images/registry"]?.get as Record<string, any>;
  const channel = paths["/runtime-images/registry/channel"]?.patch as Record<string, any>;
  const pull = paths["/runtime-images/registry/pull"]?.post as Record<string, any>;
  const channels = ["github", "dockerhub", "aliyun-acr"];

  assert.deepEqual(registry.responses["200"].content["application/json"].schema.required, ["schema", "images", "selected_channel"]);
  assert.deepEqual(registry.responses["200"].content["application/json"].schema.properties.selected_channel, {
    type: "string",
    enum: channels,
  });
  assert.equal(channel["x-deepsonar-scope"], "images:manage");
  assert.deepEqual(channel.requestBody.content["application/json"].schema, {
    type: "object",
    additionalProperties: false,
    required: ["channel"],
    properties: { channel: { type: "string", enum: channels } },
  });
  assert.match(String(channel.description), /PROJECT_SCOPE_FORBIDDEN/);
  assert.match(String(channel.description), /github.*dockerhub.*aliyun-acr/);
  assert.match(String(channel.description), /in-flight|pull-status|runtime_image_preparation_busy/);
  assert.equal(channel.responses["202"].content["application/json"].schema.properties.saved.enum[0], false);
  assert.match(String(channel.responses["403"].content["application/json"].schema.properties.error_code.enum), /PROJECT_SCOPE_FORBIDDEN/);
  assert.match(String(channel.responses["500"].content["application/json"].schema.properties.error_code.enum), /RUNTIME_REGISTRY_CHANNEL_UPDATE_FAILED/);
  assert.match(String(pull.description), /PROJECT_SCOPE_FORBIDDEN/);
  assert.match(String(pull.description), /RUNTIME_IMAGE_CHANNEL_UNAVAILABLE/);
  assert.match(String(paths["/tokens"]?.post?.description), /SCOPE_EXCEEDS_ACTOR|PROJECT_MISMATCH/);
  assert.match(String(paths["/runtime-image-versions/{id}/usage"]?.get?.description), /自身项目/);
  assert.deepEqual(
    pull.responses["409"].content["application/json"].schema.properties.error_code.enum,
    ["RUNTIME_IMAGE_CHANNEL_UNAVAILABLE"],
  );
});

test("RoleConfigInput no longer accepts credentials or pi_extensions (#690)", () => {
  const document = buildOpenApiDocument();
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  const props = schemas.RoleConfigInput?.properties ?? {};
  assert.equal(props.credentials, undefined);
  assert.equal(props.pi_extensions, undefined);
  assert.equal((document.paths as Record<string, unknown>)["/credentials/batch-bind"], undefined);
  assert.equal(schemas.CredentialBatchBindingRequest, undefined);
});

test("governed quality OpenAPI keeps session authority, strict inputs and safe unknown reports", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, any>>;
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  const quality = Object.entries(paths).filter(([path]) => path.startsWith("/projects/{id}/finding-quality"));
  const operations = quality.flatMap(([, methods]) => Object.values(methods));
  assert.equal(operations.length, 9);
  for (const operation of operations) {
    assert.equal(operation["x-deepsonar-scope"], "admin");
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.match(operation.description, /stored user session/);
    assert.equal((operation.parameters ?? []).some((parameter: Record<string, unknown>) => parameter.in === "query"), false);
    const success = operation.responses["200"].content["application/json"].schema;
    assert.equal(success.type, "object");
    assert.equal(success.additionalProperties, false);
    assert.equal(success.content, undefined, "Response Objects must not be double-wrapped as schemas");
    assert.deepEqual(success.properties.quality_status.enum, ["not_evaluated"]);
    for (const status of ["400", "401", "403", "404", "409", "413", "500", "503"]) {
      assert.equal(operation.responses[status].content["application/json"].schema.type, "object");
    }
  }
  assert.equal(schemas.FindingQualityProtocol.additionalProperties, false);
  assert.equal(schemas.FindingQualityDataset.additionalProperties, false);
  assert.deepEqual(schemas.FindingQualityDataset.properties.kind.enum, ["synthetic", "human_labeled"]);
  assert.equal(schemas.FindingQualityVersion.properties.expected_version.type, "string");
  assert.deepEqual(schemas.FindingQualityVersion.required, ["expected_version"]);
  const report = schemas.FindingQualitySafeReport;
  assert.equal(report.additionalProperties, false);
  assert.deepEqual(report.properties.dataset_kind.enum, ["synthetic", "human_labeled"]);
  for (const raw of ["input", "pairs", "sources", "selections", "selection", "decisions", "observations"]) {
    assert.equal(report.properties[raw], undefined);
  }
  const operation = paths["/projects/{id}/finding-quality/protocols/{protocolId}/report"].get;
  assert.deepEqual(operation.responses["200"].content["application/json"].schema.properties.report, {
    $ref: "#/components/schemas/FindingQualitySafeReport",
  });
});
