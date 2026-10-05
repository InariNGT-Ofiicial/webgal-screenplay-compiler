import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, verifyGame } from './verify-game.mjs';
const [distArg,outputArg,licenseArg]=process.argv.slice(2);
if(!distArg||!outputArg||!licenseArg)throw Error('Usage: node tools/package-game.mjs <dist> <new-output-directory> <upstream-license>');
const dist=path.resolve(distArg), output=path.resolve(outputArg), kit=fileURLToPath(new URL('..',import.meta.url));
if(fs.existsSync(output)||output===dist||output.startsWith(dist+path.sep))throw Error('Use a fresh output directory outside the source dist');
const source=verifyGame(dist);fs.statSync(licenseArg);
fs.mkdirSync(output,{recursive:true});
for(const row of source.inventory){const target=path.join(output,'webgal/dist',row.file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(dist,row.file),target);}
const mirror=inventory(path.join(output,'webgal/dist'));
if(JSON.stringify(mirror)!==JSON.stringify(source.inventory))throw Error('Release mirror differs from source');
for(const dir of ['src','tools','runtime'])fs.cpSync(path.join(kit,dir),path.join(output,dir),{recursive:true});
for(const file of ['launch.ps1','stop.ps1','launch.cmd','stop.cmd'])fs.copyFileSync(path.join(kit,file),path.join(output,file));
fs.mkdirSync(path.join(output,'licenses'));fs.copyFileSync(path.join(kit,'LICENSE'),path.join(output,'licenses/Production-Kit-MIT.txt'));fs.copyFileSync(licenseArg,path.join(output,'licenses/WebGAL-LICENSE.txt'));
fs.writeFileSync(path.join(output,'README.txt'),'Launch: node tools/serve.mjs webgal/dist\nWindows: launch.cmd / stop.cmd\nAssets retain their own licenses. Include their attribution before distribution.\n');
fs.writeFileSync(path.join(output,'dist-manifest.json'),JSON.stringify(source,null,2)+'\n');
console.log(`Verified ${mirror.length} mirrored files. Include licenses for your game assets before distribution.`);
