import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { sql } from '../../db.js';
import { CursorError, QueryParameterError } from '../../pagination.js';
import { isUuid } from '../../project-scope.js';
import { lexicalFeatures, loadLexicalSubject } from './lexical-search.js';
import { CANDIDATE_RULE_VERSION, loadCandidateSource } from './candidate-source.js';

export interface CandidatePage {
  subject_id:string;project_id:string;subject_digest:string;
  status:'pending'|'running'|'succeeded'|'failed'|'stale';rebuilding:boolean;active_generation:string|null;
  rule_version:string;processed_at:string|null;error_code:string|null;attempts:number;
  examined:number;scan_limit:25;limit:25;next_cursor:string|null;window_limited:true;stale_results_omitted:boolean;
  source_window:{examined:number|null;scan_limit:128;limit:25;rank_truncated:boolean|null};
  identity_status:'insufficient_information';query_plane:'durable_candidates';
  items:Array<{finding_id:string;job_id:string;canvas_id:string;title:string;lexical_digest:string;
    kind:'similar'|'insufficient_information';matched_fields:string[];score:number;processed_at:string;text_truncated:boolean}>;
}
interface CandidateCursor {v:1;kind:'finding_candidates';project:string;subject:string;binding:string;after:string}
function parseCursor(value:unknown):CandidateCursor|null {
  if(value===undefined||value===null||value==='')return null;
  const invalid=()=>new QueryParameterError('cursor','invalid candidate cursor');
  if(typeof value!=='string'||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw invalid();
  const decoded=Buffer.from(value,'base64url');if(decoded.toString('base64url')!==value)throw invalid();
  let parsed:unknown;try{parsed=JSON.parse(decoded.toString('utf8'));}catch{throw invalid();}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw invalid();
  const c=parsed as Record<string,unknown>;
  if(Object.keys(c).sort().join(',')!=='after,binding,kind,project,subject,v'||c.v!==1||c.kind!=='finding_candidates'
    ||![c.project,c.subject,c.after].every(v=>typeof v==='string'&&isUuid(v))
    ||typeof c.binding!=='string'||!/^[a-f0-9]{64}$/.test(c.binding))throw invalid();
  return c as unknown as CandidateCursor;
}
/** Two index seeks bounded to 26 each, then at most 52-row merge; filter after window. */
export function candidateWindowQuery(tx:TransactionSql,project:string,generation:string,subject:string,after:string|null) {
  return tx`SELECT * FROM (
    (SELECT *,right_id AS peer_id FROM project_finding_candidate_edges
      WHERE project_id=${project}::uuid AND generation=${generation}::uuid AND left_id=${subject}::uuid
        ${after?tx`AND right_id>${after}::uuid`:tx``} ORDER BY right_id LIMIT 26)
    UNION ALL
    (SELECT *,left_id AS peer_id FROM project_finding_candidate_edges
      WHERE project_id=${project}::uuid AND generation=${generation}::uuid AND right_id=${subject}::uuid
        ${after?tx`AND left_id>${after}::uuid`:tx``} ORDER BY left_id LIMIT 26)
  ) candidates ORDER BY peer_id LIMIT 26`;
}

/** Authorization precedes this call; project fence and every endpoint chain are rechecked. */
export async function readCandidatePage(id:string,cursorValue:unknown,db=sql,actorProject?:string|null):Promise<CandidatePage|null> {
  if(!isUuid(id))throw new QueryParameterError('id','invalid finding id');
  const cursor=parseCursor(cursorValue);
  return db.begin('isolation level repeatable read read only',async tx=>{
    await tx`SET LOCAL statement_timeout='3000ms'`;
    const declaration=await loadLexicalSubject(tx,id,actorProject);
    if(!declaration)return null;
    if(cursor&&(cursor.project.toLowerCase()!==declaration.project_id||cursor.subject.toLowerCase()!==declaration.id))
      throw new QueryParameterError('cursor','candidate cursor scope mismatch');
    const features=lexicalFeatures(declaration);
    const [work]=await tx`SELECT * FROM project_finding_candidate_work WHERE project_id=${declaration.project_id}::uuid`;
    const [progress]=work?.active_generation ? await tx`SELECT * FROM project_finding_candidate_sources
      WHERE project_id=${declaration.project_id}::uuid AND generation=${work.active_generation}::uuid AND finding_id=${id}::uuid`:[];
    const result:CandidatePage={subject_id:declaration.id,project_id:declaration.project_id,subject_digest:features.source_digest,
      status:work?.status==='failed'?'failed':work?.status==='running'?'running':'pending',rebuilding:Boolean(work&&work.generation!==work.active_generation),
      active_generation:work?.active_generation?String(work.active_generation):null,rule_version:CANDIDATE_RULE_VERSION,
      processed_at:null,error_code:work?.error_code??null,attempts:Number(work?.attempts??0),examined:0,scan_limit:25,limit:25,next_cursor:null,
      window_limited:true,stale_results_omitted:false,source_window:{examined:null,scan_limit:128,limit:25,rank_truncated:null},
      identity_status:'insufficient_information',query_plane:'durable_candidates',items:[]};
    let subject;
    try{subject=await loadCandidateSource(tx,id,declaration.project_id);}catch(error){
      if(!(error instanceof Error)||error.message!=='CANDIDATE_EVIDENCE_BUDGET_EXCEEDED')throw error;
      if(cursor)throw new CursorError('CURSOR_GAP');
      return {...result,status:'failed',error_code:'CANDIDATE_EVIDENCE_BUDGET_EXCEEDED',stale_results_omitted:Boolean(work?.active_generation)};
    }
    if(!subject)return null;
    // Opaque combined binding; private evidence input digest is never exposed separately.
    const binding=createHash('sha256').update(JSON.stringify([declaration.id,declaration.project_id,subject.input_digest,
      work?.active_generation??null,CANDIDATE_RULE_VERSION])).digest('hex');
    if(cursor&&cursor.binding!==binding)throw new CursorError('CURSOR_GAP');
    if(!work?.active_generation)return result;
    const fresh=progress?.input_digest===subject.input_digest&&progress?.lexical_digest===subject.lexical_digest&&progress?.rule_version===CANDIDATE_RULE_VERSION;
    if(fresh){
      result.status=work.status==='failed'?'failed':'succeeded';result.processed_at=new Date(progress.processed_at).toISOString();
      result.source_window={examined:Number(progress.examined),scan_limit:128,limit:25,rank_truncated:Boolean(progress.rank_truncated)};
    }else{result.status=work.status==='failed'?'failed':'stale';}
    const rows=await candidateWindowQuery(tx,declaration.project_id,String(work.active_generation),declaration.id,cursor?.after??null);
    const window=rows.slice(0,25);result.examined=window.length;
    for(const edge of window){
      let peer;try{peer=await loadCandidateSource(tx,String(edge.peer_id),declaration.project_id);}catch(error){
        if(!(error instanceof Error)||error.message!=='CANDIDATE_EVIDENCE_BUDGET_EXCEEDED')throw error;
      }
      const left=edge.left_id===declaration.id;
      if(!peer||edge.rule_version!==CANDIDATE_RULE_VERSION||peer.source.job_id===subject.source.job_id
        ||edge[left?'left_input_digest':'right_input_digest']!==subject.input_digest
        ||edge[left?'right_input_digest':'left_input_digest']!==peer.input_digest
        ||edge[left?'left_lexical_digest':'right_lexical_digest']!==subject.lexical_digest
        ||edge[left?'right_lexical_digest':'left_lexical_digest']!==peer.lexical_digest){result.stale_results_omitted=true;continue;}
      result.items.push({finding_id:peer.source.id,job_id:peer.source.job_id,canvas_id:peer.source.canvas_id,title:peer.title,
        lexical_digest:peer.lexical_digest,kind:edge.kind as 'similar'|'insufficient_information',matched_fields:edge.matched_fields as string[],
        score:Number(edge.score),processed_at:new Date(edge.processed_at).toISOString(),text_truncated:peer.text_truncated});
    }
    if(result.stale_results_omitted&&result.status!=='failed')result.status='stale';
    if(rows.length>25){const last=window.at(-1)!;result.next_cursor=Buffer.from(JSON.stringify({v:1,kind:'finding_candidates',
      project:declaration.project_id,subject:declaration.id,binding,after:last.peer_id})).toString('base64url');}
    return result;
  });
}
