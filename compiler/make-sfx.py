#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
compiler / make-sfx.py —— 全局音效的**合成器**（占位层，可被同名覆盖）
===========================================================================
读 `sfx-catalog.json`（唯一真源，JS 侧读同一个文件）→ 合成 → 直接写
`webgal-tool/dist/game/effect/<id>.wav`。

★ 为什么是合成而不是下载：
  本机没有任何音效素材库（全盘查过），而免费音效源的授权（CC-BY 要署名 / BBC 限教育）
  与「22 条拟声词 + 16 个环境音床」这种高度定制的需求并不匹配。合成的好处是
  **离线、零授权风险、参数可调可复现**，且**命名即契约** —— 将来换真实素材同名覆盖即可。

★ 工程约束（本项目踩过的坑，直接体现在代码里）：
  · **不产生任何中间文件**：内存里合成完，`scipy.io.wavfile.write` 一步落盘。
    （沙箱里"可避免的删除"都要避免，累计删除会直接终止进程。）
  · 只用已装的 numpy / scipy，不装新依赖。
  · 环境音床必须**可无缝循环**（见 `loopify`，把尾巴交叉淡入头部，而不是把两头淡出）。
  · 一次性音效走**单声道**（WebGAL 的 playEffect 不带 id 时就是单声道通道），
    所以「砰！砰！砰！」必须在这里**预先合成为一条音频**，不能靠连发指令。

用法：
  python compiler/make-sfx.py                 # 全量合成（覆盖）
  python compiler/make-sfx.py --list          # 只列清单，不合成
  python compiler/make-sfx.py --only=se_gunshot,amb_rain
  python compiler/make-sfx.py --check         # 只自检（清单完整性/时长/峰值），不写盘
"""

import argparse
import json
import math
import os
import sys
import time
import zlib

import numpy as np
from scipy import signal
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(HERE, 'sfx-catalog.json')
SFX_SRC = os.path.join(ROOT, '_sfx-src')


_DECODE = None


def decode_src(path, fs):
    """
    ★ 复用 fetch-sfx.py 的**唯一解码实现**（文件名带连字符，不能直接 import ⇒ 按路径加载）。
      两条纪律靠它保证：① 必须走 AudioResampler(format='fltp', layout='mono') 强制单声道
      （直接 to_ndarray() + mean(axis=0) 会把立体声逐对平均 → 时长翻倍、内容错乱、**不报错**）；
      ② 同一份规则只能有一处实现（改一处不会漏改另一处）。
    """
    global _DECODE
    if _DECODE is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            'fetch_sfx_mod', os.path.join(HERE, 'fetch-sfx.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _DECODE = mod.decode
    return _DECODE(path, fs)


def real_bed(p, fs):
    """
    真实底床：把一条**外部循环素材**读进来、tile 到目标长度。
    ★ 三个必须遵守的事实（都在实现里坐实）：
      ① Kenney 的 engine / spaceEngine / computerNoise 是**精确 5.00s 的无缝循环**
         （实测接缝 seam ∈ [0.91,1.33]）⇒ 按整周期 tile 即天然无缝。
         **绝不加淡入淡出** —— 那会破坏无缝（不是保险，是破坏）。
      ② 素材比目标短 ⇒ 复制整数个周期，**末尾一定要对齐到整周期**；
         比目标长 ⇒ 取整周期后裁掉（同样不加淡出）。
      ③ 素材做**峰值归一**再乘 gain，否则不同素材天生电平差会让换素材＝换音量。
    """
    rel = p['realBed']
    path = os.path.join(SFX_SRC, rel)
    if not os.path.exists(path):
        raise SystemExit(
            f'✗ realBed 素材不存在：{rel}\n'
            f'  找的是：{path}\n'
            '  这条资产用了「真实底床」（CC0 素材垫底 + 合成事件层），所以要先备好素材源：\n'
            '      python compiler/fetch-sfx.py --download     # 按 sfx-sources.json 的 packs 拉 CC0 压缩包\n'
            '  ★ 只想听个效果、不想下载：把该资产的 `realBed` 参数去掉，它就退回**纯合成**\n'
            '    （42 条资产里绝大多数本来就是纯合成，零下载、零授权）。\n'
            '  ★ `--check` 会遍历全部资产，因此**必须有素材源**才能跑；只合成不需下载。'
        )
    x = decode_src(path, fs).astype(np.float64)
    if len(x) < fs:                       # 短于 0.25s 的不能当床
        raise SystemExit(f'✗ realBed 素材太短（{len(x)/fs:.2f}s）：{rel}')
    x = x / (np.max(np.abs(x)) + 1e-12)   # 峰值归一，消除素材间电平差
    return x



def seed_of(s):
    """
    ★ 用 crc32 而不是内置 hash()：Python 的 str hash 带随机盐（PYTHONHASHSEED），
      同一个 id 每次跑会得到不同种子 ⇒ 音效不可复现。这个坑必须避开。
    """
    return zlib.crc32(s.encode('utf-8')) & 0x7FFFFFFF


# ───────────────────────────────────────────────────────────────────────────
#  DSP 小工具
# ───────────────────────────────────────────────────────────────────────────


def nz(rng, n):
    """白噪声"""
    return rng.standard_normal(n).astype(np.float64)


def pink(rng, n):
    """1/f 噪声（频谱整形）"""
    x = nz(rng, n)
    X = np.fft.rfft(x)
    f = np.arange(len(X))
    f[0] = 1
    X = X / np.sqrt(f)
    return np.fft.irfft(X, n)


def brown(rng, n):
    """1/f² 噪声（积分白噪声后去趋势）"""
    x = np.cumsum(nz(rng, n))
    x = signal.detrend(x)
    return x


def filt(x, fs, hp=None, lp=None, order=4):
    """带通/低通/高通（SOS 二阶节，数值稳定）"""
    if hp and lp:
        sos = signal.butter(order, [max(hp, 1) / (fs / 2), min(lp, fs / 2 - 100) / (fs / 2)], btype='band', output='sos')
    elif lp:
        sos = signal.butter(order, min(lp, fs / 2 - 100) / (fs / 2), btype='low', output='sos')
    elif hp:
        sos = signal.butter(order, max(hp, 1) / (fs / 2), btype='high', output='sos')
    else:
        return x
    return signal.sosfilt(sos, x)


def decay(n, tau, fs):
    """指数衰减包络（tau 秒）"""
    t = np.arange(n) / fs
    return np.exp(-t / max(tau, 1e-4))


def partial(freq, n, tau, fs, phase=0.0):
    """一条金属/弦的分音（带自身衰减）"""
    t = np.arange(n) / fs
    return np.sin(2 * np.pi * freq * t + phase) * decay(n, tau, fs)


def reverb(x, fs, tau=0.25, lp=2500, mix=0.3, rng=None):
    """用「指数衰减噪声」当脉冲响应做短混响（够用且不需要 IR 文件）"""
    rng = rng or np.random.default_rng(7)
    L = int(tau * 4 * fs)
    ir = filt(nz(rng, L), fs, lp=lp) * decay(L, tau, fs)
    ir /= np.abs(ir).sum() + 1e-9
    wet = signal.fftconvolve(x, ir)[: len(x)]
    wet /= np.max(np.abs(wet)) + 1e-9
    return (1 - mix) * x + mix * wet * np.max(np.abs(x))


def sweep_bp(x, fs, f0, f1, q=6.0, k=14, fade=0.25):
    """中心频率 f0→f1 的扫频带通（分段滤波 + 交叉淡化）"""
    n = len(x)
    seg = n // k
    out = np.zeros(n)
    win = np.ones(n)
    for i in range(k):
        a, b = i * seg, min(n, (i + 1) * seg)
        if b <= a:
            break
        c = f0 * (f1 / f0) ** (i / max(k - 1, 1))
        c = float(np.clip(c, 40, fs / 2 - 200))
        bw = c / q
        y = filt(x[a:b], fs, hp=c - bw, lp=c + bw)
        out[a:b] += y
        if i:  # 与前段交叉淡化，避免分段咔哒声
            fl = int(min(fade * seg, (b - a) / 2))
            if fl > 1:
                w = np.linspace(0, 1, fl)
                out[a:a + fl] = out[a:a + fl] * w + y[:fl] * (1 - w)
    return out * win


def fit(x, peak=None, rms_db=None):
    """归一化：给 peak 就压峰值；给 rms_db 就先按 RMS 对齐再限峰"""
    x = np.nan_to_num(x)
    if rms_db is not None:
        r = np.sqrt(np.mean(x ** 2)) + 1e-12
        x = x / r * (10 ** (rms_db / 20))
        if peak:
            m = np.max(np.abs(x))
            if m > peak:
                x = x / m * peak
        return x
    m = np.max(np.abs(x)) + 1e-12
    return x / m * (peak or 0.9)


def loopify(x, fs, ms=1200):
    """
    ★ 把结尾交叉淡入**开头**，这才是真正无缝的做法。
    （常见的「两头都淡出」是错的：接缝处幅值为 0，听着像卡顿。）

    数学上保证接缝连续：取长 L 的窗口，等功率配比 wi=sin(π/2·w)、wo=cos(π/2·w)，
    在 w=0 处 wo=1 ⇒ y[0] 恰等于 x[M]，而循环点的前一个样本 y[-1]=x[M-1]，
    两者本来就是**原始信号里相邻的两个样本** ⇒ 接缝与信号内部任意处无异。
    `selftest_loopify()` 会断言这两条等式，防止以后改权重改坏。
    """
    L = int(ms / 1000 * fs)
    if len(x) <= 2 * L:
        return x
    M = len(x) - L
    w = np.linspace(0, 1, L)
    wi, wo = np.sin(w * np.pi / 2), np.cos(w * np.pi / 2)
    y = x[:M].copy()
    y[:L] = x[:L] * wi + x[M:M + L] * wo
    return y


def selftest_loopify(fs=44100):
    """结构性自检：接缝两侧必须等于原始信号里相邻的两个样本。"""
    x = np.sin(2 * np.pi * 220 * np.arange(int(3 * fs)) / fs) * 0.7
    x[0] = 0.0  # 故意把首样本打歪：正确实现应把它冲掉（y[0] = x[M]）
    y = loopify(x, fs, ms=800)
    L = int(0.8 * fs)
    M = len(x) - L
    ok1 = abs(y[0] - x[M]) < 1e-12
    ok2 = abs(y[-1] - x[M - 1]) < 1e-12
    ok3 = len(y) == M
    print(f'loopify 自检：y[0]==x[M] {"✓" if ok1 else "✗"} · y[-1]==x[M-1] {"✓" if ok2 else "✗"}'
          f' · 长度 {len(y)}=={M} {"✓" if ok3 else "✗"}')
    return ok1 and ok2 and ok3


def place(track, x, at, gain=1.0):
    """把一段音频按采样位置叠到轨道上"""
    a = int(at)
    if a < 0 or a >= len(track):
        return
    b = min(len(track), a + len(x))
    track[a:b] += x[: b - a] * gain


# ───────────────────────────────────────────────────────────────────────────
#  一次性音效
# ───────────────────────────────────────────────────────────────────────────


def r_gunshot(p, fs, rng):
    n = int(p['len'] * fs)
    click = filt(nz(rng, n), fs, hp=1200, lp=9000) * decay(n, 0.0016, fs)
    body = filt(nz(rng, n), fs, hp=p['bodyHz'][0], lp=p['bodyHz'][1]) * decay(n, p['bodyTau'], fs)
    tail = filt(nz(rng, n), fs, lp=700) * decay(n, p['tailTau'], fs)
    sub = np.sin(2 * np.pi * p.get('sub', 60) * np.arange(n) / fs) * decay(n, p['bodyTau'] * 1.6, fs)
    x = 0.55 * click + 0.95 * body + 0.5 * tail + 0.55 * sub
    if p.get('rev'):
        x = reverb(x, fs, tau=0.30, lp=2600, mix=p['rev'], rng=rng)
    return x


def r_impact(p, fs, rng):
    n = int(p['len'] * fs)
    body = filt(nz(rng, n), fs, hp=p['bodyHz'][0], lp=p['bodyHz'][1]) * decay(n, p['bodyTau'], fs)
    x = body
    if p.get('sub'):
        x = x + 0.7 * np.sin(2 * np.pi * p['sub'] * np.arange(n) / fs) * decay(n, p.get('subTau', 0.1), fs)
    if p.get('tailTau'):
        x = x + 0.32 * filt(nz(rng, n), fs, lp=600) * decay(n, p['tailTau'], fs)
    for f, tau in p.get('metal', []):
        x = x + 0.45 * partial(f, n, tau, fs, phase=rng.random() * 6.28)
    if p.get('cloth'):
        x = x + p['cloth'] * filt(nz(rng, n), fs, hp=400, lp=4000) * decay(n, 0.10, fs)
    if p.get('wet'):
        x = x + p['wet'] * filt(nz(rng, n), fs, hp=300, lp=1400) * decay(n, 0.03, fs)
    return x


def r_mech(p, fs, rng):
    n = int(p['len'] * fs)
    x = filt(nz(rng, n), fs, hp=p['noiseHz'][0], lp=p['noiseHz'][1]) * decay(n, p['noiseTau'], fs)
    for f, tau in p['metal']:
        x = x + 0.5 * partial(f, n, tau, fs, phase=rng.random() * 6.28)
    mid = int(0.035 * fs)  # 第二下小卡榫
    if mid < n:
        x[mid:] += 0.45 * filt(nz(rng, n - mid), fs, hp=1000, lp=8000) * decay(n - mid, 0.004, fs)
    return x


def r_burst(p, fs, rng, proto_fn):
    n = int(p['len'] * fs)
    proto = proto_fn(fs, rng)
    out = np.zeros(n)
    at = 0.0
    for i in range(p['n']):
        g = 1.0 - 0.12 * rng.random()
        place(out, proto, at * fs, g)
        at += p['gap'] + (rng.random() - 0.5) * 2 * p.get('jitter', 0.0)
    return out


def r_explosion(p, fs, rng):
    n = int(p['len'] * fs)
    body = brown(rng, n) * decay(n, p['bodyTau'], fs)
    body = filt(body, fs, hp=35, lp=p.get('lp', 3000))
    rumble = np.sin(2 * np.pi * p['rumbleHz'] * np.arange(n) / fs) * decay(n, p['rumbleTau'], fs)
    x = 1.0 * body + 0.9 * rumble
    if p.get('crackle'):
        c = np.zeros(n)
        for _ in range(int(60 * p['crackle'])):
            i = int(rng.random() * n * 0.6)
            ln = int(0.02 * fs)
            place(c, filt(nz(rng, ln), fs, hp=1500), i, p['crackle'] * rng.random())
        x = x + c
    if p.get('metal'):
        x = x + p['metal'] * filt(nz(rng, n), fs, hp=1000, lp=5000) * decay(n, 0.25, fs)
    if p.get('rev'):
        x = reverb(x, fs, tau=0.45, lp=1800, mix=p['rev'], rng=rng)
    return x


def r_clatter(p, fs, rng):
    n = int(p['len'] * fs)
    out = np.zeros(n)
    at = 0.0
    for i in range(p['n']):
        sub = r_impact(
            {'len': 0.5, 'bodyHz': [200, 1800], 'bodyTau': 0.03, 'sub': 0,
             'metal': p['metal']}, fs, rng)
        g = (p.get('decay', 1.0) ** i) * (0.6 + 0.4 * rng.random())
        place(out, sub, at * fs, g)
        at += (p['gap'] + (rng.random() - 0.5) * 2 * p.get('jitter', 0.0)) * p.get('spread', 1.0)
    return out


def r_glass(p, fs, rng):
    n = int(p['len'] * fs)
    body = filt(nz(rng, n), fs, hp=p['hp']) * decay(n, p['bodyTau'], fs)
    x = 0.8 * body
    for _ in range(p['n']):
        f = 2600 * (9000 / 2600) ** rng.random()
        at = rng.random() * p['span']
        ln = min(n - int(at * fs), int(0.35 * fs))
        if ln <= 0:
            continue
        x[int(at * fs):int(at * fs) + ln] += 0.5 * partial(f, ln, 0.05 + rng.random() * 0.15, fs,
                                                          phase=rng.random() * 6.28)
    return x


def r_woodbreak(p, fs, rng):
    n = int(p['len'] * fs)
    crack = filt(nz(rng, n), fs, hp=500, lp=3500) * decay(n, p['crackTau'], fs)
    am = 0.6 + 0.4 * np.sin(2 * np.pi * 22 * np.arange(n) / fs)
    x = crack * am
    at = int(p['collapseAt'] * fs)
    ln = n - at
    if ln > 0:
        col = filt(nz(rng, ln), fs, lp=p['lp']) * decay(ln, p['collapseTau'], fs)
        col = col + 0.7 * np.sin(2 * np.pi * 48 * np.arange(ln) / fs) * decay(ln, 0.25, fs)
        x[at:] += 1.2 * col
    return x


def r_whoosh(p, fs, rng):
    n = int(p['len'] * fs)
    x = sweep_bp(nz(rng, n), fs, p['f0'], p['f1'], q=p['q'])
    t = np.arange(n) / fs
    env = np.exp(-((t - 0.16) ** 2) / (2 * 0.075 ** 2))
    return x * env


def r_alarm(p, fs, rng):
    n = int(p['len'] * fs)
    t = np.arange(n) / fs
    # 三角波频率调制（升—降—升），比逐段写相位可读且数值稳定
    tri = 2 * np.abs(2 * ((t / p['period']) % 1) - 1) - 1  # -1..1
    f = (p['lo'] + p['hi']) / 2 + (p['hi'] - p['lo']) / 2 * tri
    ph = 2 * np.pi * np.cumsum(f) / fs
    x = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)
    env = np.minimum(1, t / 0.12) * np.minimum(1, (p['len'] - t) / 0.45)
    x = np.tanh(x * 1.4) * env
    return x


def r_stringhum(p, fs, rng):
    n = int(p['len'] * fs)
    t = np.arange(n) / fs
    x = np.zeros(n)
    for i, m in enumerate(p['partials']):
        for det in (-0.0015, 0.0015):
            x = x + (0.6 ** i) * np.sin(2 * np.pi * p['f0'] * m * (1 + det) * t + rng.random() * 6.28)
    trem = 1 + 0.06 * np.sin(2 * np.pi * 1.7 * t)
    env = np.minimum(1, t / 0.35) * np.minimum(1, (p['len'] - t) / 1.1)
    return filt(x * trem * env, fs, lp=4000)


def r_beep(p, fs, rng):
    n = int(p['len'] * fs)
    a = int(0.12 * fs)
    x = np.zeros(n)
    for i, f in enumerate([p['f'], p['f2']]):
        seg = np.zeros(n)
        seg[int(i * 0.15 * fs):int(i * 0.15 * fs) + a] = np.sin(
            2 * np.pi * f * np.arange(a) / fs)
        x = x + seg * (1 - 0.25 * i)
    env = np.minimum(1, np.arange(n) / (0.004 * fs)) * np.minimum(1, (n - np.arange(n)) / (0.02 * fs))
    return x * env


def r_steps(p, fs, rng):
    n = int(p['len'] * fs)
    out = np.zeros(n)
    at = 0.15
    for _ in range(p['n']):
        ln = int(0.16 * fs)
        step = filt(nz(rng, ln), fs, lp=p['lp']) * decay(ln, 0.012, fs)
        step = step + 0.5 * filt(nz(rng, ln), fs, lp=300) * decay(ln, 0.035, fs)
        place(out, step, at * fs, 0.6 + 0.4 * rng.random())
        at += p['gap'] + (rng.random() - 0.5) * 2 * p['jitter']
    return out


def r_growl(p, fs, rng):
    n = int(p['len'] * fs)
    t = np.arange(n) / fs
    am = 0.5 + 0.5 * np.sin(2 * np.pi * (p['f'] + p['vib'] * np.sin(2 * np.pi * 1.3 * t)) * t)
    x = filt(nz(rng, n), fs, hp=p['bodyHz'][0], lp=p['bodyHz'][1]) * am
    x = x + 0.6 * np.sin(2 * np.pi * p['f'] * t) * am  # 加一点喉音基频
    env = np.minimum(1, t / 0.15) * np.minimum(1, (p['len'] - t) / 0.35)
    return filt(x * env, fs, lp=3000)


def r_whimper(p, fs, rng):
    n = int(p['len'] * fs)
    t = np.arange(n) / fs
    f = p['f0'] + (p['f1'] - p['f0']) * (t / p['len']) + 8 * np.sin(2 * np.pi * 4.5 * t)
    breath = filt(nz(rng, n), fs, hp=600, lp=3500)
    tone = np.sin(2 * np.pi * np.cumsum(f) / fs)
    x = 0.45 * tone + 0.75 * breath
    env = np.minimum(1, t / 0.25) * np.exp(-t / 1.1)
    return filt(x * env, fs, lp=4000)


# ───────────────────────────────────────────────────────────────────────────
#  环境音床（循环）
# ───────────────────────────────────────────────────────────────────────────

def ev_whoosh(rng, fs, ln):
    x = sweep_bp(nz(rng, ln), fs, 1600, 400, q=2.5)
    t = np.arange(ln) / fs
    return x * np.exp(-((t - 0.5) ** 2) / (2 * 0.35 ** 2))


def ev_tick(rng, fs, ln):
    x = filt(nz(rng, ln), fs, hp=2500, lp=9000) * decay(ln, 0.002, fs)
    return x


def ev_drip(rng, fs, ln):
    t = np.arange(ln) / fs
    f = 1300 * np.exp(-t / 0.03) + 420
    return np.sin(2 * np.pi * np.cumsum(f) / fs) * decay(ln, 0.05, fs)


def ev_creak(rng, fs, ln):
    t = np.arange(ln) / fs
    f = 130 + 40 * np.sin(2 * np.pi * 3.3 * t) + 12 * np.sin(2 * np.pi * 17 * t)
    x = signal.sawtooth(2 * np.pi * np.cumsum(f) / fs) * 0.5 + 0.5 * filt(nz(rng, ln), fs, hp=300, lp=2500)
    return x * decay(ln, 0.16, fs)


def ev_wind(rng, fs, ln):
    x = sweep_bp(nz(rng, ln), fs, 900, 260, q=1.6)
    t = np.arange(ln) / fs
    return x * np.sin(np.pi * np.clip(t / (ln / fs), 0, 1)) ** 1.5


def ev_wave(rng, fs, ln):
    x = filt(nz(rng, ln), fs, lp=900)
    t = np.arange(ln) / fs
    return x * np.sin(np.pi * np.clip(t / (ln / fs), 0, 1)) ** 2


def ev_paper(rng, fs, ln):
    return filt(nz(rng, ln), fs, hp=2200, lp=9000) * decay(ln, 0.05, fs)


def ev_cricket(rng, fs, ln):
    out = np.zeros(ln)
    for k in range(4):
        a = int(k * 0.055 * fs)
        ln2 = min(ln - a, int(0.02 * fs))
        if ln2 <= 0:
            continue
        seg = np.zeros(ln2)
        t = np.arange(ln2) / fs
        seg[:] = np.sin(2 * np.pi * 4600 * t) * np.exp(-t / 0.006)
        place(out, seg, a)
    return out


def ev_clap(rng, fs, ln):
    return filt(nz(rng, ln), fs, hp=900, lp=5000) * decay(ln, 0.02, fs)


def ev_ember(rng, fs, ln):
    return filt(nz(rng, ln), fs, hp=1800, lp=8000) * decay(ln, 0.004, fs)


def ev_drop(rng, fs, ln):
    return filt(nz(rng, ln), fs, hp=6000) * decay(ln, 0.008, fs)


def ev_siren_far(rng, fs, ln):
    t = np.arange(ln) / fs
    tri = 2 * np.abs(2 * ((t / 2.0) % 1) - 1) - 1
    f = 700 + 260 * tri
    x = np.sin(2 * np.pi * np.cumsum(f) / fs)
    x = filt(x, fs, lp=1200)
    return x * np.sin(np.pi * np.clip(t / (ln / fs), 0, 1)) ** 2


EVENTS = {'whoosh': (ev_whoosh, 1.2), 'tick': (ev_tick, 0.05), 'drip': (ev_drip, 0.25),
          'creak': (ev_creak, 1.1), 'wind': (ev_wind, 2.6), 'wave': (ev_wave, 3.0),
          'paper': (ev_paper, 0.35), 'cricket': (ev_cricket, 0.3), 'clap': (ev_clap, 0.12),
          'ember': (ev_ember, 0.05), 'drop': (ev_drop, 0.04), 'siren_far': (ev_siren_far, 3.0)}


def snap(f, m_dur):
    """
    把频率/速率吸附到「在 m_dur 秒里正好走整数个周期」的最近值。
    ★ 这是环境音无缝的关键：稳态嗡鸣必须是**严格周期**的，
      否则交叉淡化时两个非同相正弦会互相抵消/叠加 ⇒ 淡化区里出现幅度的凹或凸 = 听得见的泵动。
      （实测：带 47Hz 嗡鸣的地下层、带 100Hz 日光灯的房间，都是这么被接缝指标抓出来的。）
    """
    k = max(1, int(round(f * m_dur)))
    return k / m_dur


def r_bed(p, fs, rng, no_loop=False):
    """
    环境音床 = **周期性成分（嗡鸣/脉冲/调制）** + **噪声成分（层/事件）**，两者分开处理：
      · 周期性成分吸附到整周期，直接截断即无缝，**不参与交叉淡化**；
      · 噪声成分做 1.2s 等功率交叉淡化（噪声互不相关，等功率混合才是对的）。

    ★ 两条并列的产线（同一份骨架，两条不同的收尾）：
      A) **合成底床**（默认）：噪声层由 `layers` 生成 → loopify 等功率交叉淡化。
      B) **真实底床**（`p.realBed` 指向一条 `_sfx-src` 下的外部循环素材）：
         素材 tile 成整数周期当噪声底（`layers` 被忽略），收尾**不做任何淡化**
         —— 素材本身首尾就能接上，再淡化反而是把对齐的头尾互相叠上去 ⇒ 接缝泵动。
         其余成分（hum / pulse / events / rotor / swell）两条产线**完全同款叠加**。
    """
    M = int(p['len'] * fs)          # 最终循环长度
    m_dur = M / fs
    use_real = bool(p.get('realBed'))
    if use_real:
        # ★ realBed 的床长必须对齐成「整数个素材周期」：
        #   否则尾部半截块在循环点接不上（这是 loopify 唯一能救、而我们选择不用的场景）。
        rb = real_bed(p, fs)
        reps = max(1, int(round(M / len(rb))))
        M = reps * len(rb)
        m_dur = M / fs
    XF = 0 if use_real else int(1.2 * fs)   # 真实底床不做交叉淡化尾巴
    N = M + XF
    t = np.arange(N) / fs

    # ── 周期性成分 ──
    peri = np.zeros(N)
    for f, g in p.get('hum', []):
        peri = peri + g * 8 * np.sin(2 * np.pi * snap(f, m_dur) * t + rng.random() * 6.28)

    # ── 噪声成分 ──
    noise = np.zeros(N)
    if use_real:
        gain = p.get('realGain', 1.0)
        noise = noise + np.tile(rb, reps)[:N] * gain
    for kind, gain, hp, lp in p.get('layers', []):
        base = {'white': nz, 'pink': pink, 'brown': brown}[kind](rng, N)
        noise = noise + gain * filt(base, fs, hp=hp or None, lp=lp or None)
    for period, f, g, tau in p.get('pulse', []):
        per = snap(period, m_dur)
        at = 0.4
        while at < p['len'] + XF / fs - 0.5:
            ln = int(min(0.4, tau * 8) * fs)
            seg = np.sin(2 * np.pi * f * np.arange(ln) / fs) * decay(ln, tau, fs)
            place(noise, seg, at * fs, g)
            at += per
    for kind, count, gain in p.get('events', []):
        fn, dur = EVENTS[kind]
        for _ in range(count):
            ln = int(dur * fs)
            at = rng.random() * max(1, N - ln)
            place(noise, fn(rng, fs, ln), at, gain * (0.6 + 0.4 * rng.random()))
    if p.get('rotor'):
        rf, depth = p['rotor']
        noise = noise * (1 - depth + depth * (0.5 + 0.5 * np.sin(2 * np.pi * snap(rf, m_dur) * t)))
    if p.get('swell'):
        rate, depth = p['swell']
        noise = noise * (1 - depth + depth * (0.5 + 0.5 * np.sin(2 * np.pi * snap(rate, m_dur) * t + 1.0)))
    noise = signal.detrend(noise)

    if no_loop:
        return peri + noise

    if use_real:
        # ★ realBed 路径**不做任何淡化**：peri 与 bed 都已对齐整数周期，直接截断即无缝。
        #   （事件层是随机摆放的，但它的时域能量远低于底床，且 detrend 后不会在接缝处
        #     留下直流台阶 —— 实测接缝 seam 与别处一致，见 --diag。）
        x = peri[:M] + noise[:M]
        return fit(x, peak=p.get('peak', 0.5), rms_db=-25.0)

    noise = loopify(noise, fs, ms=1200)   # 噪声：等功率交叉淡化 → 长度 M
    x = peri[:M] + noise                  # 周期成分整周期截断，天然无缝
    return fit(x, peak=p.get('peak', 0.5), rms_db=-25.0)


def hop_env(x, fs, hop_s=0.05):
    """50ms 跳窗 RMS 包络（接缝诊断用）"""
    hop = max(1, int(hop_s * fs))
    nh = len(x) // hop
    return np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2)) for i in range(nh)])


def diag(ids, fs, cat):
    """打印指定环境音的接缝包络，用来区分「源信号两端本来就轻」还是「loopify 引入的」"""
    print(f"{'id':18} {'loopify前 首':>12} {'末':>6} | {'loopify后 首':>12} {'末':>6}   判定")
    for e in cat['ambience']:
        if ids and e['id'] not in ids:
            continue
        rng1 = np.random.default_rng(seed_of(e['id']))
        pre = r_bed(e['p'], fs, rng1, no_loop=True)
        rng2 = np.random.default_rng(seed_of(e['id']))
        post = r_bed(e['p'], fs, rng2)
        envp, envo = hop_env(pre, fs), hop_env(post, fs)
        mp, mo = np.median(envp) + 1e-12, np.median(envo) + 1e-12
        a, b = envp[0] / mp, envp[-1] / mp
        c, d = envo[0] / mo, envo[-1] / mo
        verdict = '源两端就轻 ⇒ 调合成参数' if min(a, b) < 0.5 else ('loopify 引入 ⇒ 修 loopify' if min(c, d) < 0.25 else 'ok')
        print(f'{e["id"]:18} {a:12.2f} {b:6.2f} | {c:12.2f} {d:6.2f}   {verdict}')


# ───────────────────────────────────────────────────────────────────────────
#  调度
# ───────────────────────────────────────────────────────────────────────────

def build_one(entry, fs, rng, in_memory_proto=None):
    """合成一条。`in_memory_proto` 用于 burst 找原型件（不落盘的中间件）。"""
    name = entry['synth']
    p = entry.get('p', {})
    if name == 'burst':
        proto_id = p['proto']
        fn = (in_memory_proto or {}).get(proto_id)
        if fn is None:
            raise SystemExit(f'✗ {entry["id"]} 需要的原型件 {proto_id} 不存在（清单里要有它）')
        x = r_burst(p, fs, rng, fn)
    else:
        table = {
            'gunshot': r_gunshot, 'impact': r_impact, 'mech': r_mech, 'explosion': r_explosion,
            'clatter': r_clatter, 'glass': r_glass, 'woodbreak': r_woodbreak, 'whoosh': r_whoosh,
            'alarm': r_alarm, 'stringhum': r_stringhum, 'beep': r_beep, 'steps': r_steps,
            'growl': r_growl, 'whimper': r_whimper, 'bed': r_bed,
        }
        if name not in table:
            raise SystemExit(f'✗ {entry["id"]} 用了未知合成器 `{name}`')
        x = table[name](p, fs, rng)
    # ★ 一次性音效必须**逐个峰值归一化**：合成器的中间系数是任意的，
    #   不归一化会出现「+45dB → int16 硬削波成方波」和「−10dB → 小到听不见」两种事故（踩过）。
    #   环境音床在 r_bed 内部已按 RMS 对齐并限峰，这里不能再来一次 peak 归一化，
    #   否则会把安静段整体抬起来、破坏环境音的动态设计。
    if name != 'bed':
        x = fit(x, peak=p.get('peak', 0.9))
    return x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', action='store_true', help='只列清单')
    ap.add_argument('--check', action='store_true', help='只自检，不写盘')
    ap.add_argument('--only', default='', help='逗号分隔的 id 白名单')
    ap.add_argument('--diag', default=None, nargs='?', const='',
                    help='接缝诊断：可选逗号分隔 id；不带值 = 全部环境音')
    args = ap.parse_args()

    cat = json.load(open(CATALOG, encoding='utf-8'))
    fs = cat['format']['rate']
    out_dir = os.path.join(ROOT, 'webgal-tool', 'dist', cat['format']['dir'])
    ext = cat['format']['ext']
    one, amb = cat['oneShots'], cat['ambience']
    only = {s.strip() for s in args.only.split(',') if s.strip()}

    if args.diag is not None:
        diag({s.strip() for s in args.diag.split(',') if s.strip()}, fs, cat)
        return

    if args.list:
        print(f"{'id':26} {'kind':6} {'len':>6} {'vol':>4}  desc")
        for kind, arr in (('SE', one), ('AMB', amb)):
            for e in arr:
                tag = '(hidden)' if e.get('hidden') else ''
                print(f"{e['id']:26} {kind:6} {e['p'].get('len', 0):6.2f} {e.get('volume', 0):4}  {e['desc']} {tag}")
        print(f"\n合计 {len(one)} 一次性 + {len(amb)} 环境音床 = {len(one) + len(amb)} 条"
              f"（输出 {cat['format']['dir']}/ … .{ext} @ {fs}Hz）")
        return

    if not args.check and not selftest_loopify(fs):
        sys.exit('✗ loopify 结构性自检失败 —— 环境音接缝一定会有咔哒声，先修它')

    if not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # ① 原型件先行：`burst` 类的 proto 可以是**任何** id（不限于 hidden 的），
    #    所以给全部一次性音效都建一个「按需合成」的闭包（惰性，用到才跑）。
    protos = {e['id']: (lambda ent: (lambda fs_, rng_: build_one(ent, fs_, rng_)))(e) for e in one}

    rows, total = [], 0
    hybrid_prov = {}          # realBed 条目的出处记录（合并进 _provenance.json）
    targets = [e for e in one if not e.get('hidden')] + list(amb)
    for e in targets:
        if only and e['id'] not in only:
            continue
        rng = np.random.default_rng(seed_of(e['id']))
        x = build_one(e, fs, rng, in_memory_proto=protos)
        peak = np.max(np.abs(x))
        if peak < 1e-6:
            raise SystemExit(f'✗ {e["id"]} 合成结果全零')
        if peak > 1.0:
            raise SystemExit(f'✗ {e["id"]} 峰值 {peak:.2f} > 1.0 —— 会被 int16 削波')
        # ★ 接缝的正确测法：把「末 25ms + 首 25ms」直接拼起来（这正是玩家在循环点听到的东西），
        #   算它的 RMS，和全片所有 25ms 窗的中位数比。比值落在 [0.4, 2.5] 就说明
        #   "接缝处听起来和别处一样" —— 没有咔哒、也没有泵动。
        #   ❌ 踩过的两个错测法：① 比首末样本差（对噪声信号无区分力）；
        #     ② 比 50ms 跳窗包络的中位数（brown 噪声的低频漂移让 50ms 能量本身就有 ±10× 起伏 ⇒ 大面积误报）。
        w = int(0.025 * fs)
        nh = len(x) // w
        wins = np.array([np.sqrt(np.mean(x[i * w:(i + 1) * w] ** 2)) for i in range(nh)])
        seam_w = np.concatenate([x[-w:], x[:w]])
        seam = np.sqrt(np.mean(seam_w ** 2)) / (np.median(wins) + 1e-12)
        crest = peak / (np.sqrt(np.mean(x ** 2)) + 1e-12)
        pcm = np.clip(x * 32767, -32768, 32767).astype('<i2')
        path = os.path.join(out_dir, f"{e['id']}.{ext}")
        if not args.check:
            wavfile.write(path, fs, pcm)   # ★ 一步落盘，不产生中间文件
            # ★ realBed 条目含**真实素材**（Kenney），必须登记进出处表 —— 否则 verify-sfx
            #   会继续把它报成「合成占位·免署名」，出处表与事实不符（主人 2026-10-03 裁定）。
            if e.get('p', {}).get('realBed'):
                import hashlib
                hybrid_prov[e['id']] = {
                    'kind': 'hybrid',
                    'realBed': e['p']['realBed'],
                    'pack': 'kenney_scifi',
                    'note': '真实底床（Kenney CC0）+ 合成事件层；出自 make-sfx.py 的 realBed 通道',
                    'seconds': round(len(pcm) / fs, 3),
                    'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16],
                }
        size = pcm.nbytes
        total += size
        rows.append((e['id'], 'AMB' if e in amb else 'SE', len(pcm) / fs,
                     20 * math.log10(max(peak, 1e-9)), crest, seam, size))

    print(f"{'id':26} {'kind':4} {'len(s)':>7} {'peakdB':>7} {'crest':>6} {'接缝':>6} {'KB':>7}")
    for i, k, ln, db, cr, sm, sz in rows:
        flag = ''
        if k == 'AMB' and not (0.4 <= sm <= 2.5):
            flag = '  ← ★ 接缝与别处不像（循环会咔/泵动），必须修'
        elif k == 'SE' and db < -6:
            flag = '  ← 偏轻'
        print(f'{i:26} {k:4} {ln:7.2f} {db:7.2f} {cr:6.1f} {sm:6.2f} {sz / 1024:7.1f}{flag}')
    print(f"\n{len(rows)} 条 · 合计 {total / 1048576:.2f} MB"
          f"{'（--check 演练，未写盘）' if args.check else ' → ' + cat['format']['dir']}/")
    bad = [r for r in rows if r[1] == 'AMB' and not (0.4 <= r[5] <= 2.5)]
    if bad:
        print(f'⚠ {len(bad)} 条环境音接缝异常：{", ".join(r[0] for r in bad)}')
        sys.exit(1)

    # ② 自检：规则引用到的文件名必须都在盘上
    missing = [r[0] for r in rows if not os.path.exists(os.path.join(out_dir, f'{r[0]}.{ext}'))]
    if args.check and missing:
        print(f'· --check 模式：{len(missing)} 条尚未落盘（正常）')
    elif missing:
        print(f'✗ 落盘后仍缺失：{missing}')
        sys.exit(1)

    # ③ realBed 条目的出处登记（**合并**进 _provenance.json，绝不覆盖 fetch-sfx.py 的记录）。
    #    ★ 为什么由 make-sfx.py 写：hybrid 床的「合成事件层」只有合成器能表达（fetch-sfx 的
    #      parts 语法做不到），所以这一条产线归合成器；但它的**底床来自下载素材**，
    #      必须让出处表如实反映 ⇒ 两个写入方共用同一份 _provenance.json，各写各的 key。
    if hybrid_prov and not args.check:
        prov_path = os.path.join(out_dir, '_provenance.json')
        old = {'entries': {}}
        if os.path.exists(prov_path):
            try:
                old = json.load(open(prov_path, encoding='utf-8'))
            except Exception:
                pass
        old.setdefault('entries', {})
        old['entries'].update(hybrid_prov)
        old['_note'] = ('fetch-sfx.py / make-sfx.py 的**联合**产出记录：这些 id 的 wav 含下载素材'
                        '（其余为纯合成）。kind=synth 走 parts、kind=hybrid 走 realBed 通道。'
                        'sha256 只存前 16 位，用于发现"有人手改过文件"的漂移。')
        old['generatedAt'] = time.strftime('%Y-%m-%d %H:%M:%S')
        open(prov_path, 'w', encoding='utf-8').write(
            json.dumps(old, ensure_ascii=False, indent=2) + '\n')
        print(f'✓ 出处记录（hybrid {len(hybrid_prov)} 条）：'
              f'{os.path.relpath(prov_path, ROOT)}')


if __name__ == '__main__':
    main()
