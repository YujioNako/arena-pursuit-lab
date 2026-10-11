import {Worker} from 'node:worker_threads';
import assert from 'node:assert/strict';
import {simulate,makePolicy,fitness} from './dist/engine.js';
import {createTrainer,trainingPlan,benchmarkPlans,aggregateProposal,passesGuard,validTrainer,DEFAULTS} from './dist/trainer.js';
import {packExperiment,unpackExperiment} from './dist/experiment.js';
const url=new URL('./dist/worker.js',import.meta.url).href;
function client(){
  const worker=new Worker(`const{parentPort}=require('node:worker_threads');globalThis.postMessage=x=>parentPort.postMessage(x);globalThis.onmessage=null;import(${JSON.stringify(url)}).then(()=>parentPort.on('message',data=>onmessage({data})));`,{eval:true});
  const messages=[];let callback;
  worker.on('message',m=>{messages.push(m);callback?.(m);});
  const send=(message,predicate)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker timeout')),30000);callback=m=>{if(m.type==='error'){clearTimeout(timer);callback=null;reject(Error(m.message));}else if(predicate(m)){clearTimeout(timer);callback=null;resolve(m);}};worker.postMessage(message);});
  return {worker,messages,send};
}
const c=client(),restored=client(),config={...DEFAULTS,mode:'neural',fixedSpeed:8,generations:2,seed:42,population:2,scenarios:8};
try{
  const initial=await c.send({type:'init',seed:42},m=>m.type==='ready');assert.ok(validTrainer(initial.trainer));
  const plan=trainingPlan(initial.trainer,initial.bull,initial.runner,config,2);
  assert.ok(plan.some(p=>p.mode==='pursuit'));assert.ok(plan.some(p=>p.label==='历史对手'));
  assert.notDeepEqual(plan.map(p=>p.seed),trainingPlan(initial.trainer,initial.bull,initial.runner,config,4).map(p=>p.seed));
  const guardSeeds=new Set(benchmarkPlans(initial.trainer,config,'runner').flat().map(p=>p.seed));
  assert.ok(benchmarkPlans(initial.trainer,config,'runner',true).flat().every(p=>!guardSeeds.has(p.seed)));
  await c.send({type:'train',config},m=>m.type==='busy'&&!m.busy);
  const gens=c.messages.filter(m=>m.type==='generation');assert.deepEqual(gens.map(m=>m.role),['bull','runner']);
  const checkpoint=gens.at(-1);assert.equal(checkpoint.trainer.updates,2);
  const recorded=c.messages.filter(m=>m.type==='group');assert.ok(recorded.some(m=>m.item.candidate==='聚合更新'));
  // Mixed opponents/rules must retain the actual policies, so replay every group representative.
  for(const {item:g} of recorded){const e=g.episodes[0],r=simulate(g.bull,g.runner,g.config,e.seed);assert.equal(r.time,e.time);assert.equal(r.bull,e.bull);}
  const raw={format:'arena-lab-v1',policies:{bull:checkpoint.bull,runner:checkpoint.runner},trainer:checkpoint.trainer,groups:recorded.map(m=>m.item)};
  const packed=packExperiment(raw),decoded=unpackExperiment(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(decoded,raw);assert.equal(unpackExperiment(raw),raw);assert.ok(packed.weights.length<raw.groups.length*2);
  await restored.send({type:'load',...decoded.policies,trainer:decoded.trainer,generation:2,seed:42},m=>m.type==='ready');
  await c.send({type:'train',config:{...config,generations:2}},m=>m.type==='busy'&&!m.busy);
  await restored.send({type:'train',config:{...config,generations:2}},m=>m.type==='busy'&&!m.busy);
  const uninterrupted=c.messages.filter(m=>m.type==='generation').at(-1),resumed=restored.messages.filter(m=>m.type==='generation').at(-1);
  assert.deepEqual(resumed.bull,uninterrupted.bull);assert.deepEqual(resumed.runner,uninterrupted.runner);assert.deepEqual(resumed.trainer,uninterrupted.trainer);
  for(const mode of ['pursuit','straight']){
    const before=c.messages.filter(m=>m.type==='generation').at(-1).bull;
    await c.send({type:'train',config:{...config,mode,fixedSpeed:5,generations:1}},m=>m.type==='busy'&&!m.busy);
    const next=c.messages.filter(m=>m.type==='generation').at(-1);assert.equal(next.role,'runner');assert.deepEqual(next.bull,before);
  }
  const count=c.messages.filter(m=>m.type==='generation').length;
  const stopAtFirst=m=>{if(m.type==='progress')c.worker.postMessage({type:'stop'});};c.worker.on('message',stopAtFirst);
  await c.send({type:'train',config:{...config,generations:10}},m=>m.type==='busy'&&!m.busy);c.worker.off('message',stopAtFirst);
  assert.equal(c.messages.filter(m=>m.type==='generation').length,count,'cancelled generation must not mutate policies or generation');
  const legacy=await restored.send({type:'load',bull:initial.bull,runner:initial.runner,generation:500,seed:42},m=>m.type==='ready');assert.ok(validTrainer(legacy.trainer));assert.deepEqual(legacy.bull,initial.bull);
  console.log('PASS mixed opponents, fresh starts, report/selection separation, replay, compressed/legacy imports, exact resume, fixed modes, cancellation');
}finally{await c.worker.terminate();await restored.worker.terminate();}
assert.equal(passesGuard([{wins:3,fitness:100}],[{wins:4,fitness:90}]),false);
assert.equal(passesGuard([{wins:4,fitness:91}],[{wins:4,fitness:90}]),true);
const tied=[{noise:[1,2],sign:1,fitness:1},{noise:[1,2],sign:-1,fitness:1}];assert.deepEqual(aggregateProposal([0,0],tied,.1),[0,0]);
const proposed=aggregateProposal([0,0],[{noise:[1,2],sign:1,fitness:2},{noise:[1,2],sign:-1,fitness:1}],.1);assert.ok(Math.abs(Math.hypot(...proposed)-.1)<1e-12);
const e={caught:false,time:30,min:1,proximity:.2,wallB:0,wallM:0};assert.ok(fitness({...e,proximity:.8},'bull')>fitness(e,'bull'));assert.ok(fitness({...e,wallB:25},'bull')<fitness(e,'bull'));
console.log('PASS reject regression, aggregate ties/trust region, sustained-pursuit and wall shaping');
