import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { OFFLINE_INPUT_BYTES, OfflineEvaluationError, parseOfflineDataset } from './offline-evaluation-input.js';
import { evaluateOfflineDataset } from './offline-evaluation.js';

/** Reads only the explicitly supplied regular file. No config/.env, DB, network, or automatic writes. */
export async function runOfflineEvaluationCLI(args:readonly string[]){
  const argv=args[0]==='--'?args.slice(1):args;
  if(argv.length!==2||argv[0]!=='--input'||!argv[1])throw new OfflineEvaluationError('INVALID_ARGUMENTS');
  let content:string;
  try{
    const file=await open(argv[1],constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    try{
      const stat=await file.stat();
      if(!stat.isFile())throw new OfflineEvaluationError('REGULAR_INPUT_FILE_REQUIRED');
      if(stat.size>OFFLINE_INPUT_BYTES)throw new OfflineEvaluationError('INPUT_BUDGET_EXCEEDED');
      const buffer=Buffer.alloc(OFFLINE_INPUT_BYTES+1);let count=0;
      while(count<buffer.length){const read=await file.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
      if(count>OFFLINE_INPUT_BYTES)throw new OfflineEvaluationError('INPUT_BUDGET_EXCEEDED');
      try{content=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count));}
      catch{throw new OfflineEvaluationError('INVALID_UTF8');}
    }finally{await file.close();}
  }catch(error){
    if(error instanceof OfflineEvaluationError)throw error;
    throw new OfflineEvaluationError('INPUT_READ_FAILED');
  }
  return evaluateOfflineDataset(parseOfflineDataset(content));
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  runOfflineEvaluationCLI(process.argv.slice(2)).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{
    console.error(error instanceof OfflineEvaluationError?error.code:'OFFLINE_EVALUATION_FAILED');process.exitCode=1;
  });
}
