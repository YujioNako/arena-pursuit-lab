import {makePolicy,simulate,fitness,rng,normal,COUNT,clamp} from './engine.js';

export const TRAINER_VERSION=2;
export const DEFAULTS={sigma:.02,population:4,scenarios:16};
export const average=(xs,key)=>xs.reduce((sum,x)=>sum+x[key],0)/xs.length;
export function seedsFor(seed,namespace,n){const r=rng((seed^namespace)>>>0);return Array.from({length:n},()=>Math.floor(r()*4294967296));}
export function createTrainer(seed,bull,runner){return {version:2,seed,updates:0,accepted:0,anchors:{bull:makePolicy(seed,'bull'),runner:makePolicy(seed+1,'runner')},history:{bull:[[...bull]],runner:[[...runner]]}};}
export function validTrainer(t){const policy=w=>Array.isArray(w)&&w.length===COUNT&&w.every(x=>Number.isFinite(x)&&Math.abs(x)<1e6);return t?.version===2&&Number.isInteger(t.seed)&&Number.isInteger(t.updates)&&Number.isInteger(t.accepted)&&['bull','runner'].every(role=>policy(t.anchors?.[role])&&Array.isArray(t.history?.[role])&&t.history[role].length>=1&&t.history[role].length<=6&&t.history[role].every(policy));}
export function normalizeConfig(c){return {...c,sigma:clamp(c.sigma||DEFAULTS.sigma,.005,.1),population:clamp(Math.floor(c.population||DEFAULTS.population),2,24),scenarios:clamp(Math.floor(c.scenarios||DEFAULTS.scenarios),8,64)};}

// Candidates share starts and opponents. The permanent imitation anchor and FIFO
// history prevent adaptation to just the latest opponent.
export function trainingPlan(t,bull,runner,c,generation,validation=false){
  const role=c.mode!=='neural'?'runner':generation%2?'bull':'runner',other=role==='bull'?'runner':'bull';
  const r=rng((c.seed+generation*100003+(validation?0x30000000:0))>>>0),history=t.history[other],current=other==='bull'?bull:runner;
  return Array.from({length:validation?Math.max(24,c.scenarios):c.scenarios},(_,i)=>{
    const seed=Math.floor(r()*4294967296);
    if(c.mode!=='neural')return {seed,mode:c.mode,fixedSpeed:c.fixedSpeed,opponent:current,label:'固定规则'};
    if(role==='runner'&&i%4===3)return {seed,mode:'pursuit',fixedSpeed:8,opponent:t.anchors.bull,label:'8 m/s 直接追逐'};
    const kind=i%3,opponent=kind===0?t.anchors[other]:kind===1?current:history[Math.floor(r()*history.length)];
    return {seed,mode:'neural',fixedSpeed:8,opponent,label:kind===0?'初始基准':kind===1?'当前对手':'历史对手'};
  });
}

// Guard sets select weights; disjoint report sets NEVER select weights.
export function benchmarkPlans(t,c,role,report=false){
  const seeds=seedsFor(t.seed,report?0x61000000:0x41000000,report?64:48),other=role==='bull'?'runner':'bull';
  const neural=seeds.map(seed=>({seed,mode:'neural',fixedSpeed:8,opponent:t.anchors[other],label:'初始网络'}));
  const direct=seeds.map(seed=>({seed,mode:c.mode==='neural'?'pursuit':c.mode,fixedSpeed:c.mode==='neural'?8:c.fixedSpeed,opponent:t.anchors.bull,label:'固定规则'}));
  return role==='bull'?[neural]:c.mode==='neural'?[neural,direct]:[direct];
}
export function evaluatePolicy(weights,role,plan,emit){
  const buckets=new Map();
  const results=plan.map(p=>{
    const b=role==='bull'?weights:p.opponent,m=role==='runner'?weights:p.opponent,c={mode:p.mode,fixedSpeed:p.fixedSpeed};
    const e={seed:p.seed,...simulate(b,m,c,p.seed)};delete e.frames;
    let byMode=buckets.get(p.opponent);if(!byMode)buckets.set(p.opponent,byMode=new Map());
    const key=`${p.mode}/${p.fixedSpeed}`;let bucket=byMode.get(key);
    if(!bucket)byMode.set(key,bucket={bull:b,runner:m,config:c,label:p.label,episodes:[]});
    bucket.episodes.push(e);return e;
  });
  if(emit)for(const modes of buckets.values())for(const bucket of modes.values())emit(bucket);
  return {fitness:results.reduce((sum,e)=>sum+fitness(e,role),0)/results.length,wins:results.filter(e=>role==='bull'?e.caught:!e.caught).length,count:results.length};
}
export function passesGuard(candidate,current){return candidate.every((x,i)=>x.wins>=current[i].wins&&x.fitness>=current[i].fitness-0.25);}

// Rank utilities aggregate ALL mirrored perturbations, with tied ranks averaged.
// The bounded step cannot replace the policy with one lucky random candidate.
export function aggregateProposal(current,samples,step){
  const sorted=samples.map((s,index)=>({...s,index})).sort((a,b)=>a.fitness-b.fitness),utilities=new Array(samples.length);
  for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length&&sorted[j].fitness===sorted[i].fitness)j++;const u=((i+j-1)/2)/(sorted.length-1)-.5;for(let k=i;k<j;k++)utilities[sorted[k].index]=u;i=j;}
  const delta=current.map((_,j)=>samples.reduce((sum,s,i)=>sum+utilities[i]*s.sign*s.noise[j],0));
  const length=Math.hypot(...delta);return length<1e-12?[...current]:current.map((w,j)=>w+step*delta[j]/length);
}

export async function updateGeneration(t,bull,runner,rawConfig,generation,hooks={}){
  const c=normalizeConfig(rawConfig),role=c.mode!=='neural'?'runner':generation%2?'bull':'runner',current=role==='bull'?bull:runner;
  const plan=trainingPlan(t,bull,runner,c,generation),r=rng((c.seed+generation*700001)>>>0);
  const evaluate=(w,p,label)=>evaluatePolicy(w,role,p,b=>hooks.record?.(b,label));
  const base=evaluate(current,plan,'混合对手 / 基线'),samples=[],sigma=c.sigma/Math.sqrt(1+t.updates/500);
  for(let pair=0;pair<c.population;pair++){
    const noise=Array.from({length:COUNT},()=>normal(r));
    for(const sign of [1,-1]){
      if(hooks.stopped?.())return {bull,runner,role,accepted:false,cancelled:true};
      const weights=current.map((w,i)=>w+sign*sigma*noise[i]);
      samples.push({noise,sign,fitness:evaluate(weights,plan,`扰动 ${pair+1}${sign>0?'+':'−'}`).fitness});
      hooks.progress?.(samples.length,c.population*2);await hooks.yield?.();
    }
  }
  const proposal=aggregateProposal(current,samples,Math.min(.18,sigma*Math.sqrt(COUNT)*.5));
  let accepted=false,reason='训练收益不足';
  if(evaluate(proposal,plan,'聚合更新').fitness>base.fitness+1e-6&&!hooks.stopped?.()){
    const fresh=trainingPlan(t,bull,runner,c,generation,true),before=evaluate(current,fresh,'新场景验证 / 基线'),after=evaluate(proposal,fresh,'新场景验证 / 候选');
    reason='新场景未改善';
    if(after.fitness>before.fitness&&after.wins>=before.wins){
      const guards=benchmarkPlans(t,c,role),old=guards.map(p=>evaluate(current,p,'防退步验证 / 基线')),next=guards.map(p=>evaluate(proposal,p,'防退步验证 / 候选'));
      accepted=passesGuard(next,old);reason=accepted?'通过新场景与基准验证':'基准退步，保留原策略';
    }
  }
  if(hooks.stopped?.())return {bull,runner,role,accepted:false,cancelled:true};
  t.updates++;
  if(accepted){t.accepted++;if(role==='bull')bull=proposal;else runner=proposal;const pool=t.history[role];pool.push([...proposal]);if(pool.length>6)pool.splice(0,pool.length-6);}
  return {bull,runner,role,accepted,reason,sigma};
}

export function benchmark(t,bull,runner,c,emit){
  const neuralPlans=benchmarkPlans(t,{...c,mode:'neural'},'runner',true);
  const rulePlan=c.mode==='neural'?neuralPlans[1]:benchmarkPlans(t,c,'runner',true)[0];
  const bs=benchmarkPlans(t,c,'bull',true).map(p=>evaluatePolicy(bull,'bull',p,emit)),ms=[neuralPlans[0],rulePlan].map(p=>evaluatePolicy(runner,'runner',p,emit));
  return {bullBenchmark:100*bs[0].wins/bs[0].count,runnerBenchmark:100*ms[0].wins/ms[0].count,runnerRuleBenchmark:100*ms.at(-1).wins/ms.at(-1).count,benchmarkCount:64,benchmarkSeed:t.seed};
}
