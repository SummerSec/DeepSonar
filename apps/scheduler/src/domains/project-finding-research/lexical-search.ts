import type { TransactionSql } from 'postgres';
import { sql } from '../../db.js';
import { CursorError, QueryParameterError } from '../../pagination.js';
import { isUuid } from '../../project-scope.js';
import {
  compareFindingFeatures, extractFindingFeatures, NORMALIZATION_VERSION, rankLexicalCandidates,
  RELATION_RULE_VERSION, type FindingFeatureSource,
} from './model.js';

export const LEXICAL_SCAN_LIMIT = 128;
export const LEXICAL_RESULT_LIMIT = 25;
const TEXT_LIMIT = 16_000;
const CURSOR_KIND = 'finding_lexical';
interface LexicalCursor {
  v: 1; kind: typeof CURSOR_KIND; project: string; subject: string; digest: string;
  after: string; rule: string; normalization: string;
}
export interface DeclarationRow {
  id: string; project_id: string; job_id: string; canvas_id: string | null;
  title: string; location: string | null; summary: string | null; profile: string; category: string | null;
  updated_at: string; declaration_stamp: string; text_truncated: boolean;
}
export interface LexicalSearchResult {
  subject_id: string; project_id: string; subject_digest: string; subject_text_truncated: boolean;
  rule_version: string; normalization_version: string; computed_at: string;
  examined: number; scan_limit: 128; limit: 25; next_cursor: string | null;
  window_limited: true; rank_truncated: boolean; identity_status: 'insufficient_information'; query_plane: 'current';
  items: Array<{
    finding_id: string; job_id: string; canvas_id: string; title: string; lexical_digest: string;
    kind: 'similar' | 'insufficient_information'; matched_fields: string[]; score: number; text_truncated: boolean;
  }>;
}

export function parseLexicalCursor(value: unknown): LexicalCursor | null {
  if (value === undefined || value === null || value === '') return null;
  const invalid = () => new QueryParameterError('cursor', 'invalid lexical search cursor');
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.toString('utf8')); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'after,digest,kind,normalization,project,rule,subject,v'
    || row.v !== 1 || row.kind !== CURSOR_KIND
    || !isUuid(typeof row.project === 'string' ? row.project : undefined)
    || !isUuid(typeof row.subject === 'string' ? row.subject : undefined)
    || !isUuid(typeof row.after === 'string' ? row.after : undefined)
    || typeof row.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.digest)
    || typeof row.rule !== 'string' || row.rule.length < 1 || row.rule.length > 128
    || typeof row.normalization !== 'string' || row.normalization.length < 1 || row.normalization.length > 128) throw invalid();
  return row as unknown as LexicalCursor;
}
function encodeLexicalCursor(value: LexicalCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** The declaration stamp detects edits beyond the transport clip, without returning text.
 * No Artifact/Evidence/asset read occurs. This digest is NOT the persisted C input digest. */
function declarationColumns(db: TransactionSql) {
  return db`f.id, f.project_id, f.job_id, j.canvas_id,
    left(f.title, ${TEXT_LIMIT}) AS title,
    left(f.location, greatest(0, ${TEXT_LIMIT} - char_length(f.title))) AS location,
    left(f.summary, greatest(0, ${TEXT_LIMIT} - char_length(f.title) - coalesce(char_length(f.location), 0))) AS summary,
    f.profile, f.category,
    to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
    encode(sha256(convert_to(jsonb_build_array(f.title, f.location, f.summary, f.profile, f.category)::text, 'UTF8')), 'hex') AS declaration_stamp,
    char_length(f.title) + coalesce(char_length(f.location), 0) + coalesce(char_length(f.summary), 0) > ${TEXT_LIMIT} AS text_truncated`;
}
export function lexicalFeatures(row: DeclarationRow) {
  const source: FindingFeatureSource = {
    id: row.id, project_id: row.project_id, job_id: row.job_id, canvas_id: row.canvas_id!,
    artifact_id: null, artifact_revision: null, title: row.title, location: row.location, summary: row.summary,
    profile: row.profile, category: row.category, source_digest: `declaration-sha256:${row.declaration_stamp}`, updated_at: row.updated_at,
  };
  return extractFindingFeatures(source);
}

/** Exposed for EXPLAIN probes so the measured query is the runtime query. The
 * MATERIALIZED source window happens before eligibility, joins, and lexical ranking.
 * LATERAL LIMIT/OFFSET prevents flattening point lookups into full-table hash joins. */
export function lexicalWindowQuery(db: TransactionSql, projectId: string, after: string | null) {
  return db`WITH source_window AS MATERIALIZED (
    SELECT id FROM findings WHERE project_id = ${projectId}::uuid
      ${after ? db`AND id > ${after}::uuid` : db``}
    ORDER BY id LIMIT ${LEXICAL_SCAN_LIMIT + 1}
  )
  SELECT ${declarationColumns(db)}, c.id IS NOT NULL AS valid_chain
  FROM source_window w
  JOIN LATERAL (SELECT id, project_id, job_id, title, location, summary, profile, category, updated_at
    FROM findings WHERE id = w.id AND project_id = ${projectId}::uuid LIMIT 1 OFFSET 0) f ON true
  LEFT JOIN LATERAL (SELECT id, canvas_id FROM jobs
    WHERE id = f.job_id AND project_id = f.project_id LIMIT 1 OFFSET 0) j ON true
  LEFT JOIN LATERAL (SELECT id FROM canvases
    WHERE id = j.canvas_id AND project_id = f.project_id LIMIT 1 OFFSET 0) c ON true
  ORDER BY f.id`;
}

export async function loadLexicalSubject(tx: TransactionSql, id: string, authorizedProjectId?: string | null): Promise<DeclarationRow | null> {
    const [subject] = await tx`SELECT ${declarationColumns(tx)}
      FROM findings f JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      JOIN canvases c ON c.id = j.canvas_id AND c.project_id = f.project_id
      WHERE f.id = ${id}::uuid
        AND (${authorizedProjectId ?? null}::uuid IS NULL OR f.project_id = ${authorizedProjectId ?? null}::uuid)`;
  return subject ? subject as unknown as DeclarationRow : null;
}

/** Management authorization must precede this call; the optional project fence
 * repeats a scoped Actor restriction inside the same read-only snapshot. */
export async function searchFindingLexical(
  id: string, cursorValue: unknown, db = sql, authorizedProjectId?: string | null,
): Promise<LexicalSearchResult | null> {
  if (!isUuid(id)) throw new QueryParameterError('id', 'invalid finding id');
  parseLexicalCursor(cursorValue);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '3000ms'`;
    return searchFindingLexicalSnapshot(tx, id, cursorValue, authorizedProjectId);
  });
}

/** Internal reuse inside the candidate worker transaction; no independent snapshot. */
export async function searchFindingLexicalSnapshot(tx: TransactionSql, id: string, cursorValue: unknown, authorizedProjectId?: string | null): Promise<LexicalSearchResult | null> {
  const cursor = parseLexicalCursor(cursorValue);
    const subject = await loadLexicalSubject(tx, id, authorizedProjectId);
    if (!subject) return null;
    const subjectRow = subject as unknown as DeclarationRow;
    const subjectFeatures = lexicalFeatures(subjectRow);
    if (cursor && (cursor.project.toLowerCase() !== subjectRow.project_id || cursor.subject.toLowerCase() !== subjectRow.id)) {
      throw new QueryParameterError('cursor', 'lexical search cursor scope mismatch');
    }
    if (cursor && (cursor.digest !== subjectFeatures.source_digest || cursor.rule !== RELATION_RULE_VERSION
      || cursor.normalization !== NORMALIZATION_VERSION)) throw new CursorError('CURSOR_GAP');
    const allRows = await lexicalWindowQuery(tx, subjectRow.project_id, cursor?.after ?? null);
    const window = allRows.slice(0, LEXICAL_SCAN_LIMIT);
    const eligible = window.filter((row) => row.valid_chain && row.id !== subjectRow.id && row.job_id !== subjectRow.job_id)
      .map((row) => row as unknown as DeclarationRow);
    const features = eligible.map(lexicalFeatures);
    const ranked = rankLexicalCandidates(subjectFeatures, features, { limit: LEXICAL_RESULT_LIMIT, scanBudget: LEXICAL_SCAN_LIMIT });
    const items = ranked.candidates.map((candidate) => {
      const index = eligible.findIndex((row) => row.id === candidate.finding_id);
      const row = eligible[index], feature = features[index];
      const comparison = compareFindingFeatures(subjectFeatures, feature);
      return {
        finding_id: row.id, job_id: row.job_id, canvas_id: row.canvas_id!, title: row.title,
        lexical_digest: feature.source_digest, kind: comparison.kind === 'similar' ? 'similar' as const : 'insufficient_information' as const,
        matched_fields: comparison.matched_fields, score: candidate.score,
        text_truncated: row.text_truncated || feature.lexical.truncated,
      };
    });
    const [clock] = await tx`SELECT transaction_timestamp() AS at`;
    const last = window.at(-1);
    return {
      subject_id: subjectRow.id, project_id: subjectRow.project_id, subject_digest: subjectFeatures.source_digest,
      subject_text_truncated: subjectRow.text_truncated || subjectFeatures.lexical.truncated,
      rule_version: RELATION_RULE_VERSION, normalization_version: NORMALIZATION_VERSION,
      computed_at: new Date(clock.at as string).toISOString(), examined: window.length,
      scan_limit: LEXICAL_SCAN_LIMIT, limit: LEXICAL_RESULT_LIMIT, window_limited: true, rank_truncated: ranked.truncated,
      next_cursor: allRows.length > LEXICAL_SCAN_LIMIT && last ? encodeLexicalCursor({ v: 1, kind: CURSOR_KIND,
        project: subjectRow.project_id, subject: subjectRow.id, digest: subjectFeatures.source_digest,
        after: String(last.id), rule: RELATION_RULE_VERSION, normalization: NORMALIZATION_VERSION }) : null,
      items, identity_status: 'insufficient_information', query_plane: 'current',
    };
}
