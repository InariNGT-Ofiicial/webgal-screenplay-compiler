// Reproducible geometric PNGs and synthesized tones, using only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
const root = path.resolve(process.argv[2] ?? 'build/demo-assets');
fs.mkdirSync(root, { recursive:true });
const table = Array.from({length:256}, (_,n) => { for(let i=0;i<8;i++) n=(n&1)?0xedb88320^(n>>>1):n>>>1; return n>>>0; });
const crc = b => { let n=0xffffffff; for(const v of b) n=table[(n^v)&255]^(n>>>8); return (n^0xffffffff)>>>0; };
function chunk(type,data) { const t=Buffer.from(type), out=Buffer.alloc(data.length+12); out.writeUInt32BE(data.length); t.copy(out,4); data.copy(out,8); out.writeUInt32BE(crc(Buffer.concat([t,data])),data.length+8); return out; }
function png(width,height,pixel) {
  const raw=Buffer.alloc(height*(width*4+1));
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) { const rgba=pixel(x,y); for(let c=0;c<4;c++)raw[y*(width*4+1)+1+x*4+c]=rgba[c]; }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function write(file,data) { const target=path.join(root,file); fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data); }
for(const [name,color] of [['title',[18,35,51]],['station',[40,67,82]],['corridor',[27,43,53]],['black',[0,0,0]]]) write('background/'+name+'.png',png(1280,720,(x,y)=>[...color.map(c=>Math.min(255,c+(name==='black'?0:Math.round(y/60)))),255]));
write('cg/window.png',png(1280,720,(x,y)=>x>480&&x<800&&y>140&&y<580?[143,196,194,255]:[35,60,80,255]));
for(const [name,color] of [['guide',[98,158,157]],['visitor',[175,121,146]]]) write('figure/'+name+'.png',png(700,1400,(x,y)=>{ if(((x-350)/110)**2+((y-180)/150)**2<1)return[228,204,169,255];if(y>310&&y<1380&&x>200&&x<500)return[...color,255];return[0,0,0,0]; }));
function wav(seconds,frequency) { const rate=16000,samples=Math.floor(rate*seconds),b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(36+samples*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++){const envelope=Math.min(1,i/(rate*.08),(samples-i)/(rate*.08));b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*frequency/rate)*2000*envelope),44+i*2);}return b; }
write('bgm/calm.wav',wav(3,220));write('bgm/pulse.wav',wav(2,330));write('effect/signal.wav',wav(.25,660));
console.log('Generated 10 original demonstration assets.');
