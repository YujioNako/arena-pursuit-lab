import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
// Full learning runs are deliberately separate from the quick physics/worker suite.
// CI runs them before deployment. An optional report path checks an already run experiment.
const paths=process.argv.slice(2);
if(!paths.length){
  const directory=mkdtempSync(path.join(tmpdir(),'arena-learning-'));
  for(const seed of [42,43]){const output=path.join(directory,`${seed}.json`);execFileSync(process.execPath,['benchmark.mjs',String(seed),'500',output],{cwd:new URL('.',import.meta.url),stdio:'inherit',timeout:600000});paths.push(output);}
}
for(const file of paths){
  const r=JSON.parse(readFileSync(file,'utf8')),before=r.summaries[0],after=r.summaries.at(-1);
  assert.equal(r.trainerVersion,2);assert.equal(r.config.generations,500);assert.equal(r.benchmarkSeeds.length,200);assert.ok(r.accepted>0,'learning must not freeze all weights');
  assert.ok(after.bullVsInitialRunner.captureRate>=before.bullVsInitialRunner.captureRate+.05,'bull must gain at least 5 percentage points against fixed initial runner');
  assert.ok(after.runnerVsInitialBull.captureRate<=before.runnerVsInitialBull.captureRate+.05,'runner must retain initial-bull survival within 5 points');
  assert.ok(after.runnerVsDirectPursuit.captureRate<=before.runnerVsDirectPursuit.captureRate+.05,'runner must retain direct-pursuit survival within 5 points');
  assert.ok(after.selfPlay.bullWall<1&&after.selfPlay.runnerWall<1,'reject wall-stalling collapse');
  console.log(`PASS seed ${r.config.seed}: 500 generations, ${r.accepted} accepted updates, 200 fresh starts; improvement and retention gates passed`);
}
