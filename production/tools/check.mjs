import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dirs=['src','tools','tests','runtime'];let count=0;
for(const dir of dirs)for(const name of fs.readdirSync(dir))if(/\.(?:mjs|js)$/.test(name)){execFileSync(process.execPath,['--check',path.join(dir,name)],{stdio:'pipe'});count++;}
// Validate that the parser channel can reject a known malformed program.
let rejected=false;try{execFileSync(process.execPath,['--check','--input-type=module'],{input:'const broken = (;',stdio:'pipe'});}catch{rejected=true;}
if(!rejected)throw Error('Syntax checking channel failed its negative control');
console.log(`${count} JavaScript files parsed; negative control rejected.`);
