import test from "node:test";
import assert from "node:assert/strict";
import { injectKnowledgePlatformSkills, PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./platform-skills.js";

test("platform discovery cannot be overridden and ordinary Jobs do not receive governance Skill", () => {
  const skills = injectKnowledgePlatformSkills([{ name: "deepsonar-skill-discovery", files: { "SKILL.md": "override" } }, { name: "business" }]);
  assert.equal(skills.length, 2);
  assert.equal(skills.filter((skill) => skill.name === "deepsonar-skill-discovery").length, 1);
  const content = skills.find((skill) => skill.name === "deepsonar-skill-discovery")!.files!["SKILL.md"];
  assert.match(content, /search_skills/); assert.match(content, /pull_skill/); assert.match(content, /usage_ref/);
  assert.ok(!skills.some((skill) => skill.name === "deepsonar-project-knowledge"));
});

test("governance Skill requires the platform baseline frozen in an assigned Job", () => {
  const assignment = { work_id: "work", stage: "maker" as const, inputs: [], governance_hash: PROJECT_KNOWLEDGE_GOVERNANCE_HASH };
  assert.ok(injectKnowledgePlatformSkills([], assignment).some((skill) => skill.name === "deepsonar-project-knowledge"));
  assert.throws(() => injectKnowledgePlatformSkills([], { ...assignment, governance_hash: "0".repeat(64) }), /baseline/);
});
