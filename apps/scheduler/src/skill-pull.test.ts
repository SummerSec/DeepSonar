import assert from "node:assert/strict";
import test from "node:test";
import {
  contentHashOf,
  listAvailableSkillsFromCatalog,
  pullSkillFromCatalog,
  type SkillSourceCatalogView,
} from "./skill-sources.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const skill = {
  id: "whitebox/authz",
  kind: "skill" as const,
  plugin: "whitebox",
  name: "authz",
  description: "Authorization review workflow",
  files: { "SKILL.md": "# authz\n", "references/checklist.md": "check" },
};
const sources: SkillSourceCatalogView[] = [{
  id: sourceId,
  last_commit_sha: "abc123",
  catalog: [skill, { ...skill, id: "whitebox/command", kind: "command", name: "command", files: { "command.md": "run" } }],
}];

test("Agent Skill catalog lists concrete pull selectors and hashes", () => {
  const result = listAvailableSkillsFromCatalog(sources);
  assert.equal(result.total, 1);
  assert.equal(result.skills[0]?.selector, `${sourceId}:whitebox/authz`);
  assert.equal(result.skills[0]?.content_hash, contentHashOf([skill]));
});

test("pull_skill returns bounded files only after the hash matches", () => {
  const hash = contentHashOf([skill]);
  const result = pullSkillFromCatalog(sources, `${sourceId}:whitebox/authz`, hash);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skill.files["SKILL.md"], "# authz\n");
    assert.equal(result.skill.commit_sha, "abc123");
  }
  assert.equal(pullSkillFromCatalog(sources, `${sourceId}:whitebox/authz`, "0".repeat(64)).ok, false);
});

test("pull_skill rejects broad selectors and unknown modules", () => {
  assert.equal(pullSkillFromCatalog(sources, `${sourceId}:source:*`, contentHashOf([skill])).ok, false);
  assert.equal(pullSkillFromCatalog(sources, `${sourceId}:whitebox/missing`, "0".repeat(64)).ok, false);
});
