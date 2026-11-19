/** Exact v64 -> current baseline regression, including existing C generations.
 * CI fetch-depth: 0 makes the pinned PR804 source available; never replace it
 * with a current-layout fixture marked as an old version. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";
import { SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";
import { restoreFindingSourceBackup } from "./schema-rebuild-finding-fixture.js";
import { SCHEMA_VERSION } from "./schema-version.js";

const V64_COMMIT = "6a8ab4ad777df0c727b82b34834f43c99fbd7843";
const CANDIDATE_TABLES = ["project_finding_candidate_scan", "project_finding_candidate_work", "project_finding_candidate_sources", "project_finding_candidate_edges"];
const RELATION_TABLES = ["project_finding_identity_sources", "project_finding_identity_source_revisions", "project_finding_identity_mappings", "project_finding_relation_scan", "project_finding_relation_sources", "project_finding_relation_work", "project_finding_relations"];
const QUALITY_TABLES = ["project_finding_quality_protocols", "project_finding_quality_records", "project_finding_quality_heads", "project_finding_quality_current", "project_finding_quality_work", "project_finding_quality_observations"];
