import type { TransactionSql } from 'postgres';
import { sql } from '../../db.js';
import { loadFeatureSource } from './store.js';
import { EXTRACTOR_VERSION, NORMALIZATION_VERSION, RELATION_RULE_VERSION, sourceInputDigest } from './model.js';
import { lexicalFeatures, loadLexicalSubject } from './lexical-search.js';

export const CANDIDATE_RULE_VERSION = ['durable-candidates/v1', EXTRACTOR_VERSION, NORMALIZATION_VERSION, RELATION_RULE_VERSION].join('|');
export const CANDIDATE_BATCH_SIZE = 5;
export const CANDIDATE_PROJECT_SCAN_SIZE = 25;

/** Full internal input digest is private freshness metadata, never an API field. */
export async function loadCandidateSource(tx: TransactionSql, id: string, project?: string | null) {
  const source = await loadFeatureSource(tx as unknown as typeof sql, id);
  if (!source || (project && source.project_id !== project)) return null;
  const evidence = (source.artifact_evidence as { evidence?: unknown[] } | undefined)?.evidence;
  if (Array.isArray(evidence) && evidence.length >= 129) throw new Error('CANDIDATE_EVIDENCE_BUDGET_EXCEEDED');
  const declaration = await loadLexicalSubject(tx, id, project);
  if (!declaration) return null;
  const features = lexicalFeatures(declaration);
  return { source, input_digest: sourceInputDigest(source), lexical_digest: features.source_digest,
    title: declaration.title, text_truncated: declaration.text_truncated || features.lexical.truncated };
}
