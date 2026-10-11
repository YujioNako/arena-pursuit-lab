import {makePolicy,simulate} from './engine.js';
import {createTrainer,validTrainer,normalizeConfig,updateGeneration,benchmark,average} from './trainer.js';
let bull,runner,trainer,busy=false,stop=false,gen=0,serial=0,session=1;
const yieldTask=()=>new Promise(r=>setTimeout(r,0));
function record(bucket,c,phase,generation,candidate){postMessage({type:'group',item:{id:++serial,session,generation,candidate,phase,config:{...c,...bucket.config},bull:[...bucket.bull],runner:[...bucket.runner],episodes:bucket.episodes}});}
function group(b,m,c,seeds,phase,generation,candidate){const episodes=seeds.map(seed=>{const {frames,...e}=simulate(b,m,c,seed);return {seed,...e};});record({bull:b,runner:m,config:c,episodes},c,phase,generation,candidate);return episodes;}
function ready(){postMessage({type:'ready',bull,runner,trainer});}
function report(c,generation){const metrics=benchmark(trainer,bull,runner,c,b=>record(b,c,'测试',generation,'固定基准 / 不参与选权'));postMessage({type:'benchmark',generation,metrics});return metrics;}
async function train(raw){busy=true;stop=false;postMessage({type:'busy',busy:true});const c=normalizeConfig(raw);try{
  report(c,gen);await yieldTask();
  for(let k=0;k<c.generations&&!stop;k++){
    const generation=gen+1;
    const result=await updateGeneration(trainer,bull,runner,c,generation,{record:(b,label)=>record(b,c,'训练',generation,label),progress:(candidate,total)=>postMessage({type:'progress',generation,role:c.mode!=='neural'?'runner':generation%2?'bull':'runner',candidate,total}),stopped:()=>stop,yield:yieldTask});
    if(result.cancelled)break;
    gen=generation;bull=result.bull;runner=result.runner;
    const results=group(bull,runner,c,Array.from({length:8},(_,i)=>(c.seed+0x70000000+i*7919)>>>0),'测试',gen,'当前双方 / 固定场景');
    const metrics={generation:gen,bull:average(results,'bull'),runner:average(results,'runner'),win:results.filter(x=>x.caught).length/8,time:average(results,'time'),mode:c.mode,accepted:result.accepted,reason:result.reason,trainerVersion:2};
    if(gen%10===0||k===c.generations-1)Object.assign(metrics,report(c,gen));
    postMessage({type:'generation',generation:gen,role:result.role,bull,runner,trainer,metrics});await yieldTask();
  }
}catch(e){postMessage({type:'error',message:e.message});}finally{busy=false;postMessage({type:'busy',busy:false});}}
onmessage=async({data:d})=>{
  if(d.type==='stop'){stop=true;return;}if(busy)return;
  if(d.type==='init'||d.type==='reset'){if(d.type==='reset'){session++;gen=0;}bull=makePolicy(d.seed,'bull',d.warm!==false);runner=makePolicy(d.seed+1,'runner',d.warm!==false);trainer=createTrainer(d.seed,bull,runner);ready();}
  if(d.type==='train')train(d.config);
  if(d.type==='load'){bull=d.bull;runner=d.runner;gen=d.generation||0;session++;trainer=validTrainer(d.trainer)?d.trainer:createTrainer(d.seed??42,bull,runner);ready();}
  if(d.type==='evaluate'){busy=true;postMessage({type:'busy',busy:true});try{report(d.config,gen);const results=group(bull,runner,d.config,Array.from({length:8},(_,i)=>(d.config.seed+0x50000000+d.run*1009+i*7919)>>>0),'测试',gen,'额外随机测试');postMessage({type:'evaluated',bull:average(results,'bull'),runner:average(results,'runner'),win:results.filter(x=>x.caught).length/8});}finally{busy=false;postMessage({type:'busy',busy:false});}}
  if(d.type==='duel')group(bull,runner,d.config,[d.seed],'演示',gen,'当前策略');
};
