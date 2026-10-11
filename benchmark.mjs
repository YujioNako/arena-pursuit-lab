import {Worker} from 'node:worker_threads';
import {writeFileSync} from 'node:fs';
import {simulate} from './dist/engine.js';
import {DEFAULTS} from './dist/trainer.js';
const seed=Number(process.argv[2]||42),generations=Number(process.argv[3]||500),output=process.argv[4];
const config={...DEFAULTS,seed,generations,mode:'neural',fixedSpeed:8};
const url=new URL('./dist/worker.js',import.meta.url).href;
const worker=new Worker(`const {parentPort}=require('node:worker_threads');globalThis.postMessage=x=>parentPort.postMessage(x);globalThis.onmessage=null;import(${JSON.stringify(url)}).then(()=>parentPort.on('message',data=>onmessage({data})));`,{eval:true});
let start=Date.now(),initial,final,accepted=0,episodes=0,benchmarkMetrics=[];
await new Promise((resolve,reject)=>{
  worker.on('error',reject);worker.on('message',d=>{
    if(d.type==='ready'){initial={bull:d.bull,runner:d.runner};worker.postMessage({type:'train',config});}
    if(d.type==='group')episodes+=d.item.episodes.length;
    if(d.type==='benchmark')benchmarkMetrics.push({generation:d.generation,...d.metrics});
    if(d.type==='generation'){final=d;if(d.metrics.accepted)accepted++;if(d.generation%25===0)console.log(JSON.stringify({generation:d.generation,accepted,seconds:(Date.now()-start)/1000,metrics:d.metrics}));}
    if(d.type==='error')reject(Error(d.message));
    if(d.type==='busy'&&!d.busy)resolve();
  });worker.postMessage({type:'init',seed});
});await worker.terminate();
const seeds=Array.from({length:200},(_,i)=>(0x12340000+i*104729)>>>0);
function evaluate(b,m,mode='neural'){
  const es=seeds.map(s=>simulate(b,m,{...config,mode},s)),mean=key=>es.reduce((sum,e)=>sum+e[key],0)/es.length;
  return {captureRate:es.filter(e=>e.caught).length/es.length,bull:mean('bull'),runner:mean('runner'),time:mean('time'),bullWall:mean('wallB'),runnerWall:mean('wallM')};
}
const summaries=[initial,final].map((p,i)=>({generation:i?generations:0,selfPlay:evaluate(p.bull,p.runner),bullVsInitialRunner:evaluate(p.bull,initial.runner),runnerVsInitialBull:evaluate(initial.bull,p.runner),runnerVsDirectPursuit:evaluate(initial.bull,p.runner,'pursuit')}));
const result={trainerVersion:2,config,episodes,accepted,seconds:(Date.now()-start)/1000,benchmarkSeeds:seeds,benchmarkMetrics,summaries,initial,final:{bull:final.bull,runner:final.runner,trainer:final.trainer}};
if(output)writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({phase:'done',seed,generations,accepted,summaries,seconds:result.seconds}));
