// Intern equal weight vectors in memory and store them once in JSON/IndexedDB.
// All episode seeds/results remain available; v1 files need no migration on disk.
export function weightInterner(){
  const buckets=new Map();
  return weights=>{let hash=2166136261;for(const w of weights)hash=Math.imul(hash^Math.trunc(w*1e9),16777619);let bucket=buckets.get(hash);if(!bucket)buckets.set(hash,bucket=[]);const prior=bucket.find(p=>p.length===weights.length&&p.every((w,i)=>w===weights[i]));if(prior)return prior;bucket.push(weights);return weights;};
}
export function packExperiment(data){
  const intern=weightInterner(),weights=[],ids=new Map();
  const index=w=>{const p=intern(w);if(!ids.has(p)){ids.set(p,weights.length);weights.push(p);}return ids.get(p);};
  const groups=data.groups.map(g=>({...g,bull:index(g.bull),runner:index(g.runner)}));
  return {...data,format:'arena-lab-v2',weights,groups};
}
export function unpackExperiment(data){
  if(data.format!=='arena-lab-v2')return data;
  if(!Array.isArray(data.weights)||!Array.isArray(data.groups))throw Error('压缩实验格式错误');
  const groups=data.groups.map(g=>{if(!Number.isInteger(g.bull)||!Number.isInteger(g.runner)||!data.weights[g.bull]||!data.weights[g.runner])throw Error('策略索引无效');return {...g,bull:data.weights[g.bull],runner:data.weights[g.runner]};});
  const {weights,...rest}=data;return {...rest,format:'arena-lab-v1',groups};
}
