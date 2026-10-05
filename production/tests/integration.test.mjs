import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importNativeGame } from '../src/native-import.mjs';
import { createHost } from '../src/host.mjs';
import { escapeText, narrative } from '../src/script.mjs';
import { inventory } from '../tools/verify-game.mjs';
import { BRANCH_POINTS } from '../../compiler/branches.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webgal-integration-'));
const cleanup = dir => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive:true, force:true }); };
function write(base, name, text) { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, text); }
function gameIn(dir) {
  const game = path.join(dir, 'source/game');
  write(game, 'config.txt', 'Game_name:Native demo;\nGame_key:native-demo-v1;\nTitle_img:title.png;\nTitle_bgm:calm.wav;\n');
  write(game, 'scene/start.txt', 'changeScene:mainline.txt;\n');
  write(game, 'scene/mainline.txt', 'changeBg:room.png;\n:抵达。;\nchoose:继续:ok|返回:ending.txt;\nlabel:ok;\nsay:信号已经收到。 -speaker=向导;\nend;\n');
  write(game, 'scene/ending.txt', ':返回走廊。;\nend;\n');
  write(game, 'scene/unused.txt', 'jumpLabel:not_used;');
  write(game, 'userStyleSheet.css', '.native-theme { color:green; }\n');
  write(game, 'template/template.json', '{"fonts":[]}');
  for (const file of ['background/title.png', 'background/room.png', 'bgm/calm.wav']) write(game, file, Buffer.from([0, 1, 255, 2]));
  return game;
}
test('native import preserves all source bytes, branches, configuration and theme', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build'); const report=importNativeGame({game,output});
    assert.deepEqual(inventory(path.join(output,'game')),inventory(game)); assert.equal(report.runtime,false); assert.equal(report.narrativeInvariant,true); assert.equal(report.narrativeLines,3); assert.equal(report.reachableScenes.length,3);
  } finally { cleanup(dir); }
});
test('explicit checkpoint insertion preserves native narrative and CSS while changing save namespace', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build'); const report=importNativeGame({game,output,gameKey:'native-demo-checkpoints-v2',checkpoints:[{scene:'mainline.txt',after:'say:信号已经收到。 -speaker=向导;',slot:1}]});
    const lines=fs.readFileSync(path.join(output,'game/scene/mainline.txt'),'utf8').split('\n');
    assert.deepEqual(lines.filter(narrative),fs.readFileSync(path.join(game,'scene/mainline.txt'),'utf8').split('\n').filter(narrative));
    assert.ok(lines.includes('choose:章节自动存档中:_production_checkpoint_1;')); assert.equal(report.runtime,true);
    assert.ok(fs.readFileSync(path.join(output,'game/userStyleSheet.css'),'utf8').startsWith('.native-theme')); assert.ok(fs.readFileSync(path.join(output,'game/config.txt'),'utf8').includes('Game_key:native-demo-checkpoints-v2;')); assert.equal(fs.existsSync(path.join(game,'release-runtime.js')),false);
  } finally { cleanup(dir); }
});
test('ambiguous or drifted checkpoint anchors stop before writing', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build'), point={scene:'mainline.txt',after:':不存在。;',slot:1};
    assert.throws(()=>importNativeGame({game,output,gameKey:'new-v2',checkpoints:[point]}),/exactly once/); assert.equal(fs.existsSync(output),false);
    write(game,'scene/mainline.txt',':抵达。;\n:抵达。;\nend;'); point.after=':抵达。;'; assert.throws(()=>importNativeGame({game,output,gameKey:'new-v2',checkpoints:[point]}),/exactly once/); assert.equal(fs.existsSync(output),false);
  } finally { cleanup(dir); }
});
test('checkpoints reject old save keys and conflicting slots', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build'), point={scene:'mainline.txt',after:':抵达。;',slot:1};
    assert.throws(()=>importNativeGame({game,output,checkpoints:[point]}),/distinct/);
    assert.throws(()=>importNativeGame({game,output,gameKey:'native-demo-v1',checkpoints:[point]}),/new key/);
    assert.throws(()=>importNativeGame({game,output,gameKey:'new-v2',checkpoints:[point,{scene:'ending.txt',after:':返回走廊。;',slot:1}]}),/unique/);
    assert.throws(()=>importNativeGame({game,output,gameKey:'new-v2',checkpoints:[{...point,after:'end;'}]}),/fall-through/);
    assert.equal(fs.existsSync(output),false);
  } finally { cleanup(dir); }
});
test('missing reachable assets and branch targets block native delivery', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build'); fs.rmSync(path.join(game,'background/room.png'));
    assert.throws(()=>importNativeGame({game,output}),/Missing native asset/); assert.equal(fs.existsSync(output),false);
    write(game,'background/room.png','placeholder'); write(game,'scene/ending.txt','jumpLabel:missing;');
    assert.throws(()=>importNativeGame({game,output}),/unresolved/); assert.equal(fs.existsSync(output),false);
  } finally { cleanup(dir); }
});
test('native import rebuild removes only stale owned files and rejects tainted inventory', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build'); importNativeGame({game,output}); write(output,'game/keep.txt','keep');
    fs.rmSync(path.join(game,'scene/unused.txt')); importNativeGame({game,output}); assert.equal(fs.existsSync(path.join(output,'game/scene/unused.txt')),false); assert.equal(fs.readFileSync(path.join(output,'game/keep.txt'),'utf8'),'keep');
    write(output,'owned-files.json','["../../outside.txt"]'); assert.throws(()=>importNativeGame({game,output}),/Unsafe owned/); assert.equal(fs.readFileSync(path.join(output,'game/keep.txt'),'utf8'),'keep');
  } finally { cleanup(dir); }
});
test('native import refuses output inside its source and unmanaged output', () => {
  const dir=fixture(); try { const game=gameIn(dir), output=path.join(dir,'build');
    assert.throws(()=>importNativeGame({game,output:path.join(game,'build')}),/separate/); write(output,'keep.txt','keep'); assert.throws(()=>importNativeGame({game,output}),/unmanaged/); assert.deepEqual(fs.readdirSync(output),['keep.txt']);
  } finally { cleanup(dir); }
});
test('HTTP host adds checkpoint runtime only when the installed game includes it', async () => {
  const dir=fixture(); let service; try { const game=gameIn(dir), dist=path.dirname(game); write(dist,'index.html','<head></head><body>native</body>'); service=createHost({dist,port:0}); const address=await service.start();
    const url=`http://127.0.0.1:${address.port}/`; assert.equal(await(await fetch(url)).text(),'<head></head><body>native</body>');
    write(game,'release-runtime.js','/* opt-in fixture */'); assert.ok((await(await fetch(url)).text()).includes('/game/release-runtime.js'));
  } finally { if(service)await service.close(); cleanup(dir); }
});
test('real compiler output imports and installs without re-escaping text or losing endings', () => {
  const dir=fixture(); try {
    fs.cpSync(path.join(root,'compiler'),path.join(dir,'compiler'),{recursive:true}); write(dir,'production/src/script.mjs',fs.readFileSync(path.join(root,'production/src/script.mjs')));
    const beats=[{t:'narrate',text:BRANCH_POINTS[0].anchor},{t:'say',who:'hero',text:'信号: A|B; {收到} \\ 完毕。'},{t:'narrate',text:'结束。'}];
    for(const [name,value] of Object.entries({'beats.json':beats,'beats-with-meta.json':beats.map(()=>({_scene:'序幕',_ch:1})),'story.json':{characters:[{id:'hero',name:'向导'},{id:'ally',name:'同伴'},{id:'mentor',name:'老师'}]}}))write(dir,'compiler/mainline/'+name,JSON.stringify(value));
    const cueFile=path.join(dir,'compiler/bgm-cues.mjs'); fs.writeFileSync(cueFile,fs.readFileSync(cueFile,'utf8').replace('export const SCENE_CUE = {',"export const SCENE_CUE = { '1|序幕':'opening',"));
    fs.mkdirSync(path.join(dir,'webgal-tool/dist/game/scene'),{recursive:true});
    execFileSync(process.execPath,[path.join(dir,'compiler/build-demo.mjs')],{cwd:dir,stdio:'pipe'});
    const game=path.join(dir,'webgal-tool/dist/game'), text=fs.readFileSync(path.join(game,'scene/mainline.txt'),'utf8'); assert.ok(text.includes('say:'+escapeText(beats[1].text))); assert.ok(text.includes('label:_END_1;')); assert.ok(text.includes('label:_END_2;'));
    // File-level integration fixture: resource bytes are opaque here; browser QA uses the generated demo.
    const names=new Set(['background/ph_title.png']);
    for(const match of text.matchAll(/^(changeBg|changeFigure|bgm|playEffect):([^;\n]*?)(?: -[^\n]*)?;/gm)) { const folder={changeBg:'background',changeFigure:'figure',bgm:'bgm',playEffect:'effect'}[match[1]]; if(match[2]&&match[2]!=='none')names.add(folder+'/'+match[2]); }
    const cfg=fs.readFileSync(path.join(game,'config.txt'),'utf8'); names.add('bgm/'+cfg.match(/Title_bgm:([^;]+);/)[1]); for(const name of names)write(game,name,Buffer.from([1,2,3]));
    const build=path.join(dir,'build'), report=importNativeGame({game,output:build}); assert.equal(report.narrativeInvariant,true); assert.deepEqual(inventory(path.join(build,'game')),inventory(game));
    const dist=path.join(dir,'installed'); write(dist,'index.html','<head></head>'); write(dist,'game/scene/start.txt',':original;');
    const install=path.join(root,'production/tools/install.mjs'); execFileSync(process.execPath,[install,build,dist],{stdio:'pipe'}); assert.equal(fs.readFileSync(path.join(dist,'game/scene/mainline.txt'),'utf8'),text); execFileSync(process.execPath,[install,build,dist,'--restore'],{stdio:'pipe'}); assert.equal(fs.readFileSync(path.join(dist,'game/scene/start.txt'),'utf8'),':original;');
  } finally { cleanup(dir); }
});
