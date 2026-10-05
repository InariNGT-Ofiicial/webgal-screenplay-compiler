import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const patterns=[
  ['credential',/\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b/g],
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['private-path',/(?:[A-Za-z]:[\\/](?:Users|WorkData|Program Files)[\\/]|\/home\/[^\s/]+\/|\/Users\/[^\s/]+\/)/gi],
  ['private-endpoint',/https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/g],
  ['credential-assignment',/(?:api[_-]?key|authorization|cookie)\s*[:=]\s*["'](?:Bearer\s+)?[A-Za-z0-9_+/.=-]{24,}["']/gi]
];
export function auditIndex(root=process.cwd(),denylist=[]) {
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
  if(path.resolve(git('rev-parse','--show-toplevel').trim())!==path.resolve(root))throw Error('Initialize a dedicated repository here; refusing to audit the parent workspace');
  const entries=git('ls-files','--stage','-z').split('\0').filter(Boolean),findings=[];
  if(!entries.length)throw Error('Empty index. Stage the intended source before auditing.');
  for(const entry of entries){const [metadata,name]=entry.split('\t');if(metadata.startsWith('120000'))findings.push({file:name,category:'symlink'});
    if(/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|cookies.*\.json)$|\.(?:key|png|jpg|webp|wav|mp3|woff2|zip|docx)$/i.test(name))findings.push({file:name,category:'excluded-file'});
    const value=git('show',':'+name);
    for(const [category,pattern] of patterns){pattern.lastIndex=0;for(const match of value.matchAll(pattern))findings.push({file:name,line:value.slice(0,match.index).split('\n').length,category});}
    for(const word of denylist)if(value.includes(word))findings.push({file:name,category:'private-vocabulary'});
  }
  return {scope:'git-index',files:entries.length,pass:findings.length===0,findings};
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
  const denyFile=process.argv[2],denylist=denyFile?JSON.parse(fs.readFileSync(denyFile,'utf8')):[];
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const report=auditIndex(root,denylist);console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}
