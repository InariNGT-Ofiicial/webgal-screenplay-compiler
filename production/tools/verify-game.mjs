import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateScenes, references } from '../src/script.mjs';
export function inventory(root) {
  const rows=[];
  for(const item of fs.readdirSync(root,{withFileTypes:true})) {
    const file=path.join(root,item.name);
    if(item.isSymbolicLink())throw Error('Symbolic links are not allowed in release inventories');
    if(item.isDirectory()){if(item.name!=='.production-backup')for(const row of inventory(file))rows.push({...row,file:item.name+'/'+row.file});}
    else if(item.isFile())rows.push({file:item.name,size:fs.statSync(file).size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  }
  return rows.sort((a,b)=>a.file.localeCompare(b.file));
}
export function verifyGame(dist) {
  const game=path.join(dist,'game'), scenes=Object.fromEntries(fs.readdirSync(path.join(game,'scene')).filter(n=>n.endsWith('.txt')).map(n=>[n,fs.readFileSync(path.join(game,'scene',n),'utf8').split(/\r?\n/)]));
  const start='start.txt', reachable=new Set(), queue=[start];
  while(queue.length){const name=queue.shift();if(reachable.has(name))continue;if(!scenes[name])throw Error('Missing entry '+name);reachable.add(name);queue.push(...references(scenes[name]).scenes);}
  validateScenes(Object.fromEntries([...reachable].map(name=>[name,scenes[name]])));
  const files=inventory(dist);
  return {scenes:reachable.size,totalSceneFiles:Object.keys(scenes).length,reachableScenes:[...reachable],files:files.length,inventory:files};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=verifyGame(path.resolve(process.argv[2]??'webgal/dist'));
  const out=process.argv[3];if(out)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({scenes:report.scenes,reachableScenes:report.reachableScenes.length,files:report.files}));
}
