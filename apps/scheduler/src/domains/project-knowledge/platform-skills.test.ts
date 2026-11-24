import test from "node:test";
import assert from "node:assert/strict";
import { injectKnowledgePlatformSkills, PROJECT_KNOWLEDGE_GOVERNANCE_HASH, projectKnowledgeReuseHint } from "./platform-skills.js";
import { canonical, sha256 } from "./types.js";

test("platform discovery cannot be overridden and ordinary Jobs do not receive governance Skill", () => {
  const skills = injectKnowledgePlatformSkills([{ name: "deepsonar-skill-discovery", files: { "SKILL.md": "override" } }, { name: "business" }]);
  assert.equal(skills.length, 2);
  assert.equal(skills.filter((skill) => skill.name === "deepsonar-skill-discovery").length, 1);
  const content = skills.find((skill) => skill.name === "deepsonar-skill-discovery")!.files!["SKILL.md"];
  assert.match(content, /search_skills/); assert.match(content, /pull_skill/); assert.match(content, /usage_ref/);
  assert.ok(!skills.some((skill) => skill.name === "deepsonar-project-knowledge"));
});

test("ordinary Jobs receive a bounded reuse pointer while independent and governance Jobs remain isolated", () => {
  const entries = [{ kind: "memory", title: "private title" }, { kind: "skill", title: "private skill title" }];
  const snapshot = { project_knowledge_catalog: { entries, hash: sha256(canonical(entries)) },
    platform_tools: ["search_project_knowledge", "read_project_knowledge", "search_skills", "pull_skill"] };
  const hint = projectKnowledgeReuseHint(snapshot, "audit");
  assert.match(hint, /1 条项目 Memory、1 条项目 Skill/);
  assert.match(hint, /usage_ref/);
  assert.ok(!hint.includes("private"));
  for (const type of ["report", "verify_finding", "independent_review"]) assert.equal(projectKnowledgeReuseHint(snapshot, type), "");
  assert.equal(projectKnowledgeReuseHint({ ...snapshot, knowledge_assignment: {} }, "test"), "");
  assert.equal(projectKnowledgeReuseHint({ ...snapshot, platform_tools: [] }, "audit"), "");
  assert.equal(projectKnowledgeReuseHint({ ...snapshot, project_knowledge_catalog: { entries, hash: "invalid" } }, "audit"), "");
});

test("governance Skill requires the platform baseline frozen in an assigned Job", () => {
  const assignment = { work_id: "work", stage: "maker" as const, inputs: [], governance_hash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH };
  assert.ok(injectKnowledgePlatformSkills([], assignment).some((skill) => skill.name === "deepsonar-project-knowledge"));
  assert.throws(() => injectKnowledgePlatformSkills([], { ...assignment, governance_hash: "0".repeat(64) }), /baseline/);
});

test("trial injection contains execution guidance but neither grading answers nor discovery Skills", () => {
  const trial = injectKnowledgePlatformSkills([{ name: "business", files: { "SKILL.md": "unrelated private answer" } }], {
    work_id: "work", stage: "trial", inputs: [], governance_hash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH,
  });
  assert.equal(trial.length, 2);
  assert.ok(trial.some(skill => skill.name === "deepsonar-control"), "mandatory control protocol must survive trial isolation");
  assert.ok(trial.find(skill => skill.name === "deepsonar-project-knowledge-trial")!.files!["SKILL.md"]!.includes("publish_shared_asset"));
  assert.ok(!JSON.stringify(trial).includes("unrelated private answer"));
  assert.ok(!JSON.stringify(trial).includes("evaluation-cases.json"));
  assert.ok(!JSON.stringify(trial).includes("KNOWLEDGE_SCOPE_DENIED"));
});

test("#1219 反馈指引与 schema 允许值对齐：不提交 unknown，缺评就是未知", async () => {
  const { PLATFORM_OPERATION_REGISTRY } = await import("../platform-api/operations.js");
  // 允许的 outcome 只有这三个；指引里不得出现「提交 unknown」这种会被 schema 拒绝的写法。
  const allowed = ["success", "failure", "inapplicable"];
  const record = PLATFORM_OPERATION_REGISTRY.record_knowledge_feedback.description;
  for (const value of allowed) assert.match(record, new RegExp(value, "u"), value);
  assert.match(record, /there is no 'unknown' value to submit/u);
  assert.match(record, /omitting the call is how unknown is recorded/u);
  // 新名与迁移窗口的旧名别名都要满足同一条反馈口径。
  for (const operation of ["search_project_knowledge", "read_project_knowledge", "read_project_memory"]) {
    const text = PLATFORM_OPERATION_REGISTRY[operation].description;
    assert.doesNotMatch(text, /submit (an )?unknown|outcome unknown/u, operation);
  }
  assert.match(PLATFORM_OPERATION_REGISTRY.search_project_knowledge.description, /Searching is not use/u);
  assert.match(PLATFORM_OPERATION_REGISTRY.read_project_knowledge.description, /do not call the tool/u);
  assert.match(PLATFORM_OPERATION_REGISTRY.read_project_knowledge.description, /usage_ref/u);
  assert.match(PLATFORM_OPERATION_REGISTRY.read_project_memory.description, /same post-use rating rule/u);
});
