import { IDENTITY_FIELDS, type IdentityField, type RelationKind } from './model.js';
import { PLATFORM_IDENTITY_FIELDS, type PlatformIdentityField } from './identity.js';

export const OFFLINE_INPUT_BYTES = 4 * 1024 * 1024;
export const RELATION_LABELS: readonly RelationKind[] = ['suspected_same_issue','same_problem','same_root_cause_different_instance','similar','distinct','insufficient_information'];
export interface OfflineAuthoritativeIdentityMapping {
  field: PlatformIdentityField;
  identity_digest: string;
  authority_version: string;
  source_revision: string;
  source_digest: string;
  freshness_until: string;
}
export interface OfflineSource {
  id:string;project_id:string;job_id:string;split:'tuning'|'holdout';asset_group:string;family_group:string;
  revision:string|null;digest:string|null;title:string;location:string|null;summary:string|null;profile:string;category:string|null;
  identity_declarations?:Partial<Record<IdentityField,string|null>>;
  authoritative_identity_mappings?:OfflineAuthoritativeIdentityMapping[];
}
export interface OfflineDataset {
  schema_version:1;dataset_id:string;dataset_kind:'synthetic'|'human-labeled';
  metadata:{labelset_revision:string;annotator_ids:string[];labeling_method:'synthetic'|'human-declared'};
  config:{k:number;scan_limit:number;predeclared:true};sources:OfflineSource[];
  pairs:Array<{left_id:string;right_id:string;label:RelationKind|null}>;
}
export class OfflineEvaluationError extends Error {
  constructor(readonly code:string){super(code);this.name='OfflineEvaluationError';}
}
function fail(code='INVALID_DATASET'):never{throw new OfflineEvaluationError(code);}
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();return value as Record<string,unknown>;
}
function keys(row:Record<string,unknown>,required:string[],optional:string[]=[]){
  if(required.some(key=>!Object.hasOwn(row,key))||Object.keys(row).some(key=>!required.includes(key)&&!optional.includes(key)))fail('INVALID_FIELDS');
}
function text(value:unknown,max:number,nullable=false):string|null{
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||value.length>max||(!nullable&&!value.trim()))return fail();return value;
}
function shortId(value:unknown):string{
  if(typeof value!=='string'||!value.match(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/))return fail('INVALID_IDENTIFIER');return value;
}
function uuid(value:unknown):string{
  if(typeof value!=='string'||!value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))return fail('INVALID_SOURCE_ID');return value.toLowerCase();
}
function integer(value:unknown,max:number):number{if(!Number.isInteger(value)||Number(value)<1||Number(value)>max)return fail('INVALID_CONFIGURATION');return Number(value);}
function source(value:unknown):OfflineSource{
  const row=object(value);keys(row,['id','project_id','job_id','split','asset_group','family_group','revision','digest','title','location','summary','profile','category'],['identity_declarations','authoritative_identity_mappings']);
  if(typeof row.split!=='string'||!['tuning','holdout'].includes(row.split))fail('INVALID_SPLIT');
  const revision=row.revision===null?null:shortId(row.revision);
  if(row.digest!==null&&(typeof row.digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(row.digest)))fail('INVALID_SOURCE_DIGEST');
  if(revision===null&&row.digest===null)fail('SOURCE_REVISION_REQUIRED');
  const title=text(row.title,16000)!,location=text(row.location,16000,true),summary=text(row.summary,16000,true);
  if(title.length+(location?.length??0)+(summary?.length??0)>16000)fail('SOURCE_TEXT_BUDGET_EXCEEDED');
  let identity:OfflineSource['identity_declarations'];
  if(row.identity_declarations!==undefined){
    const supplied=object(row.identity_declarations);keys(supplied,[],[...IDENTITY_FIELDS]);identity={};
    for(const field of IDENTITY_FIELDS)if(Object.hasOwn(supplied,field))identity[field]=text(supplied[field],256,true);
  }
  let authoritative:OfflineAuthoritativeIdentityMapping[]|undefined;
  if(row.authoritative_identity_mappings!==undefined){
    if(!Array.isArray(row.authoritative_identity_mappings)||row.authoritative_identity_mappings.length>PLATFORM_IDENTITY_FIELDS.length)fail('INVALID_IDENTITY_MAPPINGS');
    const seen=new Set<string>();
    authoritative=row.authoritative_identity_mappings.map(value=>{
      const mapping=object(value);keys(mapping,['field','identity_digest','authority_version','source_revision','source_digest','freshness_until']);
      if(typeof mapping.field!=='string'||!PLATFORM_IDENTITY_FIELDS.includes(mapping.field as PlatformIdentityField)||seen.has(mapping.field))fail('INVALID_IDENTITY_MAPPINGS');
      seen.add(mapping.field);
      if(typeof mapping.identity_digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(mapping.identity_digest)
        ||typeof mapping.source_digest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(mapping.source_digest))fail('INVALID_IDENTITY_MAPPINGS');
      if(typeof mapping.authority_version!=='string'||!mapping.authority_version.trim()||mapping.authority_version.length>128
        ||typeof mapping.source_revision!=='string'||!mapping.source_revision.trim()||mapping.source_revision.length>256)fail('INVALID_IDENTITY_MAPPINGS');
      const authority_version=mapping.authority_version.trim(),source_revision=mapping.source_revision.trim();
      if(typeof mapping.freshness_until!=='string'||!Number.isFinite(new Date(mapping.freshness_until).getTime()))fail('INVALID_IDENTITY_MAPPINGS');
      return {field:mapping.field as PlatformIdentityField,identity_digest:mapping.identity_digest,
        authority_version,source_revision,source_digest:mapping.source_digest,freshness_until:new Date(mapping.freshness_until).toISOString()};
    });
  }
  return {id:uuid(row.id),project_id:uuid(row.project_id),job_id:uuid(row.job_id),split:row.split as OfflineSource['split'],
    asset_group:shortId(row.asset_group),family_group:shortId(row.family_group),revision,digest:row.digest as string|null,
    title,location,summary,profile:text(row.profile,128)!,category:text(row.category,128,true),...(identity?{identity_declarations:identity}:{}),
    ...(authoritative?{authoritative_identity_mappings:authoritative}: {})};
}

/** Declaration-level isolation validation; group truth and annotation independence are not certified. */
export function parseOfflineDataset(input:string):OfflineDataset{
  if(Buffer.byteLength(input,'utf8')>OFFLINE_INPUT_BYTES)fail('INPUT_BUDGET_EXCEEDED');
  let parsed:unknown;try{parsed=JSON.parse(input);}catch{fail('INVALID_JSON');}
  const row=object(parsed);keys(row,['schema_version','dataset_id','dataset_kind','metadata','config','sources','pairs']);
  if(row.schema_version!==1||typeof row.dataset_kind!=='string'||!['synthetic','human-labeled'].includes(row.dataset_kind))fail('INVALID_DATASET_KIND');
  const metadata=object(row.metadata);keys(metadata,['labelset_revision','annotator_ids','labeling_method']);
  const human=row.dataset_kind==='human-labeled';
  if(metadata.labeling_method!==(human?'human-declared':'synthetic'))fail('LABEL_PROVENANCE_MISMATCH');
  if(!Array.isArray(metadata.annotator_ids)||metadata.annotator_ids.length>32||(human&&!metadata.annotator_ids.length))fail('INVALID_ANNOTATORS');
  const annotators=metadata.annotator_ids.map(shortId).sort();if(new Set(annotators).size!==annotators.length)fail('DUPLICATE_ANNOTATOR');
  const config=object(row.config);keys(config,['k','scan_limit','predeclared']);if(config.predeclared!==true)fail('PREDECLARED_CONFIGURATION_REQUIRED');
  if(!Array.isArray(row.sources)||row.sources.length<1||row.sources.length>1000||!Array.isArray(row.pairs)||row.pairs.length>10000)fail('DATASET_COUNT_BUDGET_EXCEEDED');
  const sources=row.sources.map(source).sort((a,b)=>a.id.localeCompare(b.id));
  const byId=new Map<string,OfflineSource>(),assets=new Map<string,string>(),families=new Map<string,string>(),jobs=new Map<string,string>();
  for(const item of sources){
    if(byId.has(item.id))fail('DUPLICATE_SOURCE');byId.set(item.id,item);
    if(jobs.has(item.job_id)&&jobs.get(item.job_id)!==item.project_id)fail('JOB_PROJECT_CONFLICT');jobs.set(item.job_id,item.project_id);
    for(const [groups,id] of [[assets,item.asset_group],[families,item.family_group]] as const){
      if(groups.has(id)&&groups.get(id)!==item.split)fail('SPLIT_GROUP_LEAKAGE');groups.set(id,item.split);
    }
  }
  const seen=new Map<string,RelationKind|null>();
  const pairs=row.pairs.map(value=>{
    const pair=object(value);keys(pair,['left_id','right_id','label']);
    if(pair.label!==null&&!RELATION_LABELS.includes(pair.label as RelationKind))fail('INVALID_RELATION_LABEL');
    const [left,right]=[uuid(pair.left_id),uuid(pair.right_id)].sort();if(left===right)fail('SELF_PAIR');
    const a=byId.get(left),b=byId.get(right);if(!a||!b)fail('PAIR_SOURCE_MISSING');
    if(a.split!==b.split)fail('CROSS_SPLIT_PAIR');if(a.project_id!==b.project_id)fail('CROSS_PROJECT_PAIR');if(a.job_id===b.job_id)fail('SAME_JOB_PAIR');
    const key=`${left}|${right}`;if(seen.has(key))fail(seen.get(key)===pair.label?'DUPLICATE_PAIR':'CONTRADICTORY_PAIR');
    seen.set(key,pair.label as RelationKind|null);return {left_id:left,right_id:right,label:pair.label as RelationKind|null};
  }).sort((a,b)=>a.left_id.localeCompare(b.left_id)||a.right_id.localeCompare(b.right_id));
  return {schema_version:1,dataset_id:shortId(row.dataset_id),dataset_kind:row.dataset_kind as OfflineDataset['dataset_kind'],
    metadata:{labelset_revision:shortId(metadata.labelset_revision),annotator_ids:annotators,labeling_method:human?'human-declared':'synthetic'},
    config:{k:integer(config.k,50),scan_limit:integer(config.scan_limit,128),predeclared:true},sources,pairs};
}
