import type { LLMExecutionResult } from '../services/llmAdapter.js';
import type { BenchmarkCaseDefinition, BenchmarkCaseScore } from './types.js';

export interface BenchmarkScoreInput {
  definition:BenchmarkCaseDefinition;
  result:LLMExecutionResult;
  providerReal:boolean;
  finalFiles?:Record<string,string>;
  changedPaths?:string[];
  apply?:{
    success?:boolean;
    validation?:{status?:string};
    browserQuality?:{status?:string};
  }|null;
}

function lower(value:unknown){return String(value??'').toLowerCase();}
function normalizedPaths(paths:string[]=[]){return [...new Set(paths.map(path=>String(path).replace(/\\/g,'/').replace(/^\.\//,'')).filter(Boolean))];}

export function scoreBenchmarkCase(input:BenchmarkScoreInput):BenchmarkCaseScore{
  const {definition,result,providerReal}=input;
  const checks:Array<{key:string;passed:boolean;weight:number;detail?:string}>=[];
  const add=(key:string,passed:boolean,weight:number,detail?:string)=>checks.push({key,passed,weight,detail});

  add('real_provider',providerReal,20,providerReal?'real model invocation recorded':'no real provider invocation');
  add('no_provider_error',!result.hasErrors&&!result.invalidResponse&&!result.isDemonstrativeFallback,10,result.errorReason||result.errorMessage);

  if(definition.mode==='plan'){
    const plan=result.plan;
    add('structured_plan',Boolean(plan),15);
    if(plan){
      const minReq=definition.checks.minRequirements??1;
      const minTasks=definition.checks.minTasks??1;
      const minCriteria=definition.checks.minAcceptanceCriteria??1;
      add('requirements',plan.requirements.length>=minReq,10,`${plan.requirements.length}/${minReq}`);
      add('task_graph',plan.task_graph.length>=minTasks,10,`${plan.task_graph.length}/${minTasks}`);
      add('acceptance_criteria',plan.acceptance_criteria.length>=minCriteria,10,`${plan.acceptance_criteria.length}/${minCriteria}`);
      const reqIds=new Set(plan.requirements.map(req=>req.id));
      const referencesValid=plan.task_graph.every(task=>task.requirement_ids.every(id=>reqIds.has(id)));
      add('task_requirement_links',referencesValid,10);
      const body=lower(JSON.stringify(plan));
      const terms=definition.checks.requiredPlanTerms||[];
      add('required_plan_terms',terms.every(term=>body.includes(lower(term))),15,terms.join(', '));
    }else{
      add('requirements',false,10);
      add('task_graph',false,10);
      add('acceptance_criteria',false,10);
      add('task_requirement_links',false,10);
      add('required_plan_terms',false,15);
    }
  }else if(definition.mode==='review'){
    const reply=lower(result.replyText);
    const terms=definition.checks.replyIncludes||[];
    const anyGroups=definition.checks.replyIncludesAny||[];
    add('review_evidence',terms.every(term=>reply.includes(lower(term))),anyGroups.length?50:70,terms.join(', '));
    if(anyGroups.length){
      const semanticsPassed=anyGroups.every(group=>group.some(term=>reply.includes(lower(term))));
      add('review_semantics',semanticsPassed,20,anyGroups.map(group=>group.join(' | ')).join(' ; '));
    }
  }else{
    const files=input.finalFiles||{};
    const changed=normalizedPaths(input.changedPaths||result.proposal?.files?.map(file=>file.path)||result.build?.files?.map(file=>file.path)||[]);
    add('structured_build',Boolean(result.proposal?.files?.length||result.build?.files?.length),10);

    const required=normalizedPaths(definition.checks.requiredPaths||[]);
    add('required_paths_touched',required.every(path=>changed.includes(path)),10,changed.join(', '));

    const allowed=normalizedPaths(definition.checks.allowedChangedPaths||[]);
    add('scope_precision',!allowed.length||changed.every(path=>allowed.includes(path)),10,changed.join(', '));

    const forbidden=normalizedPaths(definition.checks.forbiddenChangedPaths||[]);
    add('forbidden_paths_untouched',forbidden.every(path=>!changed.includes(path)),10);

    const contentChecks=definition.checks.content||[];
    const contentPassed=contentChecks.every(check=>{
      const content=String(files[check.path]??'');
      return (check.includes||[]).every(token=>content.includes(token))
        && (check.excludes||[]).every(token=>!content.includes(token));
    });
    add('content_assertions',contentPassed,15,contentChecks.map(item=>item.path).join(', '));

    const applyRequired=definition.checks.requireApplySuccess===true;
    add('apply_success',!applyRequired||input.apply?.success===true,5,String(input.apply?.success));

    const validatorRequired=definition.checks.requireValidatorPass===true;
    add('validator_gate',!validatorRequired||input.apply?.validation?.status==='passed',5,String(input.apply?.validation?.status||'n/a'));

    const browserRequired=definition.checks.requireBrowserPass===true;
    const browserStatus=input.apply?.browserQuality?.status;
    add('browser_gate',!browserRequired||browserStatus==='passed',5,String(browserStatus||'n/a'));
  }

  const totalWeight=checks.reduce((sum,item)=>sum+item.weight,0)||1;
  const earned=checks.reduce((sum,item)=>sum+(item.passed?item.weight:0),0);
  const score=Math.round((earned/totalWeight)*100);

  const mandatoryProvider=providerReal&&!result.hasErrors&&!result.invalidResponse&&!result.isDemonstrativeFallback;
  const mandatoryApply=definition.checks.requireApplySuccess!==true||input.apply?.success===true;
  const mandatoryValidator=definition.checks.requireValidatorPass!==true||input.apply?.validation?.status==='passed';
  const mandatoryBrowser=definition.checks.requireBrowserPass!==true||input.apply?.browserQuality?.status==='passed';
  const mandatoryReview=definition.mode!=='review'||checks.filter(item=>item.key.startsWith('review_')).every(item=>item.passed);

  return {score,passed:mandatoryProvider&&mandatoryApply&&mandatoryValidator&&mandatoryBrowser&&mandatoryReview&&score>=80,checks};
}
