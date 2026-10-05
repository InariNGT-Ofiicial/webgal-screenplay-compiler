#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
compiler / fetch-sfx.py —— 把**下载来的真实音效**加工成 WebGAL 能放的 asset
===========================================================================
读 `sfx-sources.json`（出处/许可证/映射的唯一真源）+ `sfx-catalog.json`（资产契约），
产出 `webgal-tool/dist/game/effect/<id>.wav`。

★ 两条路产出**同一批文件名**（命名即契约）：
    · 这里产出的 —— 下载的真实录音（CC0），出处登记在 sfx-sources.json
    · make-sfx.py 产出的 —— 合成占位（未登记 = 免署名）
   谁最后跑谁覆盖谁；`verify-sfx.mjs` 会校验"用到的下载素材都登记了许可证"。

★ 为什么要有"加工"这一步（不能直接改名投放）：
   ① 采样率/声道/位深统一（素材是 44.1k 立体声 ogg，引擎里 SE 走单声道 WAV 更稳）；
   ② 音量统一到清单里定的峰值 —— 否则枪声比开门声大 20dB，玩家得不停音量；
   ③ **连发/散落/脚步必须在这里合成成单个文件**：WebGAL 的 `playEffect` 不带 id 时
      是**单声道通道**，连发两条会互相把对方掐掉（见 sfx-rules.mjs 文件头）。
   ④ 去掉素材开头的静音（Kenney 的 ogg 常有几毫秒预静音，直接放会显得"迟"）。

用法：
  python compiler/fetch-sfx.py              # 加工所有「源已就位」的条目
  python compiler/fetch-sfx.py --list       # 只看映射与就位情况
  python compiler/fetch-sfx.py --download   # 先按 packs 补齐缺失的压缩包（断点续传）
  python compiler/fetch-sfx.py --credits    # 只重新生成 CREDITS.md
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import zipfile

import numpy as np
from scipy import signal
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(HERE, 'sfx-catalog.json')
SOURCES = os.path.join(HERE, 'sfx-sources.json')


# ───────────────────────────────────────────────────────────────────────────
#  解码（PyAV：直接吃 ogg / mp3 / wav，不需要 ffmpeg.exe）
# ───────────────────────────────────────────────────────────────────────────

def decode(path, fs):
    """
    ★★ 必须用 `AudioResampler(format='fltp', layout='mono')` 强制转单声道，
       **不能**直接 `to_ndarray()` 再 `mean(axis=0)`。
       PyAV 对**封装格式（packed，如 wav/ogg 的 s16）**的立体声会返回形状 `(1, 样本×声道)`，
       `mean(axis=0)` 会把左右声道**逐对平均**：时长翻倍、内容错乱，而且**不报错**。
       实测症状：1.73s 的兽吼被解成 3.47s（正好 2.0 倍）——靠"产物比源长一倍"才发现。
       走 resampler 后形状固定是 `(1, N)`，与声道布局无关，稳。
    """
    import av
    with av.open(path) as c:
        st = next(s for s in c.streams if s.type == 'audio')
        rs = av.AudioResampler(format='fltp', layout='mono', rate=fs)
        chunks = []
        for fr in c.decode(st):
            for out in rs.resample(fr):
                chunks.append(out.to_ndarray().reshape(-1).astype(np.float64))
        for out in rs.resample(None):      # 冲干净重采样器内部的缓存
            chunks.append(out.to_ndarray().reshape(-1).astype(np.float64))
    return np.concatenate(chunks) if chunks else np.zeros(8)


def trim_lead(x, thresh=0.004):
    """去掉开头静音（Kenney 素材常有几毫秒预静音，直接放会显得迟）"""
    idx = np.argmax(np.abs(x) > thresh)
    if idx == 0 and abs(x[0]) <= thresh:
        return x
    return x[max(0, idx - 32):]         # 留一点点，别削掉瞬态前沿


def place(track, x, at, gain=1.0):
    a = int(at * FS)
    if a >= len(track):
        return
    b = min(len(track), a + len(x))
    track[a:b] += x[: b - a] * gain


FS = 44100


# ───────────────────────────────────────────────────────────────────────────
#  加工一条
# ───────────────────────────────────────────────────────────────────────────

def build(entry, cat_entry, src_root):
    parts = entry.get('parts', [])
    resolved = []
    for p in parts:
        pack = SOURCE_PACKS[entry['pack']]
        base = os.path.join(src_root, pack['extract']) if pack.get('extract') else src_root
        f = os.path.join(base, p['f'])
        if not os.path.exists(f):
            return None, f'缺源文件 {os.path.relpath(f, src_root)}'
        resolved.append((f, p))

    want = cat_entry['p'].get('len', 0)
    # 长度 = max(期望长度, 各片段最远端 + 其自身长度 + 100ms 尾巴)
    total = int(want * FS)
    audio = []
    for f, p in resolved:
        x = decode(f, FS)
        if p.get('pitch'):
            x = signal.resample_poly(x, int(round(FS * p['pitch'])), FS)
        if p.get('lp') or p.get('hp'):
            x = _filt(x, p.get('hp'), p.get('lp'))
        x = trim_lead(x)
        # ★ 实录常常比我们的档位长（例如 4.9s 的兽吼要塞进 1.6s 的低吼）⇒ 裁掉并淡出，
        #   否则会带着一段拖尾、还会让 verify 的"时长与清单不符"报警。
        if p.get('trunc') and len(x) > int(p['trunc'] * FS):
            n = int(p['trunc'] * FS)
            fade = min(int(0.12 * FS), n // 3)
            x = x[:n].copy()
            x[-fade:] *= np.linspace(1, 0, fade)
        audio.append((x, p))
        total = max(total, int((p.get('at', 0) * FS)) + len(x) + int(0.10 * FS))

    # ★ 循环拼接（环境床用）：Kenney 的 engine / spaceEngine / computerNoise 都是
    #   **精确 5.00s 的无缝循环**（实测接缝 seam≈1.0）⇒ 按整周期摆放即天然无缝。
    #   ① **绝不能加淡入淡出** —— 那会破坏无缝（不是"保险"，是破坏）；
    #   ② total 先对齐到整数个素材长度，否则尾部半截块会造成跳变。
    if any(p.get('loop') for _, p in audio):
        for x2, p2 in audio:
            if p2.get('loop') and len(x2) > 0:
                total = max(1, int(round(total / len(x2)))) * len(x2)

    track = np.zeros(total)
    for x, p in audio:
        if p.get('loop') and len(x) > 0:
            at = p.get('at', 0.0)
            while int(at * FS) < total:
                place(track, x, at, p.get('gain', 1.0))
                at += len(x) / FS
        else:
            place(track, x, p.get('at', 0), p.get('gain', 1.0))

    # ★ 去掉尾部静音：`total` 取的是"清单期望长度"与"实际内容长度"的较大者，
    #   若素材比档位短，尾部会留下一段空白 —— 播起来没影响，但会让文件虚长、
    #   也会让 verify 的"时长与清单不符"误报。留 60ms 尾音即可。
    tail = np.abs(track)
    alive = np.where(tail > 0.002)[0]
    if len(alive):
        track = track[: alive[-1] + int(0.06 * FS)]

    peak = cat_entry['p'].get('peak', 0.9)
    m = np.max(np.abs(track)) + 1e-12
    track = track / m * (peak if peak <= 1.0 else 0.9)
    return track, None


def _filt(x, hp, lp):
    if hp and lp:
        sos = signal.butter(4, [hp / (FS / 2), lp / (FS / 2)], btype='band', output='sos')
    elif lp:
        sos = signal.butter(4, lp / (FS / 2), btype='low', output='sos')
    else:
        sos = signal.butter(4, hp / (FS / 2), btype='high', output='sos')
    return signal.sosfilt(sos, x)


# ───────────────────────────────────────────────────────────────────────────
#  下载（断点续传 + 重试：沙箱会在大文件传输中途掐掉连接）
# ───────────────────────────────────────────────────────────────────────────

def download(url, dest, tries=12, chunk_timeout=100):
    for i in range(1, tries + 1):
        cmd = ['curl', '-sS', '-L', '-C', '-', '-m', str(chunk_timeout), '-o', dest, url]
        subprocess.run(cmd, capture_output=True)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            if not dest.endswith('.zip') or zipfile.is_zipfile(dest):
                return True, i
        time.sleep(0.5)
    return False, tries


# ═══════════════════════════════════════════════════════════════════════════

SRC = json.load(open(SOURCES, encoding='utf-8'))
CAT = json.load(open(CATALOG, encoding='utf-8'))
SOURCE_PACKS = SRC['packs']
BY_ID = {x['id']: x for x in CAT['oneShots'] + CAT['ambience']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='', help='逗号分隔的 id 白名单（只加工这些，其余保留原样）')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--download', action='store_true')
    ap.add_argument('--credits', action='store_true')
    args = ap.parse_args()

    src_root = os.path.join(ROOT, SRC['sourceCache'])
    out_dir = os.path.join(ROOT, 'webgal-tool', 'dist', CAT['format']['dir'])
    ext = CAT['format']['ext']

    if args.download:
        print('补下缺失的压缩包（断点续传 · 沙箱会掐大文件，所以循环续传）')
        for name, p in SOURCE_PACKS.items():
            if not p.get('zip'):
                continue
            dest = os.path.join(src_root, p['zip'])
            if os.path.exists(dest) and zipfile.is_zipfile(dest):
                print(f'  · {p["zip"]:32} 已完整 ({os.path.getsize(dest) / 1048576:.2f} MB)')
                continue
            okk, tries = download(p['url'], dest)
            sz = os.path.getsize(dest) / 1048576 if os.path.exists(dest) else 0
            print(f'  {"✓" if okk else "✗"} {p["zip"]:32} {sz:.2f} MB（{tries} 次续传）')
            if okk and p.get('extract'):
                with zipfile.ZipFile(dest) as z:
                    z.extractall(os.path.join(src_root, 'x', os.path.splitext(p['zip'])[0]))
        print()

    rows, missing, done = [], [], 0
    produced = {}
    only = {s.strip() for s in args.only.split(',') if s.strip()}
    for sid, entry in SRC['entries'].items():
        if sid.startswith('_'):          # `_note_*` 是给人看的说明，不是条目
            continue
        if only and sid not in only:     # --only：不碰未点名的条目
            continue
        cat_entry = BY_ID.get(sid)
        if not cat_entry:
            rows.append((sid, '✗ 不在清单里', '')); continue
        x, err = build(entry, cat_entry, src_root)
        if x is None:
            missing.append((sid, err))
            rows.append((sid, '待下载', err))
            continue
        if args.list:
            rows.append((sid, '就位', f'{len(x) / FS:.2f}s'))
            continue
        pcm = np.clip(x, -1, 1)
        out_path = os.path.join(out_dir, f'{sid}.{ext}')
        wavfile.write(out_path, FS, (pcm * 32767).astype('<i2'))
        done += 1
        produced[sid] = {
            'pack': entry['pack'],
            'parts': [p.get('f') for p in entry.get('parts', [])],
            'seconds': round(len(x) / FS, 3),
            'sha256': hashlib.sha256(open(out_path, 'rb').read()).hexdigest()[:16],
        }
        rows.append((sid, '✓ 已用真实素材', f'{len(x) / FS:.2f}s  peak {20 * np.log10(np.max(np.abs(x)) + 1e-9):.1f}dB'))

    print(f"{'id':24} {'状态':14} 备注")
    for sid, st, note in rows:
        print(f'{sid:24} {st:14} {note}')
    tot = len(SRC['entries'])
    print(f'\n真实素材 {tot - len(missing)}/{tot} 就位 · 本次写出 {done} 个'
          f'{"（--list 演练）" if args.list else ""}')
    if missing:
        print(f'仍用**合成占位**的 {len(missing)} 条：{", ".join(m[0] for m in missing)}')
    syn = SRC.get('synthesized', {})
    if syn:
        print(f'刻意保留合成的 {len([k for k in syn if not k.startswith("_")])} 条：'
              f'{", ".join(k for k in syn if not k.startswith("_"))}')

    if not args.list:
        write_credits(out_dir, src_root, missing)
        # ★ 出处清单由**加工器**写出（不是让校验器去猜）：谁写的、写自哪个素材包、哪几个片段、哈希多少。
        #   这样 verify-sfx.mjs 报的"真实录音/合成占位"就是事实，而不是"登记了就算"（踩过：源没下到也报成真实）。
        # ★ --only 时必须**合并**旧记录：否则只加工一条会把其余二十多条从出处表里抹掉，
        #   下次 verify-sfx 就会把那些真实录音误报成"合成占位"。
        prov_path = os.path.join(out_dir, '_provenance.json')
        old_entries = {}
        if only and os.path.exists(prov_path):
            try:
                old_entries = json.load(open(prov_path, encoding='utf-8')).get('entries', {})
            except Exception:
                old_entries = {}
        prov = {
            '_note': 'fetch-sfx.py 的产出记录：这些 id 的 wav **来自下载素材**（其余由 make-sfx.py 合成）。'
                     'sha256 只存前 16 位，用于发现"有人手改过文件"的漂移。',
            'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
            'entries': {**old_entries, **produced},
        }
        open(prov_path, 'w', encoding='utf-8').write(
            json.dumps(prov, ensure_ascii=False, indent=2) + '\n')
        print(f'✓ 出处记录：{os.path.relpath(os.path.join(out_dir, "_provenance.json"), ROOT)}'
              f'（{len(produced)} 条来自下载素材）')


def write_credits(out_dir, src_root, missing):
    """生成 game/effect/CREDITS.md —— 出处与许可证，随游戏一起交付"""
    used_packs = {e['pack'] for k, e in SRC['entries'].items() if not k.startswith('_')}
    L = ['# 全局音效 · 素材出处与许可证', '',
         '本目录下 `.wav` 有两类来源，**同名可互换**（命名即契约）：', '',
         '- **下载素材**（下表，逐条登记作者/许可证/来源页）',
         '- **合成占位**（`compiler/make-sfx.py` 生成，本项目自制，无第三方权利）', '',
         '生成：`python compiler/fetch-sfx.py --credits`（改 `sfx-sources.json` 后重跑）', '',
         '## 素材包', '', '| 包 | 作者 | 许可证 | 来源页 |', '|---|---|---|---|']
    for name in sorted(used_packs):
        p = SOURCE_PACKS[name]
        L.append(f'| `{name}` | {p["author"]} | {p["licence"]} | {p["page"]} |')
    L += ['', '## 逐条映射', '', '| 音效 id | 素材包 | 用到的片段 |', '|---|---|---|']
    for sid, e in SRC['entries'].items():
        if sid.startswith('_'):
            continue
        parts = ' + '.join(p.get('f', '?') for p in e.get('parts', []))
        L.append(f'| `{sid}` | `{e["pack"]}` | {parts} |')
    syn = [k for k in SRC.get('synthesized', {}) if not k.startswith('_')]
    if syn or missing:
        L += ['', '## 合成占位（无第三方权利）', '']
        for k in syn:
            L.append(f'- `{k}` — {SRC["synthesized"][k]}')
        for sid, err in missing:
            L.append(f'- `{sid}` — 源未就位（{err}），当前为合成占位')
    L += ['', '---', '',
          '★ 全部下载素材均为 **CC0 1.0（公有领域）**：可商用、可修改、**无需署名**。',
          '本文件仍逐条登记出处，是为了让后来者能复核许可证。',
          '★ 若将来引入 CC-BY / 限教育用途（如 BBC RemArc）的素材，**必须**在此登记并把署名',
          '写进游戏内 Staff 页 —— 那是本项目「许可证当场看」纪律的一部分。', '']
    path = os.path.join(out_dir, 'CREDITS.md')
    open(path, 'w', encoding='utf-8').write('\n'.join(L))
    print(f'\n✓ 出处登记已写出：{os.path.relpath(path, ROOT)}')


if __name__ == '__main__':
    main()
