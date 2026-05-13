
/**
 * CHANGMO — main.js
 * Three.js r163 ESM 모듈 방식으로 완전 재작성
 * - importmap 기반 import
 * - Water, GLTFLoader, EffectComposer, RenderPass, ShaderPass 모두 ESM
 * - ALBUM 패널: 세로 리스트로 변경 (가로 드래그 제거)
 * - POOL: 밝은 하늘 + 떠있는 풀박스 + 고급 water
 * - 3→4 패널 스와이프 완전 동작
 */

import * as THREE from 'three';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader }      from 'three/addons/loaders/KTX2Loader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { initFluid,
"use strict";

// ══════════════════════════════════════════════════════
// 오디오 / 스펙트럼 상태
// ══════════════════════════════════════════════════════
const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const S = {
  sub:0, bass:0, mid:0, high:0, air:0, energy:0, beat:0,
  detail:0, transient:0, texture:0, clarity:0,
  mx: window.innerWidth * 0.5, my: window.innerHeight * 0.5,
};
const T  = {
  sub:0, bass:0, mid:0, high:0, air:0, energy:0, beat:0,
  detail:0, transient:0, texture:0, clarity:0,
};
const SM = {
  sub:.34, bass:.28, mid:.20, high:.16, air:.12, energy:.20, beat:.32,
  detail:.22, transient:.30, texture:.18, clarity:.20,
};

const LQ = {
  subPressure:0, subPressureTarget:0,
  midDensity:0,  midDensityTarget:0,
  highShimmer:0, highShimmerTarget:0,
  airGlow:0,     airGlowTarget:0,
  refractionPhase:0,
  surfaceTension:0, surfaceTensionTarget:0,
  bassShock:0,   bassShockTarget:0,
};

const MF = {
  rms:0, loudness:0, centroid:0, spread:0, flatness:0, rolloff:0, zcr:0,
  transient:0, kick:0, detail:0, clarity:0,
};

let audioCtx, analyser, freqData, timeData;
let micStream, srcNode;
let fileCreated = false, fileSrc = null;
let meydaAnalyzer = null;
let meydaSource = null;
let prevAmpSpectrum = null;
const MODE_FILE = "file", MODE_MIC = "mic";
let mode = MODE_FILE;
let isPlaying = false;
const audioEl = document.getElementById("audio-player");

function resetMeydaState() {
  prevAmpSpectrum = null;
  Object.keys(MF).forEach((key) => { MF[key] = 0; });
}

function stopFeatureAnalyzer(resetState = true) {
  if (meydaAnalyzer) {
    try { meydaAnalyzer.stop(); } catch (_) {}
    meydaAnalyzer = null;
  }
  meydaSource = null;
  if (resetState) resetMeydaState();
}

function normalizeCentroid(value) {
  return clamp01((value - 180) / 6200);
}

function normalizeSpread(value) {
  return clamp01(value / 7800);
}

function normalizeRolloff(value) {
  return clamp01(value / 14000);
}

function normalizeLoudness(value) {
  return clamp01(value / 34);
}

function computeSpectralFlux(nextSpectrum) {
  if (!Array.isArray(nextSpectrum) && !(nextSpectrum instanceof Float32Array)) return 0;
  if (!prevAmpSpectrum || prevAmpSpectrum.length !== nextSpectrum.length) {
    prevAmpSpectrum = Array.from(nextSpectrum);
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < nextSpectrum.length; i += 1) {
    const diff = nextSpectrum[i] - prevAmpSpectrum[i];
    if (diff > 0) sum += diff;
  }
  prevAmpSpectrum = Array.from(nextSpectrum);
  return clamp01((sum / nextSpectrum.length) * 18);
}

function startFeatureAnalyzer(source) {
  if (!audioCtx || !source) return;
  if (meydaSource === source && meydaAnalyzer) return;
  stopFeatureAnalyzer(false);

  if (!window.Meyda || typeof window.Meyda.createMeydaAnalyzer !== "function") {
    console.warn("Meyda is not available. Falling back to AnalyserNode-only mode.");
    return;
  }

  try {
    meydaAnalyzer = window.Meyda.createMeydaAnalyzer({
      audioContext: audioCtx,
      source,
      bufferSize: 1024,
      featureExtractors: [
        "rms",
        "zcr",
        "spectralCentroid",
        "spectralSpread",
        "spectralFlatness",
        "spectralRolloff",
        "amplitudeSpectrum",
        "loudness",
      ],
      callback: (features) => {
        if (!features) return;
        const flux = computeSpectralFlux(features.amplitudeSpectrum);
        const loudnessTotal = features.loudness && typeof features.loudness.total === "number"
          ? features.loudness.total
          : 0;
        const rms = clamp01((features.rms || 0) * 4.6);
        const zcr = clamp01((features.zcr || 0) * 1.9);
        const centroid = normalizeCentroid(features.spectralCentroid || 0);
        const spread = normalizeSpread(features.spectralSpread || 0);
        const flatness = clamp01((features.spectralFlatness || 0) * 7.5);
        const rolloff = normalizeRolloff(features.spectralRolloff || 0);
        const loudness = normalizeLoudness(loudnessTotal);

        MF.rms = rms;
        MF.zcr = zcr;
        MF.centroid = centroid;
        MF.spread = spread;
        MF.flatness = flatness;
        MF.rolloff = rolloff;
        MF.loudness = loudness;
        MF.transient = clamp01(flux * 0.78 + zcr * 0.14 + rms * 0.08);
        MF.kick = clamp01(flux * 0.54 + rms * 0.30 + loudness * 0.16);
        MF.detail = clamp01(flatness * 0.34 + rolloff * 0.28 + spread * 0.22 + flux * 0.16);
        MF.clarity = clamp01(centroid * 0.42 + rolloff * 0.28 + (1 - flatness) * 0.18 + zcr * 0.12);
      },
    });
    meydaSource = source;
    meydaAnalyzer.start();
  } catch (error) {
    console.warn("Meyda initialization failed:", error);
    stopFeatureAnalyzer();
  }
}

function ensureCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.50;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function dropSrc() {
  if (srcNode) {
    try { srcNode.disconnect(); } catch (_) {}
  }
  srcNode = null;
  stopFeatureAnalyzer();
}

function ensureFileSource() {
  ensureCtx();
  if (!fileCreated) {
    fileSrc = audioCtx.createMediaElementSource(audioEl);
    fileCreated = true;
    fileSrc.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (srcNode !== fileSrc) {
    if (srcNode) {
      try { srcNode.disconnect(); } catch (_) {}
    }
    try { fileSrc.connect(analyser); } catch (_) {}
    srcNode = fileSrc;
  }
  startFeatureAnalyzer(fileSrc);
  return fileSrc;
}

function bandRMS(lo, hi) {
  if (!analyser) return 0;
  const ny = audioCtx.sampleRate / 2, bw = ny / freqData.length;
  const li = Math.max(0, Math.floor(lo / bw));
  const hi2 = Math.min(freqData.length - 1, Math.ceil(hi / bw));
  let s = 0, n = hi2 - li + 1;
  for (let i = li; i <= hi2; i += 1) s += freqData[i] * freqData[i];
  return Math.sqrt(s / n) / 255;
}

let prevBeatSignal = 0, beatCool = 0, prevBassSignal = 0, bassHitCool = 0;
// pool 물 도입부 감지용
let _poolEnergySmooth = 0;
let _poolOnsetCool    = 0;
let _poolOnsetStrength= 0;

function analyze() {
  if (!analyser) {
    Object.keys(T).forEach((key) => { T[key] = 0; });
    return;
  }

  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);

  const sv = bandRMS(20, 70);
  const bv = bandRMS(70, 300);
  const mv = bandRMS(300, 2500);
  const hv = bandRMS(2500, 8000);
  const av = bandRMS(8000, 20000);

  const isMic = (mode === MODE_MIC);
  const subMul  = isMic ? 3.05 : 1.38;
  const bassMul = isMic ? 2.75 : 1.27;
  const midMul  = isMic ? 2.55 : 1.16;
  const highMul = isMic ? 2.35 : 1.12;
  const airMul  = isMic ? 2.10 : 1.07;

  const detailBoost = 1 + MF.detail * 0.34 + MF.clarity * 0.16;
  const transientBoost = 1 + MF.transient * 0.30 + MF.kick * 0.14;

  T.sub = clamp01(sv * subMul * (1 + MF.rms * 0.22 + MF.kick * 0.18));
  T.bass = clamp01(bv * bassMul * (1 + MF.transient * 0.18 + MF.rms * 0.16));
  T.mid = clamp01(mv * midMul * (1 + MF.clarity * 0.22 + MF.loudness * 0.12));
  T.high = clamp01(hv * highMul * (1 + MF.detail * 0.42 + MF.transient * 0.10));
  T.air = clamp01(av * airMul * (1 + MF.detail * 0.30 + MF.clarity * 0.20));
  T.detail = clamp01(MF.detail * 0.78 + MF.flatness * 0.12 + MF.rolloff * 0.10);
  T.transient = clamp01(MF.transient * 0.82 + MF.kick * 0.18);
  T.texture = clamp01(MF.spread * 0.40 + MF.flatness * 0.28 + MF.rolloff * 0.18 + T.air * 0.14);
  T.clarity = clamp01(MF.clarity * 0.72 + MF.centroid * 0.18 + MF.rolloff * 0.10);

  const rawEnergy = sv * 0.32 + bv * 0.28 + mv * 0.18 + hv * 0.12 + av * 0.10;
  T.energy = clamp01(rawEnergy * detailBoost * transientBoost + MF.rms * 0.12 + MF.loudness * 0.08);
  if (isMic) T.energy = clamp01(T.energy * 2.1);

  const beatSignal = sv * 0.54 + bv * 0.28 + T.transient * 0.20 + MF.rms * 0.10;
  const beatThresh = isMic ? 0.10 : 0.17;
  const beatDelta = isMic ? 0.022 : 0.045;
  const beatCoolMax = isMic ? 4 : 7;

  beatCool = Math.max(0, beatCool - 1);
  if (beatSignal > beatThresh && beatSignal - prevBeatSignal > beatDelta && beatCool === 0) {
    S.beat = clamp01(0.75 + T.transient * 0.40 + MF.kick * 0.20);
    beatCool = beatCoolMax;
  }
  prevBeatSignal = beatSignal;

  const bassHitSignal = bv * 0.62 + sv * 0.18 + T.transient * 0.20 + MF.rms * 0.10;
  const bassHitThresh = isMic ? 0.11 : 0.22;
  const bassHitDelta = isMic ? 0.03 : 0.055;
  const bassHitCoolMax = isMic ? 6 : 12;

  bassHitCool = Math.max(0, bassHitCool - 1);
  if (bassHitSignal > bassHitThresh && bassHitSignal - prevBassSignal > bassHitDelta && bassHitCool === 0) {
    LQ.bassShockTarget = Math.max(LQ.bassShockTarget, clamp01(0.72 + T.transient * 0.34 + MF.kick * 0.24));
    bassHitCool = bassHitCoolMax;
  }
  prevBassSignal = bassHitSignal;
}

function smooth() {
  const isMic = (mode === MODE_MIC);
  const mf = isMic ? 2.1 : 1.0;

  S.sub += (T.sub - S.sub) * SM.sub * mf;
  S.bass += (T.bass - S.bass) * SM.bass * mf;
  S.mid += (T.mid - S.mid) * SM.mid * mf;
  S.high += (T.high - S.high) * SM.high * mf;
  S.air += (T.air - S.air) * SM.air * mf;
  S.energy += (T.energy - S.energy) * SM.energy * mf;
  S.detail += (T.detail - S.detail) * SM.detail * mf;
  S.transient += (T.transient - S.transient) * SM.transient * mf;
  S.texture += (T.texture - S.texture) * SM.texture * mf;
  S.clarity += (T.clarity - S.clarity) * SM.clarity * mf;
  S.beat += (0 - S.beat) * SM.beat * (isMic ? 0.72 : 1.0);

  LQ.subPressureTarget = S.sub * (isMic ? 1.56 : 0.94) + S.bass * (isMic ? 0.52 : 0.22) + S.transient * 0.16;
  LQ.subPressure += (LQ.subPressureTarget - LQ.subPressure) * (isMic ? 0.82 : 0.62);
  LQ.subPressure += (0 - LQ.subPressure) * 0.09;

  LQ.midDensityTarget = S.mid * (isMic ? 1.34 : 0.80) + S.bass * (isMic ? 0.68 : 0.36) + S.detail * 0.12 + S.clarity * 0.12;
  LQ.midDensity += (LQ.midDensityTarget - LQ.midDensity) * (isMic ? 0.46 : 0.28);

  LQ.highShimmerTarget = S.high * (isMic ? 1.24 : 0.74) + S.air * (isMic ? 0.92 : 0.50) + S.detail * 0.34 + S.transient * 0.12;
  LQ.highShimmer += (LQ.highShimmerTarget - LQ.highShimmer) * (isMic ? 0.54 : 0.36);
  LQ.highShimmer += (0 - LQ.highShimmer) * 0.06;

  LQ.airGlowTarget = S.air * (isMic ? 1.16 : 0.66) + S.high * (isMic ? 0.88 : 0.52) + S.texture * 0.20;
  LQ.airGlow += (LQ.airGlowTarget - LQ.airGlow) * (isMic ? 0.22 : 0.12);

  LQ.surfaceTensionTarget = S.high * (isMic ? 1.04 : 0.60) + S.air * (isMic ? 0.96 : 0.56) + S.transient * 0.22 + S.detail * 0.12;
  LQ.surfaceTension += (LQ.surfaceTensionTarget - LQ.surfaceTension) * (isMic ? 0.56 : 0.40);
  LQ.surfaceTension += (0 - LQ.surfaceTension) * 0.09;

  LQ.bassShock += (LQ.bassShockTarget - LQ.bassShock) * (isMic ? 0.76 : 0.62);
  LQ.bassShock += (0 - LQ.bassShock) * (isMic ? 0.10 : 0.14);
  LQ.bassShockTarget *= (isMic ? 0.45 : 0.55);

  LQ.refractionPhase += 0.014 + S.energy * 0.035 + LQ.highShimmer * 0.024 + S.detail * 0.012;

  _poolEnergySmooth += ((S.energy + S.transient * 0.16) - _poolEnergySmooth) * (isMic ? 0.024 : 0.008);
  _poolOnsetCool = Math.max(0, _poolOnsetCool - 1);
  const _energyRise = (S.energy + S.transient * 0.20) - _poolEnergySmooth;
  const onsetThresh = isMic ? 0.022 : 0.09;
  const onsetCoolMax = isMic ? 10 : 40;
  if (_energyRise > onsetThresh && _poolOnsetCool === 0) {
    const beatSync = isMic ? (S.beat > 0.2 ? 1.8 : 1.0) : 1.0;
    _poolOnsetStrength = Math.min(1.0, (_energyRise * (isMic ? 6.8 : 3.7) + S.bass * (isMic ? 1.8 : 0.7) + S.transient * 1.1) * beatSync);
    _poolOnsetCool = onsetCoolMax;
  }
  _poolOnsetStrength *= (isMic ? 0.85 : 0.94);
}

const root = document.documentElement;
function updateCSS() {
  root.style.setProperty("--sub", S.sub.toFixed(4));
  root.style.setProperty("--bass", S.bass.toFixed(4));
  root.style.setProperty("--mid", S.mid.toFixed(4));
  root.style.setProperty("--high", S.high.toFixed(4));
  root.style.setProperty("--air", S.air.toFixed(4));
  root.style.setProperty("--energy", S.energy.toFixed(4));
  root.style.setProperty("--beat", S.beat.toFixed(4));
  root.style.setProperty("--detail", S.detail.toFixed(4));
  root.style.setProperty("--transient", S.transient.toFixed(4));
  root.style.setProperty("--texture", S.texture.toFixed(4));
  root.style.setProperty("--clarity", S.clarity.toFixed(4));
  root.style.setProperty("--mx", (S.mx - window.innerWidth * .5).toFixed(2) + "px");
  root.style.setProperty("--my", (S.my - window.innerHeight * .5).toFixed(2) + "px");
  root.style.setProperty("--lq-sub", LQ.subPressure.toFixed(4));
  root.style.setProperty("--lq-mid", LQ.midDensity.toFixed(4));
  root.style.setProperty("--lq-shimmer", LQ.highShimmer.toFixed(4));
  root.style.setProperty("--lq-air", LQ.airGlow.toFixed(4));
  root.style.setProperty("--lq-surface", LQ.surfaceTension.toFixed(4));
  root.style.setProperty("--lq-shock", LQ.bassShock.toFixed(4));
}

const hudFills = {
  sub:  document.getElementById("hud-sub-fill"),
  bass: document.getElementById("hud-bass-fill"),
  mid:  document.getElementById("hud-mid-fill"),
  high: document.getElementById("hud-high-fill"),
  air:  document.getElementById("hud-air-fill"),
};

function updateHUD() {
  const set=(el,v)=>{ if(el) el.style.width=(v*100).toFixed(1)+"%"; };
  set(hudFills.sub,S.sub); set(hudFills.bass,S.bass);
  set(hudFills.mid,S.mid); set(hudFills.high,S.high); set(hudFills.air,S.air);

  const poolSub  = document.getElementById("pool-hud-sub");
  const poolMid  = document.getElementById("pool-hud-mid");
  const poolAir  = document.getElementById("pool-hud-air");
  const beatChip = document.getElementById("pool-chip-beat");
  const waveChip = document.getElementById("pool-chip-wave");
  set(poolSub,S.sub); set(poolMid,S.mid); set(poolAir,S.air);
  if(beatChip) beatChip.classList.toggle("beat-active", S.beat > 0.48 || LQ.bassShock > 0.20);
  if(waveChip) waveChip.classList.toggle("beat-active", LQ.highShimmer > 0.20 || LQ.surfaceTension > 0.18);
}

// ── 팔레트
const PAL = {
  base: { r:110, g:90,  b:240 },
  p0:   { r:200, g:20,  b:20  }, p1:  { r:255, g:0,   b:0   },
  p2:   { r:240, g:108, b:5   }, p3:  { r:21,  g:150, b:151 },
  p4:   { r:14,  g:98,  b:132 }, p5:  { r:130, g:70,  b:255 },
  p6:   { r:90,  g:40,  b:180 }, p7:  { r:60,  g:75,  b:160 },
  p8:   { r:18,  g:55,  b:220 }, p9:  { r:95,  g:45,  b:215 },
  p10:  { r:55,  g:155, b:255 }, p11: { r:75,  g:205, b:255 },
};
let curPal = { r:110, g:90, b:240 };
let micPhase=0, micVE=0;

function lerpC(a,b,t) {
  t=Math.max(0,Math.min(1,t));
  return { r:a.r+(b.r-a.r)*t, g:a.g+(b.g-a.g)*t, b:a.b+(b.b-a.b)*t };
}
const SEG     = [0, 0.08, 0.18, 0.28, 0.40, 0.49, 0.52, 0.60, 0.69, 0.79, 0.89, 1.0];
const SEG_PAL = [PAL.p0, PAL.p1, PAL.p2, PAL.p3, PAL.p4, PAL.p5, PAL.p6, PAL.p7, PAL.p8, PAL.p9, PAL.p10, PAL.p11];

function getPalette(p) {
  for (let i=0; i<SEG.length-1; i++) {
    if (p <= SEG[i+1]) {
      const t = (p - SEG[i]) / (SEG[i+1] - SEG[i]);
      return lerpC(SEG_PAL[i], SEG_PAL[i+1], t);
    }
  }
  return PAL.p10;
}

function updatePalette() {
  let target = PAL.base;
  if (mode===MODE_FILE && audioEl.duration>0 && isPlaying) {
    target = getPalette(audioEl.currentTime / audioEl.duration);
    const pb = document.getElementById("progress-bar-inner");
    if (pb) {
      pb.style.width = (audioEl.currentTime/audioEl.duration*100).toFixed(2)+"%";
      document.getElementById("progress-bar-wrap").style.opacity="1";
    }
  } else if (mode===MODE_MIC) {
    micVE += S.energy*0.0004; micPhase += 0.00008;
    const p = Math.min(((Math.sin(micPhase*Math.PI*2)*0.5+0.5)*0.7+micVE*0.3)%1.0,1.0);
    target = getPalette(p);
    const wrap=document.getElementById("progress-bar-wrap"); if(wrap) wrap.style.opacity="0";
  } else {
    const wrap=document.getElementById("progress-bar-wrap"); if(wrap) wrap.style.opacity="0";
  }
  const spd = 0.055;
  curPal.r+=(target.r-curPal.r)*spd;
  curPal.g+=(target.g-curPal.g)*spd;
  curPal.b+=(target.b-curPal.b)*spd;
  root.style.setProperty("--palette-r", curPal.r.toFixed(0));
  root.style.setProperty("--palette-g", curPal.g.toFixed(0));
  root.style.setProperty("--palette-b", curPal.b.toFixed(0));

  // ── 배경 색상 반응: piano(2번째) & scene/albums(3번째) 패널 ──
  updatePanelBackgrounds();
}

// 패널 배경 색상 음악 반응 (은은하고 고급스러운 색 변화)
let _pianoHue = 0, _sceneHue = 0;
// 3번째 패널 리듬 색상 전환용
let _sceneColorPhase = 0;
let _sceneColorSat   = 55;
let _sceneColorLum   = 28;
let _sceneAccum      = 0;
let _scenePrevBeat   = 0;

// ── 3번 패널 — 고급스럽고 부드러운 색 변화 (곡 진행 연동) ──
let _sMoodEnergy = 0;
let _sMoodMid    = 0;
let _sMoodAir    = 0;
let _sMoodBass   = 0;
let _sBloom      = 0;
let _sHueFast    = 210;
let _sHueSlow    = 210;
let _sHueDrift   = 210;
let _sSatFast    = 32;
let _sSatSlow    = 32;
let _sLumFast    = 10;
let _sLumSlow    = 10;
let _sSceneT     = 0;
// 팔레트 연동 보조 변수
let _sPalR = 110, _sPalG = 90, _sPalB = 240;
let _sPalBloom = 0;  // 팔레트 색의 부드러운 bloom 강도

// ── 3번 패널 — 서지(물들기) 효과: 진짜 확 커지는 순간에만 은은하게 물듦 ──
let _sSurgeStrength = 0;        // 현재 서지 강도 (0~1)
let _sSurgeCool     = 0;        // 쿨다운 (프레임)
let _sSurgeEnergyBaseline = 0;  // 느린 에너지 평균 (~4초)
let _sSurgeBassBaseline   = 0;  // 느린 베이스 평균
let _sSurgePrevEnergy     = 0;
let _sSurgePrevBass       = 0;
// 서지 시 현재 팔레트에서 파생된 색 (별도 팔레트 없음 — 촌스러움 방지)
let _sSurgeTintR = 0, _sSurgeTintG = 0, _sSurgeTintB = 0;

// ── 추가 그라데이션 색상 쌍 (3번 패널 전용) ──
const SCENE_GRAD_PAIRS = [
  { a:{r:160,g:135,b:100}, b:{r:70,g:130,b:140} },   // warm muted gold → teal
  { a:{r:80,g:70,b:150},   b:{r:50,g:100,b:160} },    // muted indigo → steel blue
  { a:{r:180,g:170,b:145}, b:{r:28,g:30,b:40}   },    // warm ivory → charcoal
];
let _sGradPhase = 0;      // 색상 쌍 전환 위상
let _sGradCurA = {r:160,g:135,b:100};
let _sGradCurB = {r:70,g:130,b:140};
let _sGradBlend = 0;      // 현재 쌍의 블렌드 비율
function updatePanelBackgrounds() {
  const e = S.energy;
  const pr = curPal.r/255, pg = curPal.g/255, pb = curPal.b/255;

  // PIANO 패널 — 흰색 고정 배경 (음악 반응: 미세한 그레이 명도 변화만)
  const pianoEl = document.getElementById("panel-piano");
  if(pianoEl) {
    const pulse = (LQ.subPressure * 0.018 + LQ.midDensity * 0.012).toFixed(4);
    pianoEl.style.background = `
      radial-gradient(ellipse at 28% 58%, rgba(0,0,0,${(parseFloat(pulse) * 0.5).toFixed(4)}) 0%, transparent 52%),
      #f5f4f1
    `;
  }

  // ── SCENE(3번째) 패널 — 고급스러운 팔레트 연동 + 서지(물들기) 색변화 ──
  const sceneEl = document.getElementById("panel-scene");
  const sceneBg = document.getElementById("scene-bg");
  if(sceneEl && sceneBg) {
    _sSceneT += 0.0012;

    // 무드 평균 — 적당히 빠른 lerp (곡 변화를 잘 반영)
    _sMoodEnergy += (S.energy - _sMoodEnergy) * 0.012;
    _sMoodMid    += (S.mid    - _sMoodMid)    * 0.014;
    _sMoodAir    += (S.air    - _sMoodAir)    * 0.010;
    _sMoodBass   += (S.bass   - _sMoodBass)   * 0.012;

    // ═══════════════════════════════════════════════════════
    // 서지(물들기) — 정말 확 커지는 순간에만, 현재 팔레트 톤으로
    // ═══════════════════════════════════════════════════════
    // 느린 베이스라인 (~4초 이동평균) — 평소 수준 추적
    _sSurgeEnergyBaseline += (S.energy - _sSurgeEnergyBaseline) * 0.004;
    _sSurgeBassBaseline   += (S.bass   - _sSurgeBassBaseline)   * 0.005;
    _sSurgeCool = Math.max(0, _sSurgeCool - 1);

    // 베이스라인 대비 상승폭 (순간 변화율은 제외 — 노이즈 감소)
    const energyRise = Math.max(0, S.energy - _sSurgeEnergyBaseline);
    const bassRise   = Math.max(0, S.bass   - _sSurgeBassBaseline);

    // 서지 점수: 베이스라인 대비 큰 차이 + beat/bassShock 동기화
    const surgeScore = energyRise * 1.8 + bassRise * 2.2
                     + (S.beat > 0.6 ? S.beat * 0.8 : 0)
                     + (LQ.bassShock > 0.4 ? LQ.bassShock * 1.0 : 0);

    const isMicS = (mode === MODE_MIC);
    // 높은 임계값 = 정말 큰 순간에만 발동
    const surgeThreshold = isMicS ? 0.65 : 0.90;
    // 긴 쿨다운 = 자주 안 바뀜 (약 1.5~2.5초)
    const surgeCoolMax   = isMicS ? 55   : 80;

    if (surgeScore > surgeThreshold && _sSurgeCool === 0) {
      const intensity = Math.min(1.0, (surgeScore - surgeThreshold) * 1.2 + 0.25);
      _sSurgeStrength = Math.max(_sSurgeStrength, intensity);

      // 현재 팔레트 색에서 파생: 채도를 살짝 올리고 밝기를 높임 (별도 색 없음)
      _sSurgeTintR = Math.min(255, curPal.r * 1.3 + 30);
      _sSurgeTintG = Math.min(255, curPal.g * 1.2 + 20);
      _sSurgeTintB = Math.min(255, curPal.b * 1.3 + 30);

      _sSurgeCool = surgeCoolMax;
    }

    // 서지 강도 감쇠 — 아주 천천히 빠짐 (6~10초에 걸쳐 은은하게 사라짐)
    _sSurgeStrength *= 0.992;
    if (_sSurgeStrength < 0.003) _sSurgeStrength = 0;

    _sSurgePrevEnergy = S.energy;
    _sSurgePrevBass   = S.bass;

    // 팔레트 색상 부드럽게 추적 (곡 진행에 따른 색 변화의 핵심)
    _sPalR += (curPal.r - _sPalR) * 0.018;
    _sPalG += (curPal.g - _sPalG) * 0.018;
    _sPalB += (curPal.b - _sPalB) * 0.018;

    // 팔레트 bloom — 서지 시 은은하게 강화
    const bloomTarget = 0.20 + _sMoodEnergy * 0.40 + _sMoodMid * 0.16 + _sMoodBass * 0.12
                      + _sSurgeStrength * 0.18;
    _sPalBloom += (bloomTarget - _sPalBloom) * 0.022;

    // 색조 목표 — 팔레트 RGB에서 Hue 추출 + 시간 흐름
    const palMax = Math.max(_sPalR, _sPalG, _sPalB);
    const palMin = Math.min(_sPalR, _sPalG, _sPalB);
    const palDelta = palMax - palMin;
    let palHue = 210;
    if(palDelta > 5) {
      if(palMax === _sPalR) palHue = 60 * (((_sPalG - _sPalB) / palDelta) % 6);
      else if(palMax === _sPalG) palHue = 60 * ((_sPalB - _sPalR) / palDelta + 2);
      else palHue = 60 * ((_sPalR - _sPalG) / palDelta + 4);
      if(palHue < 0) palHue += 360;
    }

    // 기본 싸이클 + 팔레트 Hue 혼합
    const cycleHue  = 200 + Math.sin(_sSceneT * 1.2) * 35
                    + Math.sin(_sSceneT * 0.45) * 15;
    const palWeight = 0.35 + _sMoodEnergy * 0.45;
    const blendedHue = cycleHue * (1 - palWeight) + palHue * palWeight;
    const moodShift = _sMoodEnergy * 22 - _sMoodAir * 12 + _sMoodBass * 14;
    _sHueDrift += (blendedHue + moodShift - _sHueDrift) * 0.008;

    // 채도 — 서지 시 살짝만 올라감
    const satTarget = 30 + _sMoodEnergy * 32 + _sMoodMid * 14 + _sMoodAir * 10
                    + _sSurgeStrength * 16;
    // 명도 — 서지 시 은은하게 밝아짐
    const lumTarget = 10 + _sMoodEnergy * 22 + _sMoodMid * 14 + _sMoodBass * 6
                    + _sSurgeStrength * 10;

    // 부드러운 lerp — 서지 시 약간 더 빠르게 (하지만 절제)
    const hueLerpSpeed = 0.020 + _sSurgeStrength * 0.025;
    const satLerpSpeed = 0.025 + _sSurgeStrength * 0.03;
    const lumLerpSpeed = 0.022 + _sSurgeStrength * 0.03;
    _sHueFast += (_sHueDrift - _sHueFast) * hueLerpSpeed;
    _sHueSlow += (_sHueFast  - _sHueSlow) * 0.008;
    _sSatFast += (satTarget  - _sSatFast) * satLerpSpeed;
    _sSatSlow += (_sSatFast  - _sSatSlow) * 0.012;
    _sLumFast += (lumTarget  - _sLumFast) * lumLerpSpeed;
    _sLumSlow += (_sLumFast  - _sLumSlow) * 0.010;

    const hF  = _sHueFast;
    const hS  = _sHueSlow;
    const h2  = hF - 28;
    const h3  = hS + 22;
    const h4  = hF + 45;
    const sF  = _sSatFast.toFixed(1);
    const sS  = _sSatSlow.toFixed(1);
    const lF  = _sLumFast.toFixed(1);
    const lS  = _sLumSlow.toFixed(1);
    const lD  = Math.max(4, _sLumSlow - 2).toFixed(1);
    const lBright = Math.min(40, _sLumFast * 1.5).toFixed(1);

    // 투명도 — 팔레트 bloom + 서지 은은하게
    const surgeAlphaBoost = _sSurgeStrength * 0.20;
    const g1  = (0.62 + _sMoodEnergy * 0.30 + _sPalBloom * 0.25 + surgeAlphaBoost).toFixed(3);
    const g2  = (0.40 + _sMoodBass   * 0.28 + _sPalBloom * 0.18 + surgeAlphaBoost * 0.5).toFixed(3);
    const g3  = (0.28 + _sMoodAir    * 0.22 + _sPalBloom * 0.12 + surgeAlphaBoost * 0.3).toFixed(3);

    // 팔레트 RGB 직접 그라디언트
    const pR = Math.floor(_sPalR), pG = Math.floor(_sPalG), pB = Math.floor(_sPalB);
    const palGlowA = (_sPalBloom * 0.38 + _sMoodEnergy * 0.12).toFixed(3);
    const palGlowA2 = (_sPalBloom * 0.22 + _sMoodMid * 0.08).toFixed(3);

    // ── 서지 물들기: 현재 팔레트 파생 색 1겹, 은은하게 ──
    const sgStr = _sSurgeStrength;
    const sgR = Math.floor(_sSurgeTintR);
    const sgG = Math.floor(_sSurgeTintG);
    const sgB = Math.floor(_sSurgeTintB);
    // 서지 알파: 최대 0.38 — 은은하게 물드는 느낌
    const sgAlpha = (sgStr * 0.38).toFixed(3);

    // ── 추가 그라데이션 쌍 사이클링 ──
    _sGradPhase += 0.0008 + _sMoodEnergy * 0.002;
    const gradIdx = Math.floor(_sGradPhase) % SCENE_GRAD_PAIRS.length;
    const gradNext = (gradIdx + 1) % SCENE_GRAD_PAIRS.length;
    const gradT = _sGradPhase % 1;
    const curPair = SCENE_GRAD_PAIRS[gradIdx];
    const nxtPair = SCENE_GRAD_PAIRS[gradNext];
    const lG = (a,b,t) => ({r:a.r+(b.r-a.r)*t, g:a.g+(b.g-a.g)*t, b:a.b+(b.b-a.b)*t});
    const gA = lG(curPair.a, nxtPair.a, gradT);
    const gB = lG(curPair.b, nxtPair.b, gradT);
    _sGradCurA.r += (gA.r - _sGradCurA.r) * 0.015;
    _sGradCurA.g += (gA.g - _sGradCurA.g) * 0.015;
    _sGradCurA.b += (gA.b - _sGradCurA.b) * 0.015;
    _sGradCurB.r += (gB.r - _sGradCurB.r) * 0.015;
    _sGradCurB.g += (gB.g - _sGradCurB.g) * 0.015;
    _sGradCurB.b += (gB.b - _sGradCurB.b) * 0.015;
    const gaR = Math.floor(_sGradCurA.r), gaG = Math.floor(_sGradCurA.g), gaB = Math.floor(_sGradCurA.b);
    const gbR = Math.floor(_sGradCurB.r), gbG = Math.floor(_sGradCurB.g), gbB = Math.floor(_sGradCurB.b);
    const gradAlpha = (0.22 + _sMoodEnergy * 0.30 + _sPalBloom * 0.18).toFixed(3);
    const gradAlpha2 = (0.16 + _sMoodBass * 0.22 + _sMoodMid * 0.12).toFixed(3);

    sceneEl.style.background = '#020406';
    sceneBg.style.background = `
      ${sgStr > 0.02 ? `radial-gradient(ellipse 100% 90% at 50% 42%,
        rgba(${sgR},${sgG},${sgB},${sgAlpha}) 0%, transparent 65%),` : ''}
      radial-gradient(ellipse 80% 70% at 50% 38%,
        hsla(${hF.toFixed(1)},${sF}%,${lF}%,${g1}) 0%, transparent 68%),
      radial-gradient(ellipse 70% 60% at 52% 44%,
        rgba(${pR},${pG},${pB},${palGlowA}) 0%, transparent 60%),
      radial-gradient(ellipse 75% 65% at 28% 32%,
        rgba(${gaR},${gaG},${gaB},${gradAlpha}) 0%, transparent 62%),
      radial-gradient(ellipse 70% 55% at 78% 68%,
        rgba(${gbR},${gbG},${gbB},${gradAlpha2}) 0%, transparent 58%),
      radial-gradient(ellipse 90% 75% at 48% 40%,
        hsla(${hS.toFixed(1)},${sS}%,${lS}%,${(+g1 * 0.40).toFixed(3)}) 0%, transparent 72%),
      radial-gradient(ellipse 45% 38% at 14% 78%,
        hsla(${h2.toFixed(1)},${sF}%,${lBright}%,${g2}) 0%, transparent 58%),
      radial-gradient(ellipse 40% 35% at 86% 18%,
        hsla(${h3.toFixed(1)},${sS}%,${lS}%,${(+g2 * 0.65).toFixed(3)}) 0%, transparent 52%),
      radial-gradient(ellipse 35% 28% at 75% 72%,
        rgba(${pR},${pG},${pB},${palGlowA2}) 0%, transparent 50%),
      radial-gradient(ellipse 30% 22% at 50% 94%,
        hsla(${h4.toFixed(1)},${(+sF * 0.8).toFixed(1)}%,${lD}%,${g3}) 0%, transparent 48%),
      linear-gradient(135deg,
        rgba(${gaR},${gaG},${gaB},${(+gradAlpha * 0.18).toFixed(3)}) 0%,
        transparent 45%,
        rgba(${gbR},${gbG},${gbB},${(+gradAlpha2 * 0.14).toFixed(3)}) 100%),
      #020406
    `;

    // scene-depth-layer 팔레트 tint
    const depthEl = document.getElementById("scene-depth");
    if(depthEl) {
      depthEl.style.filter = `hue-rotate(${(hF - 210).toFixed(1)}deg) saturate(${(1.0 + _sPalBloom * 0.6 + sgStr * 0.3).toFixed(2)})`;
    }
  }
}

// ── 2D Overlay
const ovCv = document.getElementById("overlay-canvas");
let ovCtx;
const HLINES = Array.from({length:14},(_,i)=>({
  y:(i+1)/15, phase:Math.random()*Math.PI*2, speed:0.18+Math.random()*0.22,
  band:["mid","mid","high","air","mid","bass","mid","high","air","mid","bass","mid","high","air"][i],
  thickness:i%3===0?1.2:0.7,
}));
const beatRings=[];
const VLINES=Array.from({length:7},(_,i)=>({x:(i+1)/8,phase:Math.random()*Math.PI*2,speed:0.12+Math.random()*0.16}));

function initOverlay(){ ovCtx=ovCv.getContext("2d"); resizeOverlay(); }
function resizeOverlay(){
  const dpr=window.devicePixelRatio||1;
  ovCv.width=window.innerWidth*dpr; ovCv.height=window.innerHeight*dpr;
  if(ovCtx) ovCtx.scale(dpr,dpr);
}
let ovTime=0;

function drawOverlay(){
  if(!ovCtx) return;
  const W=window.innerWidth,H=window.innerHeight;
  ovTime+=0.016;
  ovCtx.clearRect(0,0,W,H);
  const cx=W*.5,cy=H*.48;
  const pr=curPal.r,pg=curPal.g,pb=curPal.b;
  const eBoost=S.energy*S.energy;
  const palFade=0.20+eBoost*0.65;
  const isMicOv = (mode === MODE_MIC);
  const micBoost = isMicOv ? 2.8 : 1.0; // 마이크 모드 선 반응 증폭

  HLINES.forEach(l=>{
    const bv=S[l.band]||0;
    const lqVal = l.band==='air'||l.band==='high' ? LQ.airGlow*0.7+LQ.highShimmer*0.5 : LQ.midDensity*0.6+bv*0.5;
    const al=(0.016+bv*0.085*micBoost+lqVal*0.055*micBoost)*(0.5+0.5*Math.sin(ovTime*l.speed*2+l.phase))*palFade;
    if(al<0.004) return;
    const y=l.y*H;
    const waMid=LQ.midDensity*H*0.014*micBoost;
    const waHigh=LQ.surfaceTension*H*0.006*micBoost*Math.sin(ovTime*8+l.phase);
    const wa=(bv*H*0.012*micBoost)+waMid+waHigh;
    ovCtx.beginPath();
    ovCtx.strokeStyle=`rgba(${pr},${pg},${pb},${Math.min(al*micBoost,0.6).toFixed(3)})`;
    ovCtx.lineWidth=l.thickness*(0.8+LQ.midDensity*0.4*micBoost);
    for(let x=0;x<=W;x+=3){
      const wBase=wa*Math.sin(x/W*Math.PI*6+ovTime*l.speed*3+l.phase);
      const wShim=LQ.highShimmer*H*0.003*micBoost*Math.sin(x/W*Math.PI*22+ovTime*14+l.phase*2);
      if(x===0) ovCtx.moveTo(x,y+wBase+wShim); else ovCtx.lineTo(x,y+wBase+wShim);
    }
    ovCtx.stroke();
  });

  if(S.beat>0.5&&(beatRings.length===0||beatRings[beatRings.length-1].age>8))
    beatRings.push({cx,cy,r:0,maxR:Math.max(W,H)*0.72,age:0,strength:S.beat*(isMicOv?1.4:1.0)});
  for(let i=beatRings.length-1;i>=0;i--){
    const ring=beatRings[i];
    ring.r+=(ring.maxR-ring.r)*0.048; ring.age++;
    const prog=ring.r/ring.maxR;
    const al=ring.strength*(1-prog)*(1-prog)*(1-prog)*0.20*palFade;
    if(al<0.0025||ring.age>110){beatRings.splice(i,1);continue;}
    ovCtx.beginPath();
    ovCtx.arc(cx,cy,ring.r,0,Math.PI*2);
    ovCtx.strokeStyle=`rgba(${pr},${pg},${pb},${al.toFixed(3)})`;
    ovCtx.lineWidth=(1-prog)*2.2;
    ovCtx.stroke();
  }

  const sp=LQ.subPressure*0.8+S.sub*0.35;
  const spMic = isMicOv ? sp * 2.5 : sp;
  if(spMic>0.025) VLINES.forEach(l=>{
    const al=spMic*0.072*(0.5+0.5*Math.sin(ovTime*l.speed+l.phase))*palFade;
    if(al<0.004) return;
    const x=l.x*W;
    const wa=spMic*W*0.006+LQ.bassShock*W*0.003*(isMicOv?2.0:1.0);
    ovCtx.beginPath();
    ovCtx.strokeStyle=`rgba(${pr},${pg},${pb},${Math.min(al,0.5).toFixed(3)})`;
    ovCtx.lineWidth=0.6+(isMicOv?LQ.subPressure*0.6:0);
    for(let y=0;y<=H;y+=4){
      const w=wa*Math.sin(y/H*Math.PI*4+ovTime*l.speed*2+l.phase);
      if(y===0) ovCtx.moveTo(x+w,y); else ovCtx.lineTo(x+w,y);
    }
    ovCtx.stroke();
  });

  if(analyser&&timeData&&S.energy>0.012){
    analyser.getByteTimeDomainData(timeData);
    const wfAl=(0.14+S.energy*0.32*micBoost+LQ.midDensity*0.16*micBoost)*palFade;
    const wfY=H*0.89, wfAmp=H*0.058*(0.4+S.energy*0.7*micBoost), step=W/timeData.length;
    ovCtx.beginPath();
    ovCtx.strokeStyle=`rgba(${pr},${pg},${pb},${wfAl.toFixed(3)})`;
    ovCtx.lineWidth=1.1;
    for(let i=0;i<timeData.length;i++){
      const v=(timeData[i]/128.0-1.0)*wfAmp, x=i*step, y=wfY+v;
      if(i===0) ovCtx.moveTo(x,y); else ovCtx.lineTo(x,y);
    }
    ovCtx.stroke();
  }
}

// ── WebGL Shader (배경 전체)
const VERT=`attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=a_pos*.5+.5;gl_Position=vec4(a_pos,0.,1.);}`;
const FRAG=`
precision highp float;
varying vec2 v_uv;
uniform vec2 u_res;uniform float u_time,u_sub,u_bass,u_mid,u_high,u_air,u_energy;
uniform vec2 u_mouse;uniform vec3 u_palette;
uniform float u_lq_sub,u_lq_mid,u_lq_shimmer,u_lq_air,u_lq_surface;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));vec2 u=f*f*(3.-2.*f);return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.;a*=.5;}return v;}
void main(){
  vec2 p=v_uv-.5;p.x*=u_res.x/u_res.y;
  vec2 m=u_mouse-.5;m.x*=u_res.x/u_res.y;
  float t=u_time*0.20,dist=length(p-m*0.09);
  vec2 warp=p;
  warp+=0.022*sin(5.0*p.yx+u_time*0.85);
  warp+=0.065*u_lq_sub*normalize(p+0.0001)*(0.5+0.5*sin(dist*14.0-u_time*1.8));
  warp+=0.038*u_lq_mid*vec2(fbm(p*2.1+vec2(0.,t)),fbm(p*2.1-vec2(t,0.)));
  warp+=0.012*u_lq_shimmer*vec2(sin(p.y*18.0+u_time*5.5),cos(p.x*18.0+u_time*4.8));
  float n1=fbm(warp*2.8+vec2(0.,t)),n2=fbm(warp*4.0-vec2(t*0.65,0.));
  float eBoost=u_energy*u_energy;
  float haze=smoothstep(0.18,1.25,1.28-dist+n1*0.26);
  float core=0.12/(dist+0.16);core*=0.32+u_lq_sub*0.82+eBoost*0.65;
  float ring=smoothstep(0.42+u_lq_sub*0.07,0.12,dist);
  float shimmer=sin((dist-u_time*0.20)*42.)*0.5+0.5;ring*=mix(0.35,1.0,shimmer*u_lq_shimmer);
  float takeover=smoothstep(1.15,0.18,dist+n2*0.11);takeover*=0.10+eBoost*0.70;
  float beamsV=smoothstep(0.92,0.,abs(p.x+sin(p.y*5.+t)*0.055));beamsV*=(0.020+u_lq_mid*0.16)*eBoost;
  float beamsH=smoothstep(0.88,0.,abs(p.y+cos(p.x*4.+t*1.1)*0.035));beamsH*=(0.012+u_lq_air*0.10)*eBoost;
  float edgeD=length(p),edge=smoothstep(0.55,0.80,edgeD)*smoothstep(1.10,0.75,edgeD);
  edge*=0.020+u_lq_air*0.16+u_lq_shimmer*0.08+u_lq_surface*0.06;
  vec3 bg=vec3(0.010,0.012,0.028),blue=vec3(0.40,0.52,0.95),violet=vec3(0.52,0.42,0.98),silver=vec3(0.84,0.88,1.00),cold=vec3(0.60,0.75,1.00);
  vec3 pal=u_palette;
  vec3 bB=mix(blue,pal,0.55),vB=mix(violet,pal,0.50);
  vec3 color=bg;
  color+=haze*mix(bB,vB,n1)*(0.045+u_lq_mid*0.12+eBoost*0.14);
  color+=core*mix(bB,silver,0.42);
  color+=ring*mix(vB,silver,0.32)*(0.06+u_lq_shimmer*0.18+eBoost*0.12);
  color+=takeover*mix(bB,vB,n2)*0.18;
  color+=beamsV*silver*0.10+beamsH*vB*0.06+edge*mix(cold,silver,0.4);
  color+=u_lq_air*0.024*mix(cold,silver,0.5)*smoothstep(0.85,0.0,edgeD);
  color*=smoothstep(1.30,0.22,length(p));
  color=pow(max(color,vec3(0.)),vec3(0.90));
  gl_FragColor=vec4(color,1.);
}`;


let gl,prog;
let glContextLost=false;
let glCanvasBound=false;
let uRes,uTime,uSub,uBass,uMid,uHigh,uAir,uEnergy,uMouse,uPalette;
let uLqSub,uLqMid,uLqShimmer,uLqAir,uLqSurface;
let t0;

function initGL(){
  const cv=document.getElementById("glcanvas");
  if(!cv) return false;

  if(!glCanvasBound){
    cv.addEventListener("webglcontextlost",(e)=>{
      e.preventDefault();
      glContextLost=true;
    },false);

    cv.addEventListener("webglcontextrestored",()=>{
      glContextLost=false;
      gl=null;
      prog=null;
      initGL();
      resizeGL();
    },false);

    glCanvasBound=true;
  }

  gl=cv.getContext("webgl",{ alpha:true, antialias:false, powerPreference:"high-performance", preserveDrawingBuffer:false })||
     cv.getContext("experimental-webgl",{ alpha:true, antialias:false, powerPreference:"high-performance", preserveDrawingBuffer:false });

  if(!gl){ console.error("WebGL없음"); return false; }

  const verts=new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]);
  const buf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,verts,gl.STATIC_DRAW);

  const mkS=(type,src)=>{
    const s=gl.createShader(type);
    gl.shaderSource(s,src);
    gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  };

  prog=gl.createProgram();
  gl.attachShader(prog,mkS(gl.VERTEX_SHADER,VERT));
  gl.attachShader(prog,mkS(gl.FRAGMENT_SHADER,FRAG));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){
    console.error(gl.getProgramInfoLog(prog));
    return false;
  }

  gl.useProgram(prog);
  const loc=gl.getAttribLocation(prog,"a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);

  uRes=gl.getUniformLocation(prog,"u_res");
  uTime=gl.getUniformLocation(prog,"u_time");
  uSub=gl.getUniformLocation(prog,"u_sub");
  uBass=gl.getUniformLocation(prog,"u_bass");
  uMid=gl.getUniformLocation(prog,"u_mid");
  uHigh=gl.getUniformLocation(prog,"u_high");
  uAir=gl.getUniformLocation(prog,"u_air");
  uEnergy=gl.getUniformLocation(prog,"u_energy");
  uMouse=gl.getUniformLocation(prog,"u_mouse");
  uPalette=gl.getUniformLocation(prog,"u_palette");
  uLqSub=gl.getUniformLocation(prog,"u_lq_sub");
  uLqMid=gl.getUniformLocation(prog,"u_lq_mid");
  uLqShimmer=gl.getUniformLocation(prog,"u_lq_shimmer");
  uLqAir=gl.getUniformLocation(prog,"u_lq_air");
  uLqSurface=gl.getUniformLocation(prog,"u_lq_surface");

  t0=performance.now();
  resizeGL();
  return true;
}

function resizeGL(){
  const cv=document.getElementById("glcanvas");
  if(!cv) return;
  cv.width=window.innerWidth;
  cv.height=window.innerHeight;
  if(gl && !glContextLost) gl.viewport(0,0,cv.width,cv.height);
}

function renderGL(){
  if(!gl||!prog||glContextLost) return;
  const t=(performance.now()-t0)*0.001;
  gl.uniform2f(uRes,window.innerWidth,window.innerHeight);
  gl.uniform1f(uTime,t);
  gl.uniform1f(uSub,S.sub);
  gl.uniform1f(uBass,S.bass);
  gl.uniform1f(uMid,S.mid);
  gl.uniform1f(uHigh,S.high);
  gl.uniform1f(uAir,S.air);
  gl.uniform1f(uEnergy,S.energy);
  gl.uniform2f(uMouse,S.mx/window.innerWidth,1.-S.my/window.innerHeight);
  gl.uniform3f(uPalette,curPal.r/255,curPal.g/255,curPal.b/255);
  gl.uniform1f(uLqSub,LQ.subPressure);
  gl.uniform1f(uLqMid,LQ.midDensity);
  gl.uniform1f(uLqShimmer,LQ.highShimmer);
  gl.uniform1f(uLqAir,LQ.airGlow);
  gl.uniform1f(uLqSurface,LQ.surfaceTension);
  gl.drawArrays(gl.TRIANGLES,0,6);
}


// ══════════════════════════════════════════════════════
// 레이아웃 — 4패널 400vw
// ══════════════════════════════════════════════════════
const mc=document.getElementById("main-container");
const LS={hIdx:0,vIdx:0,hOff:0,vOff:0,cHoff:0,cVoff:0,anim:false};
const TOTAL_H=4, TOTAL_V=10;

function goTo(hIdx,vIdx){
  if(LS.anim) return;
  hIdx=Math.max(0,Math.min(TOTAL_H-1,hIdx));
  vIdx=Math.max(0,Math.min(TOTAL_V-1,vIdx));
  if(hIdx>=1) vIdx=0;
  if(vIdx>0)   hIdx=0;
  LS.hIdx=hIdx; LS.vIdx=vIdx;
  LS.hOff=hIdx*window.innerWidth; LS.vOff=vIdx*window.innerHeight;
  document.body.dataset.hIdx = hIdx;
  animateLayout(); updateActiveGLB(vIdx);

  const hint=document.getElementById("scroll-hint");
  if(hint) hint.style.opacity=(vIdx===0&&hIdx===0)?"":"0";

  const sh=document.getElementById("swipe-hint");
  if(sh){
    const isLastSection = (vIdx===TOTAL_V-1 && hIdx===0);
    if(isLastSection) sh.classList.add("visible");
    else sh.classList.remove("visible");
  }
  if(hIdx===2){ startSceneRenderer(); initAlbumPanel(); }
  poolActive = (hIdx===3);
  if(hIdx===3){ startPoolRenderer(); }

  // 브랜드 색상 — 피아노 패널(hIdx 1)일 때 빨간색
  const brand = document.querySelector(".brand");
  if(brand){
    brand.style.color = hIdx===1 ? "rgba(185,28,28,0.92)" : "";
    brand.style.textShadow = hIdx===1
      ? "0 0 18px rgba(185,28,28,0.22)"
      : "";
    brand.style.transition = "color 0.5s ease, text-shadow 0.5s ease";
  }
}

function animateLayout(){
  const fH=LS.cHoff,fV=LS.cVoff,tH=LS.hOff,tV=LS.vOff,t0s=performance.now();
  LS.anim=true;
  function step(now){
    const p=Math.min((now-t0s)/680,1),e=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
    LS.cHoff=fH+(tH-fH)*e; LS.cVoff=fV+(tV-fV)*e;
    mc.style.transform=`translate(${-LS.cHoff}px,${-LS.cVoff}px)`;
    if(p<1) requestAnimationFrame(step);
    else{LS.anim=false;LS.cHoff=tH;LS.cVoff=tV;}
  }
  requestAnimationFrame(step);
}

let wAccum=0,txS=0,tyS=0,navCooldown=false,lastWheelTime=0;
function triggerNav(fn){
  if(LS.anim||navCooldown) return;
  navCooldown=true; wAccum=0; fn();
  setTimeout(()=>{navCooldown=false;wAccum=0;},1050);
}

// 덱 넘기기 쿨다운 (스크롤/스와이프 연속 입력 방지)
let deckNavCool=false;
function triggerDeckNav(dir){
  // dir: +1 = 다음 카드, -1 = 이전 카드
  if(deckNavCool) return;
  deckNavCool=true;
  const total=ALBUM_DATA.length;
  selectedIdx=-1;
  deckTopIdx=(deckTopIdx+dir+total)%total;
  layoutDeck();
  showDeckDetail(deckTopIdx);
  setTimeout(()=>{ deckNavCool=false; },800);
}

function bindLayoutEvents(){
  window.addEventListener("wheel",(e)=>{
    if(LS.anim||navCooldown){wAccum=0;return;}
    const dx=e.deltaX,dy=e.deltaY;

    // ── ALBUM 패널(hIdx===2): wheel을 덱 넘기기로 사용, 패널 전환 차단 ──
    if(LS.hIdx===2){
      // 세로/가로 모두 덱 넘기기
      const dominant = Math.abs(dx)>Math.abs(dy) ? dx : dy;
      if(Math.abs(dominant)>100){
        triggerDeckNav(dominant>0?1:-1);
      }
      return; // 패널 전환 완전 차단
    }

    // 가로 스와이프 (다른 패널)
    if(Math.abs(dx)>Math.abs(dy)+10){
      const threshold = 40;
      if(dx>threshold)  triggerNav(()=>goTo(LS.hIdx+1,0));
      if(dx<-threshold) triggerNav(()=>goTo(LS.hIdx-1,LS.vIdx));
      return;
    }

    if(Math.abs(dy)<8) return;
    const now=Date.now();
    if(now-lastWheelTime<60){lastWheelTime=now;return;}
    lastWheelTime=now;
    if(LS.hIdx>=1) return;
    wAccum+=dy;
    if(Math.abs(wAccum)>55){
      const dir=wAccum>0?1:-1;
      triggerNav(()=>goTo(0,LS.vIdx+dir));
    }
  },{passive:true});

  window.addEventListener("touchstart",(e)=>{
    txS=e.touches[0].clientX;
    tyS=e.touches[0].clientY;
  },{passive:true});

  window.addEventListener("touchend",(e)=>{
    if(LS.anim||navCooldown) return;
    const dx=e.changedTouches[0].clientX-txS;
    const dy=e.changedTouches[0].clientY-tyS;

    // ── ALBUM 패널: 스와이프로 덱 넘기기, 패널 전환 차단 ──
    if(LS.hIdx===2){
      if(Math.abs(dx)>90){
        triggerDeckNav(dx<0?1:-1);
      } else if(Math.abs(dy)>90){
        triggerDeckNav(dy<0?1:-1);
      }
      return;
    }

    if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>70){
      if(dx<0) triggerNav(()=>goTo(LS.hIdx+1,0));
      else     triggerNav(()=>goTo(LS.hIdx-1,LS.vIdx));
    } else if(Math.abs(dy)>45&&LS.hIdx===0){
      triggerNav(()=>goTo(0,LS.vIdx+(dy<0?1:-1)));
    }
  },{passive:true});

  window.addEventListener("keydown",(e)=>{
    // ALBUM 패널에서는 좌우/상하 화살표 = 덱 넘기기
    if(LS.hIdx===2){
      if(e.key==="ArrowRight"||e.key==="ArrowDown")  { triggerDeckNav(1);  return; }
      if(e.key==="ArrowLeft" ||e.key==="ArrowUp")    { triggerDeckNav(-1); return; }
      // Escape / Backspace로만 패널 이탈
      if(e.key==="Escape"||e.key==="Backspace") triggerNav(()=>goTo(LS.hIdx-1,0));
      return;
    }
    if(e.key==="ArrowRight") triggerNav(()=>goTo(LS.hIdx+1,0));
    if(e.key==="ArrowLeft")  triggerNav(()=>goTo(LS.hIdx-1,LS.vIdx));
    if(e.key==="ArrowDown")  triggerNav(()=>goTo(0,LS.vIdx+1));
    if(e.key==="ArrowUp")    triggerNav(()=>goTo(0,LS.vIdx-1));
  });

  document.querySelectorAll(".back-hint").forEach(bh=>{
    // album/pool 전용 back 버튼은 별도 핸들러 사용
    if(bh.id==='album-back-btn') return;
    bh.addEventListener("click",()=>{
      // 현재 패널에서 이전 패널로 이동
      if(LS.hIdx>0) triggerNav(()=>goTo(LS.hIdx-1,0));
      else triggerNav(()=>goTo(0,0));
    });
  });

  // down 힌트 — 다음 섹션으로 이동
  document.querySelectorAll(".down-hint").forEach(dh=>{
    dh.addEventListener("click",()=>{
      if(LS.hIdx===0) triggerNav(()=>goTo(0,LS.vIdx+1));
    });
  });

  const brand = document.querySelector(".brand");
  if(brand){
    brand.style.cursor = "pointer";
    brand.addEventListener("click", ()=>{ location.reload(); });
  }
}

// ══════════════════════════════════════════════════════
// GLB 렌더러
// ══════════════════════════════════════════════════════
// 1D 댐핑 탄성 스프링(오버슈트가 자연스럽게 생기도록)
class Spring {
  /**
   * Critically-tuned spring with semi-implicit Euler + sub-stepping.
   * Produces controlled overshoot that feels hand-tweaked, not bouncy.
   *
   * @param {number} value      – initial position
   * @param {number} velocity   – initial velocity
   * @param {number} stiffness  – spring constant k  (higher = snappier)
   * @param {number} damping    – viscous drag c      (higher = less overshoot)
   * @param {number} mass       – inertia             (higher = sluggish)
   * @param {number} precision  – sleep threshold (avoids micro-jitter)
   */
  constructor({
    value = 0, velocity = 0,
    stiffness = 170, damping = 20, mass = 1,
    precision = 0.0001,
  } = {}) {
    this.x = value;
    this.v = velocity;
    this.k = stiffness;
    this.c = damping;
    this.m = mass;
    this.precision = precision;
    this._settled = false;
  }

  update(target, dt) {
    if (!dt || dt <= 0) return this.x;

    // Sub-step: cap each step at 4 ms for numerical stability
    const SUB = 0.004;
    let remaining = Math.min(dt, 0.064);   // hard-cap total delta
    while (remaining > 0) {
      const h = Math.min(remaining, SUB);
      // Semi-implicit Euler: update velocity first, then position
      const displacement = this.x - target;
      const springForce  = -this.k * displacement;
      const dampForce    = -this.c * this.v;
      const a = (springForce + dampForce) / this.m;
      this.v += a * h;
      this.x += this.v * h;
      remaining -= h;
    }

    // Sleep when close enough — prevents perpetual micro-vibration
    if (Math.abs(this.x - target) < this.precision &&
        Math.abs(this.v) < this.precision) {
      this.x = target;
      this.v = 0;
      this._settled = true;
    } else {
      this._settled = false;
    }

    return this.x;
  }

  /** Hard-set without spring transition */
  set(value) {
    this.x = value;
    this.v = 0;
    this._settled = false;
  }

  /** Inject an impulse (additive velocity kick) */
  impulse(force) {
    this.v += force / this.m;
    this._settled = false;
  }

  get settled() { return this._settled; }
}

// ══════════════════════════════════════════════════════
// 스피너 시스템 — 손으로 돌리기 (담배떨이, 20201)
// ══════════════════════════════════════════════════════
function initSpinner(entry, glbFile) {
  const isFriction = (glbFile === '20201.glb');
  entry._spinner = {
    enabled: true,
    mode: isFriction ? 'friction' : 'spring',
    sensitivity: isFriction ? 0.005 : 0.012,
    dragging: false,
    dragLastX: 0,
    dragStartX: 0,
    // ── 핵심: 매 프레임 회전 속도 (per-frame increment) ──
    spinVel: 0,            // 현재 스피너 각속도
    spinVelSpring: isFriction ? null : new Spring({
      value: 0,
      stiffness: 80,
      damping: 8,
      mass: 1.2,
      precision: 0.0005,
    }),
    released: false,
  };

  const canvas = entry.canvas;
  if (!canvas) return;

  let pointerId = null;

  const onDown = (clientX, id) => {
    const sp = entry._spinner;
    sp.dragging = true;
    sp.released = false;
    sp.dragLastX = clientX;
    sp.dragStartX = clientX;
    sp.spinVel = 0;
    if (sp.spinVelSpring) sp.spinVelSpring.set(0);
    pointerId = id;
    canvas.style.cursor = 'grabbing';
  };

  const onMove = (clientX) => {
    const sp = entry._spinner;
    if (!sp.dragging) return;
    const dx = clientX - sp.dragLastX;
    const frameVel = dx * sp.sensitivity;
    // 미끌미끌: 이전 속도와 새 속도 블렌딩
    sp.spinVel = sp.spinVel * 0.5 + frameVel * 0.5;
    sp.dragLastX = clientX;
  };

  const onUp = () => {
    const sp = entry._spinner;
    if (!sp.dragging) return;
    sp.dragging = false;
    sp.released = true;
    if (sp.mode === 'spring') {
      // 현재 속도를 스프링에 전달 → 탱~ 복귀
      sp.spinVelSpring.set(sp.spinVel);
      sp.spinVelSpring.v = 0;
    }
    // friction 모드: spinVel 그대로 보존 → 마찰로 감속
    canvas.style.cursor = 'grab';
    pointerId = null;
  };

  // 마우스 이벤트
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDown(e.clientX, -1);

    const mouseMoveHandler = (ev) => onMove(ev.clientX);
    const mouseUpHandler = () => {
      onUp();
      window.removeEventListener('mousemove', mouseMoveHandler);
      window.removeEventListener('mouseup', mouseUpHandler);
    };
    window.addEventListener('mousemove', mouseMoveHandler);
    window.addEventListener('mouseup', mouseUpHandler);
  });

  // 터치 이벤트
  let touchStartY = 0;
  let touchLocked = false; // true = 스피너 모드, false = 스크롤 허용

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartY = t.clientY;
    touchLocked = false;
    onDown(t.clientX, t.identifier);
  }, { passive: true }); // passive: 스크롤 차단 안함

  canvas.addEventListener('touchmove', (e) => {
    const sp = entry._spinner;
    if (!sp.dragging) return;
    for (const t of e.changedTouches) {
      if (t.identifier === pointerId) {
        const dx = Math.abs(t.clientX - sp.dragStartX);
        const dy = Math.abs(t.clientY - touchStartY);
        // 수평 이동이 더 크면 스피너, 아니면 스크롤
        if (!touchLocked && dx > 12) {
          touchLocked = true;
        }
        if (!touchLocked && dy > 12) {
          // 세로 스크롤 의도 → 스피너 취소
          onUp();
          return;
        }
        if (touchLocked) {
          e.preventDefault();
          onMove(t.clientX);
        }
        break;
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === pointerId) {
        onUp();
        touchLocked = false;
        break;
      }
    }
  });

  canvas.addEventListener('touchcancel', () => { onUp(); touchLocked = false; });

  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'pan-y'; // 세로 스크롤 허용, 가로만 스피너
}

// ══════════════════════════════════════════════════════
// BAPE 3축 자유 조작 — 드래그로 360° 자유 회전, 플릭 관성, 마그네틱 복귀
// ══════════════════════════════════════════════════════
function initBapeInteraction(entry, glbFile) {
  entry._bapeCtrl = {
    active: true,
    dragging: false,
    // 드래그 상태
    dragStartX: 0, dragStartY: 0,
    dragLastX: 0, dragLastY: 0,
    dragLastTime: 0,
    // 현재 유저 회전 오프셋 (자동 회전과 별도)
    rotOffsetX: 0, rotOffsetY: 0,
    // 플릭 관성 속도
    velX: 0, velY: 0,
    // 스프링 복귀
    springX: new Spring({ value: 0, stiffness: 45, damping: 8, mass: 1.2, precision: 0.0005 }),
    springY: new Spring({ value: 0, stiffness: 45, damping: 8, mass: 1.2, precision: 0.0005 }),
    // 줌 효과 (핀치/스크롤)
    zoomSpring: new Spring({ value: 1.0, stiffness: 160, damping: 18, mass: 0.8, precision: 0.001 }),
    zoomTarget: 1.0,
    // 탭 효과 — 탭하면 탱~ 튀는 bounce
    tapBounce: new Spring({ value: 0, stiffness: 300, damping: 12, mass: 0.6, precision: 0.001 }),
    // 상태
    released: false,
    flickActive: false,
    returnToAuto: false,
    idleTimer: 0,
    // 마지막 드래그의 velocity 추적 (5프레임 이동평균)
    velHistory: [],
  };

  const canvas = entry.canvas;
  if (!canvas) return;

  let pointerId = null;

  const onDown = (clientX, clientY, id) => {
    const bc = entry._bapeCtrl;
    bc.dragging = true;
    bc.released = false;
    bc.flickActive = false;
    bc.returnToAuto = false;
    bc.idleTimer = 0;
    bc.dragStartX = clientX;
    bc.dragStartY = clientY;
    bc.dragLastX = clientX;
    bc.dragLastY = clientY;
    bc.dragLastTime = performance.now();
    bc.velX = 0;
    bc.velY = 0;
    bc.velHistory = [];
    // 스프링 값을 현재 오프셋으로 설정 (이어잡기)
    bc.springX.set(bc.rotOffsetX);
    bc.springY.set(bc.rotOffsetY);
    pointerId = id;
    canvas.style.cursor = 'grabbing';
  };

  const onMove = (clientX, clientY) => {
    const bc = entry._bapeCtrl;
    if (!bc.dragging) return;
    const now = performance.now();
    const dtMs = Math.max(1, now - bc.dragLastTime);
    const dx = clientX - bc.dragLastX;
    const dy = clientY - bc.dragLastY;
    // 감도 — Y축(상하)을 X축(좌우) 회전으로 매핑
    const sensX = 0.008; // 좌우 드래그 → Y축 회전
    const sensY = 0.006; // 상하 드래그 → X축 회전
    bc.rotOffsetY += dx * sensX;
    bc.rotOffsetX += dy * sensY;
    // X축 회전 제한 (위아래 ±60도)
    bc.rotOffsetX = Math.max(-1.05, Math.min(1.05, bc.rotOffsetX));
    // velocity 기록 (플릭 감지용)
    const vx = dx / dtMs * 16; // per-frame으로 정규화
    const vy = dy / dtMs * 16;
    bc.velHistory.push({ vx, vy, t: now });
    // 최근 80ms만 유지
    bc.velHistory = bc.velHistory.filter(v => now - v.t < 80);
    bc.dragLastX = clientX;
    bc.dragLastY = clientY;
    bc.dragLastTime = now;
  };

  const onUp = () => {
    const bc = entry._bapeCtrl;
    if (!bc.dragging) return;
    bc.dragging = false;
    bc.released = true;
    // 플릭 velocity 계산 (최근 기록 평균)
    if (bc.velHistory.length > 0) {
      let svx = 0, svy = 0;
      bc.velHistory.forEach(v => { svx += v.vx; svy += v.vy; });
      bc.velX = svx / bc.velHistory.length * 0.008;
      bc.velY = svy / bc.velHistory.length * 0.006;
    }
    const speed = Math.sqrt(bc.velX * bc.velX + bc.velY * bc.velY);
    if (speed > 0.005) {
      bc.flickActive = true;
    } else {
      // 느린 놓기 → 바로 복귀 시작
      bc.returnToAuto = true;
      bc.springX.set(bc.rotOffsetX);
      bc.springX.v = 0;
      bc.springY.set(bc.rotOffsetY);
      bc.springY.v = 0;
    }
    canvas.style.cursor = 'grab';
    pointerId = null;
  };

  const onTap = () => {
    // 탭 → 탱~ 튀는 bounce 효과
    const bc = entry._bapeCtrl;
    bc.tapBounce.set(0);
    bc.tapBounce.impulse(8.0);
  };

  // 마우스 이벤트
  let mouseDownTime = 0;
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    mouseDownTime = performance.now();
    onDown(e.clientX, e.clientY, -1);

    const mouseMoveHandler = (ev) => onMove(ev.clientX, ev.clientY);
    const mouseUpHandler = (ev) => {
      const dt = performance.now() - mouseDownTime;
      const dist = Math.sqrt((ev.clientX - entry._bapeCtrl.dragStartX)**2 + (ev.clientY - entry._bapeCtrl.dragStartY)**2);
      onUp();
      // 짧은 클릭 + 이동 없으면 → 탭 bounce
      if (dt < 200 && dist < 8) onTap();
      window.removeEventListener('mousemove', mouseMoveHandler);
      window.removeEventListener('mouseup', mouseUpHandler);
    };
    window.addEventListener('mousemove', mouseMoveHandler);
    window.addEventListener('mouseup', mouseUpHandler);
  });

  // 마우스 줌 (스크롤)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const bc = entry._bapeCtrl;
    const zoomDelta = e.deltaY * 0.001;
    bc.zoomTarget = Math.max(0.65, Math.min(1.45, bc.zoomTarget + zoomDelta));
  }, { passive: false });

  // 터치 이벤트
  let touchStartTime = 0;
  let touchStartY2 = 0;
  let touchLocked2 = false;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStartY2 = t.clientY;
      touchStartTime = performance.now();
      touchLocked2 = false;
      onDown(t.clientX, t.clientY, t.identifier);
    }
    // 2-finger pinch zoom
    if (e.touches.length === 2) {
      e.preventDefault();
      const bc = entry._bapeCtrl;
      bc._pinchDist = Math.sqrt(
        (e.touches[0].clientX - e.touches[1].clientX)**2 +
        (e.touches[0].clientY - e.touches[1].clientY)**2
      );
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    const bc = entry._bapeCtrl;
    // Pinch zoom
    if (e.touches.length === 2 && bc._pinchDist) {
      e.preventDefault();
      const newDist = Math.sqrt(
        (e.touches[0].clientX - e.touches[1].clientX)**2 +
        (e.touches[0].clientY - e.touches[1].clientY)**2
      );
      const scale = newDist / bc._pinchDist;
      bc.zoomTarget = Math.max(0.65, Math.min(1.45, bc.zoomTarget * (1 + (scale - 1) * 0.3)));
      bc._pinchDist = newDist;
      return;
    }
    if (!bc.dragging || e.touches.length !== 1) return;
    const t = e.changedTouches[0];
    if (t.identifier !== pointerId) return;
    const dx = Math.abs(t.clientX - bc.dragStartX);
    const dy = Math.abs(t.clientY - touchStartY2);
    if (!touchLocked2 && (dx > 10 || dy > 10)) {
      touchLocked2 = true;
      if (dy > dx * 1.5) {
        // 세로 방향이 더 크면 스크롤 허용
        onUp(); touchLocked2 = false;
        return;
      }
    }
    if (touchLocked2) {
      e.preventDefault();
      onMove(t.clientX, t.clientY);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    const bc = entry._bapeCtrl;
    bc._pinchDist = null;
    if (bc.dragging) {
      for (const t of e.changedTouches) {
        if (t.identifier === pointerId) {
          const dt = performance.now() - touchStartTime;
          const dist = Math.sqrt((t.clientX - bc.dragStartX)**2 + (t.clientY - touchStartY2)**2);
          onUp();
          if (dt < 200 && dist < 12) onTap();
          break;
        }
      }
    }
    touchLocked2 = false;
  });

  canvas.addEventListener('touchcancel', () => {
    entry._bapeCtrl._pinchDist = null;
    onUp();
    touchLocked2 = false;
  });

  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'pan-y';
}

const chronSections=document.querySelectorAll(".chron-section");
const glbRenderers=Object.create(null);
const glbLivePromises=new Map();
const glbTemplateCache=new Map();
const wantedGLBIndices=new Set();
let activeGLBIdx=-1;
let lastActiveGLBIdx=-1;
const IS_MOBILE=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const DPR=Math.min(window.devicePixelRatio||1, IS_MOBILE ? 1.15 : 1.4);
const MAX_CHRON_CONTEXTS=IS_MOBILE ? 1 : 3;
const PRELOAD_CONCURRENCY=IS_MOBILE ? 1 : 2;

const GLB_SCALE_OVERRIDE={
  "midi.glb":3.2,"2020.glb":3.1,"2020_ferrari_f8_tributo.glb":3.1,
  "jack_daniels_whiskey_no.7_bottle.glb":2.7,"hoodie.glb":4.4,
  "cuban_link_chain.glb":2.7,"can.glb":2.1,"kiki.glb":3.6,"stu.glb":4.45,"20201.glb":3.8,
  "whiskey.glb":2.2,
};
const GLB_Y_OFFSET={"hoodie.glb":-1.05, "whiskey.glb":-0.75, "stu.glb":-0.45};
const GLB_BOTTOM_PIVOT=new Set(["wine_bottle_cos.glb","jack_daniels_whiskey_no.7_bottle.glb","whiskey.glb"]);

const GLB_LIGHTING={
  "jack_daniels_whiskey_no.7_bottle.glb": {zeroBase:true, exposure:1.1, warmColor:0x8A4B22, warmI:14.0, warmDist:14},
  "whiskey.glb": {whiskeyCustm:true, exposure:1.8, ambI:0.35, warmColor:0xC47A30, warmI:9.0, warmDist:14},
  "vintage_metal_ashtray.glb": {ashtray:true, exposure:2.2, ambI:1.10, dirI:1.80, dir2I:0.80},
  "hoodie.glb": {hoodie:true, exposure:2.2, ambI:1.20, dirI:1.80, dir2I:0.90},
  "midi.glb": {keyboard:true, exposure:1.55, ambI:0.72, dirI:1.10, dir2I:0.55},
  "cuban_link_chain.glb": {cuban:true, ambI:3.2, dirI:5.0, dir2I:2.5, exposure:3.4},
  "diamond_bape_buckle.glb": {ambI:2.2, dirI:3.0, dir2I:1.5, exposure:2.2},
  "2020.glb": {dark:true, ambI:0.18, dirI:0.35, dir2I:0.12, exposure:0.65},
  "2020_ferrari_f8_tributo.glb": {dark:true, ambI:0.18, dirI:0.35, dir2I:0.12, exposure:0.65},
};

const GLB_SPECIAL_REVERSE=new Set(["hoodie.glb","2020_ferrari_f8_tributo.glb"]);

const GLB_PERS={
  "vintage_metal_ashtray.glb": {wobble:0.016,wFreq:1.2,band:"sub",  bRot:0.006, subBass:true},
  "hoodie.glb":                {wobble:0.0014,wFreq:0.62,band:"bass", bRot:0.009, hoodieMode:true},
  "kiki.glb":                  {wobble:0.012,wFreq:3.0,band:"mid", bRot:0.0022, airHigh:true},
  "cuban_link_chain.glb":      {wobble:0.007,wFreq:1.4,band:"bass", bRot:0.0005, oneWay:true},
  "whiskey.glb":               {wobble:0.006,wFreq:1.5,band:"sub",  bRot:0.0014, whiskyMode:true},
  "diamond_bape_buckle.glb":   {wobble:0.018,wFreq:4.2,band:"high", bRot:0.0015, airHigh:true, bapeMode:true},
  "stu.glb":                   {wobble:0.0022,wFreq:0.52,band:"sub",  bRot:0.00045, stuMode:true},
  "20201.glb":                 {wobble:0.0008,wFreq:0.45,band:"bass", bRot:0.00365, bounceMode:true, oneWay:true},
  "boot.glb":                  {wobble:0.000,wFreq:0.0,band:"sub",  bRot:0.0022, bootMode:true},
  "jack_daniels_whiskey_no.7_bottle.glb":{wobble:0.006,wFreq:1.3,band:"sub", bRot:0.0012},
  "2020.glb":                  {wobble:0.010,wFreq:1.6,band:"bass", bRot:0.0018, multiband:true},
};
const DEF_PERS={wobble:0.010,wFreq:2.0,band:"bass",bRot:0.0022};

// ── 스피너 대상 모델 (손으로 돌리기 가능)
const SPINNER_MODELS = new Set(["vintage_metal_ashtray.glb", "20201.glb"]);

// ── BAPE 3축 자유 조작 대상
const BAPE_INTERACT_MODELS = new Set(["diamond_bape_buckle.glb"]);

let sharedLoadingManager=null;
let sharedGLTFLoader=null;
let sharedDRACOLoader=null;
let sharedKTX2Loader=null;

function getVisibleSectionRatio(sec){
  if(!sec) return 0;
  const rect=sec.getBoundingClientRect();
  const vh=window.innerHeight||1;
  if(rect.bottom<=0||rect.top>=vh) return 0;
  const visible=Math.min(rect.bottom,vh)-Math.max(rect.top,0);
  return Math.max(0, visible / Math.max(1, Math.min(rect.height, vh)));
}

function getTextureSlots(material){
  return [
    "map","alphaMap","aoMap","bumpMap","normalMap","roughnessMap","metalnessMap","emissiveMap",
    "clearcoatMap","clearcoatNormalMap","clearcoatRoughnessMap","iridescenceMap","iridescenceThicknessMap",
    "specularColorMap","specularIntensityMap","sheenColorMap","sheenRoughnessMap","thicknessMap","transmissionMap"
  ];
}

function optimizeTexture(texture){
  if(!texture||texture.userData?._optimized) return;
  texture.anisotropy=Math.min(texture.anisotropy||1, 2);
  const img=texture.image;
  const tooLarge=img&&img.width&&img.height&&(img.width>2048||img.height>2048);
  if(tooLarge){
    texture.generateMipmaps=false;
    texture.minFilter=THREE.LinearFilter;
  }
  texture.needsUpdate=true;
  texture.userData = texture.userData || {};
  texture.userData._optimized=true;
}

function optimizeMaterial(material){
  if(!material||material.userData?._optimized) return;
  getTextureSlots(material).forEach((slot)=>{
    if(material[slot]) optimizeTexture(material[slot]);
  });
  if(material.transparent && material.opacity >= 0.999 && !material.alphaMap){
    material.transparent=false;
  }
  if(material.alphaTest>0){
    material.depthWrite=true;
  }
  material.userData = material.userData || {};
  material.userData._optimized=true;
  material.needsUpdate=true;
}

function initAssetLoaders(){
  if(sharedGLTFLoader) return;
  sharedLoadingManager=new THREE.LoadingManager();
  sharedDRACOLoader=new DRACOLoader(sharedLoadingManager);
  sharedDRACOLoader.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.163.0/examples/jsm/libs/draco/gltf/");

  sharedKTX2Loader=new KTX2Loader(sharedLoadingManager);
  sharedKTX2Loader.setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.163.0/examples/jsm/libs/basis/");

  let probeRenderer=null;
  try{
    const probeCanvas=document.createElement("canvas");
    probeRenderer=new THREE.WebGLRenderer({ canvas:probeCanvas, antialias:false, alpha:false, powerPreference:"low-power" });
    sharedKTX2Loader.detectSupport(probeRenderer);
  }catch(_){}

  sharedGLTFLoader=new GLTFLoader(sharedLoadingManager);
  sharedGLTFLoader.setDRACOLoader(sharedDRACOLoader);
  if(probeRenderer) sharedGLTFLoader.setKTX2Loader(sharedKTX2Loader);

  if(probeRenderer){
    try{ probeRenderer.dispose(); }catch(_){}
    try{ probeRenderer.forceContextLoss(); }catch(_){}
  }
}

function fixFerrari(model){
  model.traverse(c=>{
    if(!c.isMesh) return;
    const mats=Array.isArray(c.material)?c.material:[c.material];
    mats.forEach(m=>{
      if(!m) return;
      m.side=THREE.DoubleSide;
      m.transparent=false;
      m.opacity=1.0;
      m.alphaTest=0;
      m.depthWrite=true;
      m.depthTest=true;
      m.needsUpdate=true;
    });
  });
}

function optimizeTemplateGltf(gltf, glbFile){
  const hasAnimations=!!(gltf.animations&&gltf.animations.length);
  const visitedMaterials=new Set();

  if(glbFile.includes("ferrari")||glbFile==="2020.glb") fixFerrari(gltf.scene);

  gltf.scene.traverse((obj)=>{
    if(obj.isMesh){
      obj.castShadow=false;
      obj.receiveShadow=false;
      obj.frustumCulled=true;
      if(obj.material){
        const mats=Array.isArray(obj.material)?obj.material:[obj.material];
        mats.forEach((mat)=>{
          if(mat && !visitedMaterials.has(mat)){
            visitedMaterials.add(mat);
            optimizeMaterial(mat);
          }
        });
      }
    }
    if(!hasAnimations && obj !== gltf.scene && !obj.isBone && !obj.isSkinnedMesh){
      obj.matrixAutoUpdate=false;
      obj.updateMatrix();
    }
  });

  gltf.scene.updateMatrixWorld(true);
  return gltf;
}

function preloadGLBTemplate(idx){
  const sec=chronSections[idx];
  if(!sec) return Promise.resolve(null);
  const glbPath=sec.dataset.glb;
  if(!glbPath) return Promise.resolve(null);
  if(glbTemplateCache.has(glbPath)){
    return glbTemplateCache.get(glbPath).promise;
  }

  initAssetLoaders();

  const glbFile=glbPath.split("/").pop();
  const cacheEntry={
    path:glbPath,
    glbFile,
    lastUsed:performance.now(),
    promise:null,
    gltf:null,
  };

  cacheEntry.promise=new Promise((resolve,reject)=>{
    sharedGLTFLoader.load(glbPath,(gltf)=>{
      cacheEntry.gltf=optimizeTemplateGltf(gltf, glbFile);
      cacheEntry.lastUsed=performance.now();
      resolve(cacheEntry.gltf);
    },undefined,(err)=>{
      glbTemplateCache.delete(glbPath);
      console.warn("GLB preload 실패:",glbPath,err);
      reject(err);
    });
  });

  glbTemplateCache.set(glbPath,cacheEntry);
  return cacheEntry.promise;
}

function cloneLiveMaterial(material){
  if(!material) return material;
  const cloned=material.clone();
  cloned.needsUpdate=true;
  return cloned;
}

function buildLiveModelFromTemplate(gltf, glbFile){
  const model=cloneSkeleton(gltf.scene);

  model.traverse((obj)=>{
    if(!obj.isMesh) return;
    if(obj.material){
      obj.material=Array.isArray(obj.material)
        ? obj.material.map(cloneLiveMaterial)
        : cloneLiveMaterial(obj.material);
    }
    obj.castShadow=false;
    obj.receiveShadow=false;
    obj.frustumCulled=true;
  });

  let box=new THREE.Box3().setFromObject(model);
  const size=box.getSize(new THREE.Vector3());
  const maxDim=Math.max(size.x,size.y,size.z)||1;
  const scaleOverride=GLB_SCALE_OVERRIDE[glbFile];
  const targetSize=scaleOverride||2.8;
  const sc=targetSize/maxDim;
  model.scale.setScalar(sc);

  box=new THREE.Box3().setFromObject(model);
  const center=box.getCenter(new THREE.Vector3());
  const bottom=box.min.y;

  if(GLB_BOTTOM_PIVOT.has(glbFile)){
    const yOff=GLB_Y_OFFSET[glbFile]||0;
    model.position.set(-center.x, -bottom+yOff, -center.z);
  } else {
    const yOff=GLB_Y_OFFSET[glbFile]||0;
    model.position.set(-center.x, -center.y+yOff, -center.z);
  }

  if(GLB_SPECIAL_REVERSE.has(glbFile)){
    model.rotation.y=Math.PI;
  }

  model.updateMatrixWorld(true);
  return { model, baseScale:sc };
}

function disposeObject3D(root,{ disposeGeometry=false, disposeMaterials=true, disposeTextures=false }={}){
  if(!root) return;

  const visitedMaterials=new Set();
  const visitedTextures=new Set();
  const visitedGeometries=new Set();

  root.traverse((obj)=>{
    if(obj.isMesh){
      if(disposeGeometry && obj.geometry && !visitedGeometries.has(obj.geometry)){
        visitedGeometries.add(obj.geometry);
        obj.geometry.dispose();
      }

      if(disposeMaterials && obj.material){
        const mats=Array.isArray(obj.material)?obj.material:[obj.material];
        mats.forEach((mat)=>{
          if(!mat || visitedMaterials.has(mat)) return;
          visitedMaterials.add(mat);

          if(disposeTextures){
            getTextureSlots(mat).forEach((slot)=>{
              const tex=mat[slot];
              if(tex && !visitedTextures.has(tex)){
                visitedTextures.add(tex);
                tex.dispose();
              }
            });
          }

          mat.dispose();
        });
      }
    }
  });
}

function replaceCanvasWithFreshClone(canvas){
  if(!canvas||!canvas.parentNode) return canvas;
  const fresh=canvas.cloneNode(false);
  if(canvas.className) fresh.className=canvas.className;
  if(canvas.id) fresh.id=canvas.id;
  canvas.parentNode.replaceChild(fresh, canvas);
  return fresh;
}

function buildInstancedCopies(templateMesh, transforms=[]){
  if(!templateMesh||!templateMesh.isMesh||transforms.length===0) return null;
  const sourceMaterial=Array.isArray(templateMesh.material)?templateMesh.material[0]:templateMesh.material;
  const instanced=new THREE.InstancedMesh(templateMesh.geometry, sourceMaterial, transforms.length);
  const tempMatrix=new THREE.Matrix4();
  transforms.forEach((transform, idx)=>{
    tempMatrix.compose(transform.position, transform.quaternion, transform.scale);
    instanced.setMatrixAt(idx, tempMatrix);
  });
  instanced.instanceMatrix.needsUpdate=true;
  instanced.frustumCulled=true;
  return instanced;
}

function attachContextWatchers(canvas,onLost,onRestored){
  const lost=(e)=>{
    e.preventDefault();
    onLost?.(e);
  };
  const restored=()=>{
    onRestored?.();
  };
  canvas.addEventListener("webglcontextlost",lost,false);
  canvas.addEventListener("webglcontextrestored",restored,false);
  return ()=>{
    canvas.removeEventListener("webglcontextlost",lost,false);
    canvas.removeEventListener("webglcontextrestored",restored,false);
  };
}

function createChronRenderer(sec, canvas, glbFile){
  const W=window.innerWidth, H=window.innerHeight;
  const renderer=new THREE.WebGLRenderer({
    canvas,
    alpha:true,
    antialias:!IS_MOBILE,
    powerPreference:"high-performance",
    preserveDrawingBuffer:false,
    stencil:false
  });
  renderer.setPixelRatio(DPR);
  renderer.setSize(W,H,false);
  renderer.shadowMap.enabled=false;
  renderer.setClearColor(0x000000,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.4;

  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(45,W/H,0.01,1000);
  camera.position.set(0,0.8,4.0);
  camera.lookAt(0,0,0);

  const ambLight = new THREE.AmbientLight(0xffffff,0.9);
  scene.add(ambLight);
  const dir=new THREE.DirectionalLight(0xffffff,1.4);
  dir.position.set(3,5,4);
  dir.castShadow=false;
  scene.add(dir);
  const dir2=new THREE.DirectionalLight(0xffffff,0.5);
  dir2.position.set(-3,-1,-2);
  scene.add(dir2);

  const lconf=GLB_LIGHTING[glbFile];
  if(lconf){
    if(lconf.dark){
      ambLight.intensity=0.18; dir.intensity=0.35; dir2.intensity=0.12;
      renderer.toneMappingExposure=0.65;
      const topL=new THREE.PointLight(0xffffff,0.5,8); topL.position.set(0,3,2); scene.add(topL);
      const frontL=new THREE.PointLight(0xffffff,0.3,6); frontL.position.set(0,0,3); scene.add(frontL);
    } else if(lconf.zeroBase){
      ambLight.intensity=0; dir.intensity=0; dir2.intensity=0;
      renderer.toneMappingExposure=lconf.exposure;
      const wc=lconf.warmColor,wi=lconf.warmI,wd=lconf.warmDist;
      const wFront=new THREE.PointLight(wc,wi,wd); wFront.position.set(0,0.2,2.0); scene.add(wFront);
      const wSide=new THREE.PointLight(wc,wi*0.65,wd); wSide.position.set(1.8,0.8,1.5); scene.add(wSide);
      const wSide2=new THREE.PointLight(wc,wi*0.65,wd); wSide2.position.set(-1.8,0.8,1.5); scene.add(wSide2);
      const wBack=new THREE.PointLight(wc,wi*0.3,wd*0.6); wBack.position.set(0,0.5,-1.5); scene.add(wBack);
      scene.add(new THREE.AmbientLight(wc, 0.18));
    } else if(lconf.whiskeyCustm){
      ambLight.intensity=lconf.ambI||0.35; dir.intensity=0.5; dir2.intensity=0.2;
      renderer.toneMappingExposure=lconf.exposure||1.8;
      const wc=lconf.warmColor,wi=lconf.warmI,wd=lconf.warmDist;
      const wFront=new THREE.PointLight(wc,wi,wd); wFront.position.set(0,0.3,2.2); scene.add(wFront);
      const wSide=new THREE.PointLight(wc,wi*0.55,wd); wSide.position.set(1.5,1.0,1.5); scene.add(wSide);
      const wSide2=new THREE.PointLight(wc,wi*0.55,wd); wSide2.position.set(-1.5,1.0,1.5); scene.add(wSide2);
      const wTop=new THREE.PointLight(0xE8C090,wi*0.4,wd*0.8); wTop.position.set(0,3.0,1.0); scene.add(wTop);
      scene.add(new THREE.AmbientLight(0xC88040, 0.25));
    } else if(lconf.ashtray){
      ambLight.intensity=lconf.ambI||1.10; dir.intensity=lconf.dirI||1.80; dir2.intensity=lconf.dir2I||0.80;
      renderer.toneMappingExposure=lconf.exposure||2.2;
      const fillL=new THREE.DirectionalLight(0xE8E0D8,0.90); fillL.position.set(0,2,-3); scene.add(fillL);
      const topL=new THREE.DirectionalLight(0xffffff,1.20); topL.position.set(0,4,1); scene.add(topL);
      const rimL=new THREE.DirectionalLight(0xC8D8FF,0.60); rimL.position.set(-3,1,0); scene.add(rimL);
    } else if(lconf.hoodie){
      ambLight.intensity=lconf.ambI||1.20; dir.intensity=lconf.dirI||1.80; dir2.intensity=lconf.dir2I||0.90;
      renderer.toneMappingExposure=lconf.exposure||2.2;
      const frontL=new THREE.DirectionalLight(0xffffff,1.20); frontL.position.set(0,0,4); scene.add(frontL);
      const topL=new THREE.DirectionalLight(0xffffff,0.90); topL.position.set(0,5,1); scene.add(topL);
      const fillL=new THREE.DirectionalLight(0xD0E0FF,0.50); fillL.position.set(3,2,2); scene.add(fillL);
    } else if(lconf.keyboard){
      ambLight.intensity=lconf.ambI||0.72; dir.intensity=lconf.dirI||1.10; dir2.intensity=lconf.dir2I||0.55;
      renderer.toneMappingExposure=lconf.exposure||1.55;
      const topL=new THREE.DirectionalLight(0xffffff,0.70); topL.position.set(0,4,1.2); scene.add(topL);
      const sideL=new THREE.DirectionalLight(0xE8F0FF,0.45); sideL.position.set(-2,1.2,2.2); scene.add(sideL);
      const rimL=new THREE.DirectionalLight(0xFFEEDD,0.30); rimL.position.set(2,0.5,1.5); scene.add(rimL);
    } else if(lconf.cuban){
      ambLight.intensity=lconf.ambI||3.2; dir.intensity=lconf.dirI||5.0; dir2.intensity=lconf.dir2I||2.5;
      renderer.toneMappingExposure=lconf.exposure||3.4;
      const spot1=new THREE.DirectionalLight(0xFFFFFF,4.0); spot1.position.set(2,3,3); scene.add(spot1);
      const spot2=new THREE.DirectionalLight(0xFFF8E8,3.5); spot2.position.set(-2,2,3); scene.add(spot2);
      const spot3=new THREE.DirectionalLight(0xFFFFFF,2.5); spot3.position.set(0,5,1); scene.add(spot3);
      const rimL=new THREE.DirectionalLight(0xE8F0FF,2.0); rimL.position.set(0,-2,2); scene.add(rimL);
    } else {
      ambLight.intensity=lconf.ambI||0.9; dir.intensity=lconf.dirI||1.4; dir2.intensity=lconf.dir2I||0.5;
      renderer.toneMappingExposure=lconf.exposure||1.4;
      const brightFill=new THREE.DirectionalLight(0xffffff,1.8); brightFill.position.set(0,0,3); scene.add(brightFill);
      const brightTop=new THREE.DirectionalLight(0xffffff,1.2); brightTop.position.set(0,5,1); scene.add(brightTop);
    }
  }

  const era=sec.dataset.era||"mid";
  const eraC={early:0xcc3322,mid:0x7755ff,late:0x2277ff};
  let ptColor=eraC[era], ptIntensity=2.0;
  if(lconf){
    if(lconf.dark){ ptIntensity=0.4; }
    else if(lconf.zeroBase){ ptColor=lconf.warmColor||0x8A4520; ptIntensity=1.2; }
    else if(lconf.whiskeyCustm){ ptColor=lconf.warmColor||0xC47A30; ptIntensity=1.0; }
    else if(lconf.ashtray){ ptIntensity=0.8; }
    else if(lconf.hoodie){ ptIntensity=0.8; }
    else if(lconf.keyboard){ ptIntensity=0.28; }
  }

  const ptLight=new THREE.PointLight(ptColor, ptIntensity, 12);
  ptLight.position.set(-2,2,3);
  scene.add(ptLight);

  return { renderer, scene, camera, ambLight, dir, dir2, ptLight };
}

function disposeLiveGLB(idx, { replaceCanvas=true }={}){
  const entry=glbRenderers[idx];
  if(!entry) return;

  entry.disposed=true;

  if(entry.mixer){
    try{ entry.mixer.stopAllAction(); }catch(_){}
    try{ entry.mixer.uncacheRoot(entry.model); }catch(_){}
  }

  if(entry.model){
    entry.scene.remove(entry.model);
    disposeObject3D(entry.model,{ disposeMaterials:true, disposeTextures:false, disposeGeometry:false });
  }

  try{ entry.scene.clear(); }catch(_){}
  if(entry.cleanupContextWatchers) entry.cleanupContextWatchers();

  if(entry.renderer){
    try{ entry.renderer.renderLists.dispose(); }catch(_){}
    try{ entry.renderer.dispose(); }catch(_){}
    try{ entry.renderer.forceContextLoss(); }catch(_){}
  }

  if(replaceCanvas){
    replaceCanvasWithFreshClone(entry.canvas);
  }

  delete glbRenderers[idx];
}

async function createLiveGLBEntry(idx){
  const sec=chronSections[idx];
  if(!sec) return null;

  const glbPath=sec.dataset.glb;
  const glbFile=glbPath.split("/").pop();
  const template=await preloadGLBTemplate(idx);
  if(!template || !wantedGLBIndices.has(idx)) return null;

  const canvas=sec.querySelector(".glb-canvas");
  if(!canvas) return null;

  canvas.style.position="absolute";
  canvas.style.top="0";
  canvas.style.left="0";
  canvas.style.width="100%";
  canvas.style.height="100%";

  const entry=createChronRenderer(sec, canvas, glbFile);
  entry.clock=new THREE.Clock();
  entry.mixer=null;
  entry.loaded=false;
  entry.model=null;
  entry.baseScale=1;
  entry.glbFile=glbFile;
  entry.pers=GLB_PERS[glbFile]||DEF_PERS;
  entry.wPhase=Math.random()*Math.PI*2;
  entry._baseModelY=null;
  entry.canvas=canvas;
  entry.section=sec;
  entry.disposed=false;
  entry.lastUsed=performance.now();

  entry.cleanupContextWatchers=attachContextWatchers(canvas,()=>{
    entry.contextLost=true;
  },()=>{
    if(wantedGLBIndices.has(idx)){
      disposeLiveGLB(idx,{ replaceCanvas:true });
      ensureGLB(idx);
    }
  });

  const built=buildLiveModelFromTemplate(template, glbFile);
  entry.model=built.model;
  entry.baseScale=built.baseScale;
  entry._baseModelY=built.model.position.y;

  if(template.animations&&template.animations.length){
    entry.mixer=new THREE.AnimationMixer(entry.model);
    template.animations.forEach((clip)=>{
      entry.mixer.clipAction(clip).play();
    });
  }

  entry.scene.add(entry.model);
  entry.loaded=true;

  // 스피너 대상 모델이면 드래그 이벤트 바인딩
  if (SPINNER_MODELS.has(glbFile)) {
    initSpinner(entry, glbFile);
  }

  // BAPE 3축 자유 조작 인터랙션
  if (BAPE_INTERACT_MODELS.has(glbFile)) {
    initBapeInteraction(entry, glbFile);
  }

  glbRenderers[idx]=entry;
  return entry;
}

function getDesiredGLBIndices(idx){
  if(idx<0) return [];
  if(IS_MOBILE) return [idx].filter((v)=>v>=0&&v<chronSections.length);
  return [idx-1,idx,idx+1].filter((v)=>v>=0&&v<chronSections.length);
}

function pruneLiveGLBContexts(){
  const liveIndices=Object.keys(glbRenderers).map((v)=>Number(v));
  if(liveIndices.length<=MAX_CHRON_CONTEXTS) return;

  liveIndices
    .sort((a,b)=>{
      const ad=wantedGLBIndices.has(a)?0:1;
      const bd=wantedGLBIndices.has(b)?0:1;
      if(ad!==bd) return ad-bd;
      return Math.abs(a-activeGLBIdx)-Math.abs(b-activeGLBIdx);
    });

  while(liveIndices.length>MAX_CHRON_CONTEXTS){
    const victim=liveIndices.pop();
    if(victim==null) break;
    if(wantedGLBIndices.has(victim)) break;
    disposeLiveGLB(victim);
  }
}

async function ensureGLB(idx){
  if(idx<0||idx>=chronSections.length) return null;
  if(glbRenderers[idx]?.loaded) return glbRenderers[idx];
  if(glbLivePromises.has(idx)) return glbLivePromises.get(idx);

  const promise=createLiveGLBEntry(idx)
    .catch((err)=>{
      console.warn("GLB live create 실패:", idx, err);
      return null;
    })
    .finally(()=>{
      glbLivePromises.delete(idx);
      pruneLiveGLBContexts();
    });

  glbLivePromises.set(idx,promise);
  return promise;
}

function updateActiveGLB(vIdx){
  const idx=vIdx-1;
  if(activeGLBIdx===idx && wantedGLBIndices.size) return;

  lastActiveGLBIdx=activeGLBIdx;
  activeGLBIdx=idx;

  wantedGLBIndices.clear();
  getDesiredGLBIndices(idx).forEach((value)=>wantedGLBIndices.add(value));

  wantedGLBIndices.forEach((value)=>{
    preloadGLBTemplate(value).catch(()=>{});
    ensureGLB(value);
  });

  Object.keys(glbRenderers).forEach((key)=>{
    const numericKey=Number(key);
    if(!wantedGLBIndices.has(numericKey)) disposeLiveGLB(numericKey);
  });

  pruneLiveGLBContexts();
}

function renderChronEntry(entry){
  if(!entry||!entry.loaded||!entry.model||entry.disposed||entry.contextLost) return;
  const visibility=getVisibleSectionRatio(entry.section);
  if(visibility<=0.01) return;

  const {renderer,scene,camera,clock,mixer,model,ptLight,pers,glbFile} = entry;
  const delta=Math.min(clock.getDelta(),0.05);
  entry.lastUsed=performance.now();
  if(mixer) mixer.update(delta);

  entry.wPhase+=0.016;
  const baseScale=entry.baseScale;
  const bv=S[pers.band]||0;
  const speakerPulse=S.beat+LQ.bassShock*0.5;

  // ── 스피너 속도 제어 ──
  let spinMul = 1.0;   // 1 = 정상 자동 회전, 0 = 정지
  let spinInc = 0;     // 스피너에서 오는 per-frame 회전량
  if (entry._spinner && entry._spinner.enabled) {
    const sp = entry._spinner;
    if (sp.dragging) {
      // 드래그 중: 자동 회전 정지, 스피너 속도로 대체
      spinMul = 0;
      spinInc = sp.spinVel;
    } else if (sp.released) {
      if (sp.mode === 'spring') {
        // ── spring (담배떨이): 속도가 탱~ 하고 0으로 복귀 ──
        sp.spinVel = sp.spinVelSpring.update(0, delta);
        spinInc = sp.spinVel;
        if (sp.spinVelSpring.settled) {
          sp.released = false;
          sp.spinVel = 0;
          spinMul = 1.0;
        } else {
          // 스프링 속도가 줄어들수록 자동 회전 복구
          const fade = Math.min(1.0, Math.abs(sp.spinVel) * 40);
          spinMul = 1.0 - fade;
        }
      } else {
        // ── friction (20201): 마찰로 천천히 감속 ──
        sp.spinVel *= 0.96;
        spinInc = sp.spinVel;
        if (Math.abs(sp.spinVel) < 0.00005) {
          sp.released = false;
          sp.spinVel = 0;
          spinMul = 1.0;
        } else {
          // 속도가 줄어들수록 자동 회전 복구
          const fade = Math.min(1.0, Math.abs(sp.spinVel) * 120);
          spinMul = 1.0 - fade;
        }
      }
    }
  }

  if(!pers.isStatic){
    if(pers.hoodieMode){
      const bassFlow = S.bass * 0.52 + LQ.midDensity * 0.12;
      const hoodPulse = S.beat * 0.18 + LQ.bassShock * 0.08;
      const subPush = LQ.subPressure * 0.16;
      model.rotation.y += pers.bRot * (1.0 + bassFlow * 1.8 + hoodPulse * 0.5);
      model.rotation.x = Math.sin(entry.wPhase * pers.wFreq) * pers.wobble * (0.30 + bassFlow * 0.45);
      if(entry._baseModelY==null) entry._baseModelY = model.position.y;
      model.position.y = entry._baseModelY + subPush * 0.028;
      const ns = baseScale * (1 + bassFlow * 0.006 + hoodPulse * 0.012);
      model.scale.setScalar(model.scale.x + (ns - model.scale.x) * 0.16);
    } else if(pers.bootMode){
      model.rotation.x = 0;
      model.rotation.z = 0;
      model.rotation.y += pers.bRot * (1.0 + S.bass * 0.8);
      model.scale.setScalar(baseScale);
    } else if(pers.bounceMode){
      model.rotation.y += pers.bRot * (1.2 + (S.bass + LQ.midDensity) * 1.6 + speakerPulse * 0.6) * spinMul + spinInc;
      model.rotation.x = 0;
      model.rotation.z = 0;
      if(entry._baseModelY==null) entry._baseModelY = model.position.y;
      const bounce = Math.sin(entry.wPhase * 1.4) * 0.012 + LQ.subPressure * 0.008;
      model.position.y = entry._baseModelY + bounce;
      model.scale.setScalar(baseScale * (1 + speakerPulse * 0.025));

      if(!entry._baseCamPos){
        entry._baseCamPos = camera.position.clone();
        entry._camJSeed = {
          a: Math.random() * 1000,
          b: Math.random() * 1000,
          c: Math.random() * 1000,
          d: Math.random() * 1000,
          e: Math.random() * 1000,
          f: Math.random() * 1000,
        };
        entry._shakeDecay = 0;
      }
      // ── 20201 micro-jitter: tight, cinematic camera shake ──
      // Two-layer noise: fast + ultra-fast, gated by bass threshold
      const rawBass = Math.max(0, S.bass - 0.18);
      const bassGate = Math.min(1, rawBass / 0.42);
      // Onset burst: momentary spike decays quickly
      const beatBurst = S.beat > 0.5 ? S.beat * 0.7 : 0;
      const shakeTarget = bassGate * 0.65 + beatBurst;
      entry._shakeDecay += (shakeTarget - entry._shakeDecay) * 0.38;
      entry._shakeDecay *= 0.92;  // fast natural decay

      const shakeAmt = entry._shakeDecay;
      if(shakeAmt > 0.003){
        const ph = entry.wPhase;
        const s = entry._camJSeed;
        // Layer 1: medium-freq (rumble feel)
        const n1 = Math.sin(ph * 72.3 + s.a) * 0.55 + Math.sin(ph * 118.7 + s.d) * 0.45;
        const n2 = Math.cos(ph * 67.9 + s.b) * 0.50 + Math.cos(ph * 103.4 + s.e) * 0.50;
        const n3 = Math.sin(ph * 51.2 + s.c) * 0.60 + Math.sin(ph * 89.6 + s.f) * 0.40;
        // Layer 2: ultra-fast (crispness)
        const h1 = Math.sin(ph * 213.5 + s.c) * 0.3;
        const h2 = Math.cos(ph * 197.8 + s.a) * 0.3;
        const jX = (n1 + h1) * shakeAmt * 0.0048;
        const jY = (n2 + h2) * shakeAmt * 0.0022;  // vertical more subtle
        const jZ = n3 * shakeAmt * 0.0018;
        camera.position.set(
          entry._baseCamPos.x + jX,
          entry._baseCamPos.y + jY,
          entry._baseCamPos.z + jZ
        );
      } else {
        camera.position.copy(entry._baseCamPos);
      }
      camera.lookAt(0,0,0);
    } else {
      if(glbFile==="diamond_bape_buckle.glb" || pers.bapeMode){
        if(entry._baseModelY==null) entry._baseModelY = model.position.y;

        // ── BAPE 3축 인터랙션 제어 ──
        const bc = entry._bapeCtrl;
        let userRotX = 0, userRotY = 0, userZoom = 1.0, tapBounceVal = 0;

        if (bc && bc.active) {
          // 플릭 관성 처리
          if (bc.flickActive && !bc.dragging) {
            bc.rotOffsetY += bc.velX;
            bc.rotOffsetX += bc.velY;
            bc.rotOffsetX = Math.max(-1.05, Math.min(1.05, bc.rotOffsetX));
            // 마찰 감속
            bc.velX *= 0.94;
            bc.velY *= 0.94;
            const speed = Math.sqrt(bc.velX * bc.velX + bc.velY * bc.velY);
            if (speed < 0.0003) {
              bc.flickActive = false;
              bc.returnToAuto = true;
              bc.springX.set(bc.rotOffsetX);
              bc.springX.v = 0;
              bc.springY.set(bc.rotOffsetY);
              bc.springY.v = 0;
            }
          }

          // 마그네틱 복귀 (손 놓으면 탱~ 하고 원래 자세로)
          if (bc.returnToAuto && !bc.dragging && !bc.flickActive) {
            bc.rotOffsetX = bc.springX.update(0, delta);
            bc.rotOffsetY = bc.springY.update(0, delta);
            if (bc.springX.settled && bc.springY.settled) {
              bc.returnToAuto = false;
              bc.rotOffsetX = 0;
              bc.rotOffsetY = 0;
            }
          }

          // 줌 스프링
          const zoom = bc.zoomSpring.update(bc.zoomTarget, delta);
          userZoom = zoom;
          // 줌이 원래대로 복귀하지 않았으면 천천히 1.0으로
          if (!bc.dragging && !bc.flickActive) {
            bc.zoomTarget += (1.0 - bc.zoomTarget) * 0.008;
          }

          // 탭 바운스
          tapBounceVal = bc.tapBounce.update(0, delta);

          userRotX = bc.rotOffsetX;
          userRotY = bc.rotOffsetY;
        }

        // ── Bape Spring: 음악 반응 (유저 조작과 합성) ──
        if(!entry._springScale) entry._springScale = new Spring({
          value: model.scale.x,
          stiffness: 220,
          damping: 14,
          mass: 0.85,
          precision: 0.00005,
        });
        if(!entry._springYPos) entry._springYPos = new Spring({
          value: model.position.y,
          stiffness: 190,
          damping: 13,
          mass: 0.9,
          precision: 0.00005,
        });
        if(!entry._springRotZ) entry._springRotZ = new Spring({
          value: 0,
          stiffness: 260,
          damping: 16,
          mass: 0.7,
          precision: 0.0001,
        });

        const diamondPulse = Math.min(1, S.high * 0.72 + speakerPulse * 0.32 + LQ.highShimmer * 0.14);
        const scaleTarget = baseScale * (1 + diamondPulse * 0.028 + Math.abs(tapBounceVal) * 0.04) * userZoom;
        const yTarget = entry._baseModelY + diamondPulse * 0.034 + tapBounceVal * 0.015;

        // Impulse kick on beat
        if(!entry._bapePrevBeat) entry._bapePrevBeat = 0;
        const beatRise = S.beat - entry._bapePrevBeat;
        if(beatRise > 0.35){
          const kick = beatRise * 0.42 + S.bass * 0.18;
          entry._springScale.impulse(kick * 0.12);
          entry._springYPos.impulse(kick * 0.22);
          entry._springRotZ.impulse(kick * 0.55);
        }
        entry._bapePrevBeat = S.beat;

        const newScale = entry._springScale.update(scaleTarget, delta);
        const newY = entry._springYPos.update(yTarget, delta);
        const rotZSpring = entry._springRotZ.update(0, delta);

        model.scale.setScalar(newScale);
        model.position.y = newY;

        const bandVal = S.high;
        const sign=GLB_SPECIAL_REVERSE.has(glbFile)?-1:1;
        // 자동 회전 — 유저 조작 중이면 약해짐
        const autoRotAmount = (bc && (bc.dragging || bc.flickActive || bc.returnToAuto)) ? 0.15 : 1.0;
        // 자동 회전 누적 (기존 += 방식 유지하되 속도 조절)
        if (!entry._autoRotY) entry._autoRotY = model.rotation.y;
        entry._autoRotY += pers.bRot * (0.55 + bandVal * 1.35 + speakerPulse * 0.18) * sign * autoRotAmount;
        model.rotation.y = entry._autoRotY + userRotY;
        model.rotation.x = userRotX + Math.sin(entry.wPhase * pers.wFreq) * pers.wobble * (0.42 + bandVal * 1.1) * autoRotAmount;
        model.rotation.z = Math.cos(entry.wPhase * pers.wFreq * 0.68) * pers.wobble * 0.30 * autoRotAmount + rotZSpring * 0.012;
      } else if(glbFile==="kiki.glb"){
        if(entry._baseModelY==null) entry._baseModelY = model.position.y;
        if(entry._kikiVocalSmooth==null) entry._kikiVocalSmooth = 0;

        const vocalStrength = Math.min(1, Math.max(0, (T.mid - 0.10) / 0.45));
        entry._kikiVocalSmooth += (vocalStrength - entry._kikiVocalSmooth) * 0.55;
        const kick = entry._kikiVocalSmooth;

        const baseY = entry._baseModelY;
        const targetScale = baseScale * (1 + kick * 0.065);
        model.scale.setScalar(model.scale.x + (targetScale - model.scale.x) * 0.55);
        model.position.y = baseY + kick * 0.032;

        const sign=GLB_SPECIAL_REVERSE.has(glbFile)?-1:1;
        model.rotation.y += pers.bRot * (0.45 + kick * 3.0 + speakerPulse * 0.03) * sign;
        model.rotation.x = Math.sin(entry.wPhase * pers.wFreq * 1.05) * pers.wobble * (0.30 + kick * 1.8);
        model.rotation.z = Math.cos(entry.wPhase * pers.wFreq * 0.78) * pers.wobble * 0.28;
      } else {
        const bandVal=bv;
        const sign=GLB_SPECIAL_REVERSE.has(glbFile)?-1:1;

        if(pers.oneWay){
          model.rotation.y+=pers.bRot*(0.8+bandVal*2.0+speakerPulse*0.6)*spinMul + spinInc;
        } else {
          model.rotation.y+=pers.bRot*(0.6+bandVal*1.8+speakerPulse*0.5)*sign*spinMul + spinInc;
        }

        model.rotation.x=Math.sin(entry.wPhase*pers.wFreq)*pers.wobble*(0.5+bandVal*1.0);
        model.rotation.z=Math.cos(entry.wPhase*pers.wFreq*0.68)*pers.wobble*0.45;
        const ns=baseScale*(1+LQ.midDensity*0.014+S.bass*0.016);
        const ss=baseScale*(1+speakerPulse*0.12);
        const ts=speakerPulse>0.03?ss:ns;
        const cs=model.scale.x;
        model.scale.setScalar(cs+(ts-cs)*(speakerPulse>0.03?0.54:0.30));
      }
    }
  }

  ptLight.color.setRGB(curPal.r/255,curPal.g/255,curPal.b/255);
  const eB=S.energy*S.energy;
  const lightTemp=LQ.subPressure*0.3-LQ.highShimmer*0.1;
  const rBoost=Math.max(0,lightTemp)*60;
  const bBoost=Math.max(0,-lightTemp+LQ.airGlow*0.3)*40;
  ptLight.color.r=Math.min(1,(curPal.r+rBoost)/255);
  ptLight.color.b=Math.min(1,(curPal.b+bBoost)/255);
  ptLight.intensity=0.4+S.bass*0.9+eB*2.8+speakerPulse*4.2+LQ.highShimmer*1.0;

  renderer.render(scene,camera);
}

function renderActiveGLB(){
  const indices=Object.keys(glbRenderers).map((value)=>Number(value));
  if(indices.length===0) return;
  indices.sort((a,b)=>Math.abs(a-activeGLBIdx)-Math.abs(b-activeGLBIdx));
  indices.forEach((idx)=>{
    const entry=glbRenderers[idx];
    if(entry) renderChronEntry(entry);
  });
}

function primeGLBPreloadQueue(){
  const queue=[...Array(chronSections.length)].map((_,idx)=>idx);
  let cursor=0;
  const worker=async()=>{
    while(cursor<queue.length){
      const current=queue[cursor++];
      try{ await preloadGLBTemplate(current); }catch(_){}
      await new Promise((resolve)=>setTimeout(resolve, 140));
    }
  };
  for(let i=0;i<PRELOAD_CONCURRENCY;i++) worker();
}

function center_y(model){
  try {
    const box=new THREE.Box3().setFromObject(model);
    return box.getCenter(new THREE.Vector3()).y;
  } catch(_){ return 0; }
}

// ── 오디오 이벤트
function bindTrackButtons(){
  const trackBtns = document.querySelectorAll(".track-btn");
  trackBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const src = btn.dataset.src;
      if (!src || mode === MODE_MIC) return;
      mode = MODE_FILE;
      ensureCtx();
      try { audioEl.pause(); } catch(_) {}
      audioEl.crossOrigin = "anonymous";
      audioEl.src = src;
      ensureFileSource();
      analyser.smoothingTimeConstant = 0.50;
      isPlaying = true;
      audioCtx.resume().then(() => { audioEl.play().catch(err => console.error("트랙 재생 실패:", err)); });
      trackBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  audioEl.addEventListener("ended", () => {
    isPlaying = false;
    document.querySelectorAll(".track-btn").forEach(b => b.classList.remove("active"));
  });
}

function bindAudioEvents(){
  const fi=document.getElementById("audio-file");
  const play=document.getElementById("play-btn");
  const paus=document.getElementById("pause-btn");
  const mic=document.getElementById("mic-btn");
  const badge=document.getElementById("mic-badge");

  audioEl.addEventListener("play", ()=>{ isPlaying=true; });
  audioEl.addEventListener("pause",()=>{ isPlaying=false; });

  fi.addEventListener("change",async(e)=>{
    const f=e.target.files[0]; if(!f) return;
    if(mode===MODE_MIC) deactivateMic(mic,badge);
    mode=MODE_FILE; ensureCtx();
    try{ audioEl.pause(); }catch(_){}
    audioEl.crossOrigin = "anonymous";
    audioEl.src=URL.createObjectURL(f);
    ensureFileSource();
    analyser.smoothingTimeConstant = 0.50;
    isPlaying=true;
    document.querySelectorAll(".track-btn").forEach(b=>b.classList.remove("active"));
    audioCtx.resume().then(()=>{ audioEl.play().catch(err=>console.error("재생 실패:", err)); });
  });

  play.addEventListener("click",()=>{
    if(mode===MODE_MIC||!audioEl.src) return;
    ensureFileSource();
    analyser.smoothingTimeConstant = 0.50;
    isPlaying=true;
    audioEl.play().catch(console.error);
  });

  paus.addEventListener("click",()=>{
    if(mode===MODE_FILE){ audioEl.pause(); isPlaying=false; }
  });

  mic.addEventListener("click",async()=>{
    if(mode===MODE_MIC){
      deactivateMic(mic,badge); mode=MODE_FILE;
      if(analyser) analyser.smoothingTimeConstant = 0.50;
    } else {
      try{
        audioEl.pause(); isPlaying=false; dropSrc(); ensureCtx();
        if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
        micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
        srcNode=audioCtx.createMediaStreamSource(micStream);
        srcNode.connect(analyser);
        startFeatureAnalyzer(srcNode);
        analyser.smoothingTimeConstant = 0.28;
        mode=MODE_MIC; mic.classList.add("active"); badge.style.display="flex";
      }catch(err){alert("마이크 권한을 허용해 주세요.");}
    }
  });

  window.addEventListener("mousemove",(e)=>{S.mx=e.clientX;S.my=e.clientY;});
  window.addEventListener("touchmove",(e)=>{if(e.touches[0]){S.mx=e.touches[0].clientX;S.my=e.touches[0].clientY;}},{passive:true});

  window.addEventListener("resize",()=>{
    resizeGL(); resizeOverlay();
    Object.values(glbRenderers).forEach(entry=>{
      if(entry&&entry.renderer){
        entry.renderer.setSize(window.innerWidth,window.innerHeight);
        entry.camera.aspect=window.innerWidth/window.innerHeight;
        entry.camera.updateProjectionMatrix();
      }
    });
    if (poolInited && poolRenderer && poolCamera) {
      const W = window.innerWidth, H = window.innerHeight;
      poolRenderer.setSize(W, H);
      if (poolComposer) poolComposer.setSize(W, H);
      poolCamera.aspect = W / H;
      poolCamera.updateProjectionMatrix();
      if (poolDropPass && poolDropPass.uniforms.uResolution) {
        poolDropPass.uniforms.uResolution.value.set(W, H);
      }
      setupPoolRainCanvas();
    }
    LS.hOff=LS.hIdx*window.innerWidth; LS.vOff=LS.vIdx*window.innerHeight;
    LS.cHoff=LS.hOff; LS.cVoff=LS.vOff;
    mc.style.transform=`translate(${-LS.cHoff}px,${-LS.cVoff}px)`;
  });
}

function deactivateMic(mic,badge){
  if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
  dropSrc();
  mic.classList.remove("active");
  badge.style.display="none";
}

// ── Scene 렌더러 (panel-scene)
let sceneCv=null, sCtx=null, sceneActive=false;

const RAIN_COUNT=120;
const rainDrops=Array.from({length:RAIN_COUNT},()=>({
  x:Math.random(), y:Math.random(),
  len:0.012+Math.random()*0.028, spd:0.004+Math.random()*0.008,
  angle:-Math.PI*0.5+(-0.18+Math.random()*0.36),
  opacity:0.08+Math.random()*0.22,
  band:["sub","bass","mid","high","air"][Math.floor(Math.random()*5)],
  thick:Math.random()<0.15?1.8:0.7,
}));

function drawScene(){
  if(!sCtx||!sceneActive) return;
  const W=sceneCv.width, H=sceneCv.height;
  sCtx.clearRect(0,0,W,H);
  const pf = 0.12 + _sMoodEnergy * 0.45;
  const baseHue = _sHueSlow;
  const baseSat = Math.round(_sSatFast * 0.85);

  rainDrops.forEach(d=>{
    const bv=S[d.band]||0;
    d.y += d.spd * (1 + bv * 2.0 + _sMoodEnergy * 0.8) * 0.016;
    if(d.y>1.08){ d.y=-0.05; d.x=Math.random(); }
    const al = d.opacity * (0.25 + bv * 0.4) * pf;
    if(al<0.003) return;
    const x=d.x*W, y=d.y*H;
    const len=d.len*H*(0.45+bv*0.5);
    const dx=Math.sin(d.angle)*len*0.2, dy=Math.cos(d.angle)*len;
    const dropHue = baseHue + (d.x - 0.5) * 18;
    const dropLum = Math.min(72, 38 + _sMoodEnergy * 18 + bv * 14);
    sCtx.beginPath();
    sCtx.strokeStyle=`hsla(${dropHue.toFixed(0)},${baseSat}%,${dropLum.toFixed(0)}%,${al.toFixed(3)})`;
    sCtx.lineWidth=d.thick*(0.45+bv*0.35);
    sCtx.moveTo(x,y); sCtx.lineTo(x+dx,y+dy); sCtx.stroke();
  });
}

function startSceneRenderer(){
  if(sceneActive) return;
  sceneCv=document.getElementById("scene-canvas");
  if(!sceneCv) return;
  sceneCv.width=window.innerWidth; sceneCv.height=window.innerHeight;
  sCtx=sceneCv.getContext("2d");
  sceneActive=true;
  drawScene();
}

// ══════════════════════════════════════════════════════
// POOL 렌더러 — ESM Water, 밝은 하늘 + 떠있는 풀박스
// ══════════════════════════════════════════════════════
let poolRenderer=null, poolScene=null, poolCamera=null, poolComposer=null;
let poolClock=null, poolInited=false, poolActive=false;
let waterMesh=null;
let piaModel=null, piaLoaded=false;
let rainCv=null, rainCtx2=null;
let poolTime=0;
let poolOrbitControls=null;
let poolFloor=null;
let poolUnderGlow=null;
let poolDropPass=null;
let poolCausticsCanvas=null, poolCausticsCtx=null, poolCausticsTex=null;
let poolWaterNormals=null;

const poolMouseRipples=[];
let poolMouseX=0.5, poolMouseY=0.5;
let poolMousePrevX=0.5, poolMousePrevY=0.5;
let poolMouseSpeed=0;
let poolRainActive=false;
let poolRainTimer=0, poolRainDuration=0, poolRainCooldown=0;

// ── Pool Sky Dawn Transition (곡 끝 무렵 청아한 하늘)
let _poolDawnFactor = 0;          // 0 = 밤하늘, 1 = 맑은 낮하늘
let _poolDawnSmooth = 0;          // 부드러운 추적용

const POOL_SCENE_SCALE=1.22;
const POOL_WATER_LEVEL=1.05*POOL_SCENE_SCALE;
const POOL_DIMENSIONS = {
  width: 22.0*POOL_SCENE_SCALE,
  length: 26.0*POOL_SCENE_SCALE,
  depth: 7.8*POOL_SCENE_SCALE,
};
let poolGlassWalls = [];
let poolWallPanels = [];
let poolWallCaustics = [];
let poolWaterVolume = null;
const POOL_RAIN_COUNT=280;
const poolRainDrops=Array.from({length:POOL_RAIN_COUNT},()=>{
  const size=Math.random();  // 0=tiny drizzle, 1=heavy drop
  return {
    x:Math.random(), y:Math.random()*1.2-0.15,
    spd:0.002+size*0.008+Math.random()*0.003,
    len:0.008+size*0.038+Math.random()*0.012,
    angle:Math.PI*(0.02+Math.random()*0.04)*(Math.random()<0.5?1:-1),
    windPhase:Math.random()*Math.PI*2,
    opacity:0.04+size*0.18+Math.random()*0.06,
    band:["sub","bass","mid","high","air"][Math.floor(Math.random()*5)],
    thick:0.4+size*1.2+Math.random()*0.3,
    size,
  };
});
const poolRipples=[];

// Pool Orbit Controls — 360° full sphere, two-finger trackpad / two-touch only, tighter damping

function createPoolOrbitControls(camera, domElement) {
  const ctrl = {
    camera, domElement,
    target: new THREE.Vector3(0, 0, 0),
    spherical: new THREE.Spherical(),
    sphericalDelta: new THREE.Spherical(),
    scale: 1,
    minPolarAngle: 0.01, maxPolarAngle: Math.PI - 0.01,
    minDistance: 7.5*POOL_SCENE_SCALE, maxDistance: 34*POOL_SCENE_SCALE,
    rotateSpeed: 0.19, zoomSpeed: 0.75,
    dampingFactor: 0.93,
    enableDamping: true,
    _twoFingerActive: false, _lastTouchMidX: 0, _lastTouchMidY: 0, _lastPinchDist: 0,
  };

  domElement.style.touchAction = 'none';

  const offset = new THREE.Vector3();
  offset.copy(camera.position).sub(ctrl.target);
  ctrl.spherical.setFromVector3(offset);

  function getTouchMid(t) { return {x:(t[0].clientX+t[1].clientX)*0.5,y:(t[0].clientY+t[1].clientY)*0.5}; }
  function getTouchDist(t) { const dx=t[0].clientX-t[1].clientX,dy=t[0].clientY-t[1].clientY; return Math.sqrt(dx*dx+dy*dy); }

  ctrl._handlers = {
    wheel(e) {
      e.preventDefault();
      e.stopPropagation();

      if(e.ctrlKey){
        const factor = 1 + Math.abs(e.deltaY) * ctrl.zoomSpeed * 0.005;
        if(e.deltaY>0) ctrl.scale = Math.min(ctrl.scale * factor, 1.08);
        else ctrl.scale = Math.max(ctrl.scale / factor, 0.92);
        return;
      }

      const dTheta =  (2*Math.PI*e.deltaX/domElement.clientWidth)  * ctrl.rotateSpeed * 1.5;
      const dPhi   =  (2*Math.PI*e.deltaY/domElement.clientHeight) * ctrl.rotateSpeed * 1.5;
      ctrl.sphericalDelta.theta += dTheta;
      ctrl.sphericalDelta.phi   += dPhi;
    },
    touchstart(e) {
      e.stopPropagation();
      if(e.touches.length===2){
        e.preventDefault();
        ctrl._twoFingerActive=true;
        const mid=getTouchMid(e.touches);
        ctrl._lastTouchMidX=mid.x; ctrl._lastTouchMidY=mid.y;
        ctrl._lastPinchDist=getTouchDist(e.touches);
      } else {
        ctrl._twoFingerActive=false;
      }
    },
    touchmove(e) {
      e.stopPropagation();
      if(e.touches.length!==2||!ctrl._twoFingerActive)return;
      e.preventDefault();
      const mid=getTouchMid(e.touches);
      const dx=mid.x-ctrl._lastTouchMidX, dy=mid.y-ctrl._lastTouchMidY;
      ctrl._lastTouchMidX=mid.x; ctrl._lastTouchMidY=mid.y;

      const dTheta=(2*Math.PI*(-dx)/domElement.clientWidth)*ctrl.rotateSpeed*1.5;
      const dPhi  =(2*Math.PI*(-dy)/domElement.clientHeight)*ctrl.rotateSpeed*1.5;
      ctrl.sphericalDelta.theta += dTheta;
      ctrl.sphericalDelta.phi   += dPhi;

      const dist=getTouchDist(e.touches);
      if(ctrl._lastPinchDist>0){
        const pinchScale = 1 + (ctrl._lastPinchDist - dist) * 0.003;
        ctrl.scale *= Math.max(0.94, Math.min(1.06, pinchScale));
      }
      ctrl._lastPinchDist=dist;
    },
    touchend(e) {
      e.stopPropagation();
      if(e.touches.length<2){
        ctrl._twoFingerActive=false;
        ctrl._lastPinchDist=0;
      }
    }
  };

  domElement.addEventListener('wheel',      ctrl._handlers.wheel, {passive:false});
  domElement.addEventListener('touchstart', ctrl._handlers.touchstart, {passive:false});
  domElement.addEventListener('touchmove',  ctrl._handlers.touchmove,  {passive:false});
  domElement.addEventListener('touchend',   ctrl._handlers.touchend,   {passive:false});
  domElement.addEventListener('touchcancel',ctrl._handlers.touchend,   {passive:false});

  ctrl.update = function() {
    const offset2 = new THREE.Vector3();
    const quat    = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0,1,0));
    const quatInv = quat.clone().invert();
    offset2.copy(camera.position).sub(ctrl.target);
    offset2.applyQuaternion(quat);
    ctrl.spherical.setFromVector3(offset2);
    ctrl.spherical.theta += ctrl.sphericalDelta.theta;
    ctrl.spherical.phi   += ctrl.sphericalDelta.phi;
    ctrl.spherical.phi    = Math.max(ctrl.minPolarAngle, Math.min(ctrl.maxPolarAngle, ctrl.spherical.phi));
    ctrl.spherical.radius *= ctrl.scale;
    ctrl.spherical.radius = Math.max(ctrl.minDistance, Math.min(ctrl.maxDistance, ctrl.spherical.radius));
    ctrl.spherical.makeSafe();
    offset2.setFromSpherical(ctrl.spherical);
    offset2.applyQuaternion(quatInv);
    camera.position.copy(ctrl.target).add(offset2);
    camera.lookAt(ctrl.target);

    if(ctrl.enableDamping){
      ctrl.sphericalDelta.theta *= (1-ctrl.dampingFactor);
      ctrl.sphericalDelta.phi   *= (1-ctrl.dampingFactor);
      if(Math.abs(ctrl.sphericalDelta.theta)<0.00001) ctrl.sphericalDelta.theta = 0;
      if(Math.abs(ctrl.sphericalDelta.phi)<0.00001) ctrl.sphericalDelta.phi = 0;
      ctrl.scale = 1+(ctrl.scale-1)*(1-0.70*1.2);
      if(Math.abs(ctrl.scale-1)<0.00001) ctrl.scale = 1;
    } else {
      ctrl.sphericalDelta.set(0,0,0);
      ctrl.scale=1;
    }
  };

  ctrl.dispose = function(){
    domElement.removeEventListener('wheel', ctrl._handlers.wheel, {passive:false});
    domElement.removeEventListener('touchstart', ctrl._handlers.touchstart, {passive:false});
    domElement.removeEventListener('touchmove', ctrl._handlers.touchmove, {passive:false});
    domElement.removeEventListener('touchend', ctrl._handlers.touchend, {passive:false});
    domElement.removeEventListener('touchcancel', ctrl._handlers.touchend, {passive:false});
  };

  return ctrl;
}


// Pool Drop Shader — 유리/물막 왜곡, 절제된 chromatic aberration
// 평소엔 약하고, high/air/beat 올라갈 때만 강해짐
const POOL_DROP_SHADER = {
  uniforms: {
    tDiffuse:    { value: null },
    uTime:       { value: 0 },
    uBeat:       { value: 0 },
    uShimmer:    { value: 0 },
    uSub:        { value: 0 },
    uMid:        { value: 0 },
    uAir:        { value: 0 },
    uMouseX:     { value: 0.5 },
    uMouseY:     { value: 0.5 },
    uMouseSpeed: { value: 0 },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime,uBeat,uShimmer,uSub,uMid,uAir,uMouseX,uMouseY,uMouseSpeed;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
    float noise(vec2 p){
      vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }
    float fbm(vec2 p){
      float v=0.0,a=0.5;
      for(int i=0;i<3;i++){v+=a*noise(p);p*=2.0;a*=0.5;}
      return v;
    }
    void main(){
      vec2 uv=vUv;
      float ar=uResolution.x/uResolution.y;

      // 수면 강도 — high/air/beat 에 의존
      float wStrength = uShimmer*0.75 + uAir*0.50 + uBeat*0.40;
      // 기본 물막은 아주 약하게 — 항상 있지만 거의 안 보임
      float baseStrength = 0.010;

      // 큰 흐름 왜곡 — fbm 기반 (점성 액체 느낌)
      float n1=fbm(uv*3.5+vec2(uTime*0.06, uTime*0.04));
      float n2=fbm(uv*5.5-vec2(uTime*0.05, uTime*0.03)+vec2(n1*0.4));
      // 잔물결 고주파
      float n3=noise(uv*14.0+vec2(uTime*0.22,-uTime*0.18));
      float n4=noise(uv*22.0+vec2(-uTime*0.28,uTime*0.14));

      // 물막 마스크 — 화면 위쪽(하늘쪽)엔 약하게, 가운데 이하에 집중
      float filmMask=smoothstep(0.05,0.65,uv.y)*(1.0-smoothstep(0.55,1.0,uv.y)*0.5);

      // 기본 드리프트 (항상 존재, 아주 미세)
      vec2 baseDrift=vec2(
        (n1-0.5)*baseStrength + sin(uv.y*8.0+uTime*0.4)*baseStrength*0.5,
        (n2-0.5)*baseStrength + cos(uv.x*7.0+uTime*0.35)*baseStrength*0.4
      );
      // 음악 반응 드리프트 (high/air/beat 올라갈 때)
      vec2 musicDrift=vec2(
        (n2-0.5)*(wStrength*0.016) + (n4-0.5)*(wStrength*0.007),
        (n1-0.5)*(wStrength*0.014) + (n3-0.5)*(wStrength*0.006)
      );
      // sub 압력 — 수면 bulge
      vec2 subBulge=vec2(0.0);
      {
        vec2 c=vec2(0.5,0.58);
        vec2 d=uv-c;
        float dist=max(length(d),0.0001);
        float wave=sin(dist*38.0-uTime*8.0)*exp(-dist*4.5)*uSub*0.014;
        subBulge=(d/dist)*wave*filmMask;
      }
      // beat 순간 ripple
      vec2 beatRipple=vec2(0.0);
      {
        vec2 c=vec2(0.5,0.55);
        vec2 d=uv-c;
        float dist=max(length(d),0.0001);
        float wave=sin(dist*55.0-uTime*14.0)*exp(-dist*5.5)*uBeat*0.012;
        beatRipple=(d/dist)*wave*filmMask;
      }
      // 마우스 흔들림 — 주변부 물결
      vec2 mouseRipple=vec2(0.0);
      {
        vec2 mUV=vec2(uMouseX,1.0-uMouseY);
        vec2 d=uv-mUV;
        float dist=max(length(d*vec2(ar,1.0)),0.0001);
        float spd=uMouseSpeed;
        // 가까이 있을 때 부드러운 lens 왜곡
        float lens=exp(-dist*dist*22.0)*spd*0.014*filmMask;
        // 퍼져나가는 물결
        float ripple=sin(dist*60.0-uTime*11.0)*exp(-dist*7.0)*spd*0.012*filmMask;
        mouseRipple=(d/(dist+0.001))*(lens+ripple);
      }

      vec2 totalDrift=baseDrift+musicDrift+subBulge+beatRipple+mouseRipple;

      // 절제된 chromatic aberration — 물막 굴절 분산
      // 강도는 음악 반응과 마우스에만 의존, 평소엔 0에 가깝게
      float caStrength = (wStrength*0.0072 + uMouseSpeed*0.005 + uSub*0.004)*filmMask;
      // 너무 강하면 글리치처럼 보이므로 max 제한
      caStrength=min(caStrength, 0.008);

      vec2 caDir=normalize(totalDrift+vec2(0.0001));
      float r=texture2D(tDiffuse, clamp(uv+totalDrift+caDir*caStrength*1.0,0.001,0.999)).r;
      float g=texture2D(tDiffuse, clamp(uv+totalDrift,                        0.001,0.999)).g;
      float b=texture2D(tDiffuse, clamp(uv+totalDrift-caDir*caStrength*0.8,   0.001,0.999)).b;

      vec4 col=vec4(r,g,b,1.0);

      // 물 표면 shimmer — 하이라이트 줄기 (고급스럽게 절제)
      float streakU=sin(uv.x*ar*90.0+uTime*2.2)*(0.5+0.5*sin(uv.y*6.0+uTime*0.8));
      float streak=max(0.0,streakU)*0.012*(wStrength*0.9+uMid*0.3)*filmMask;
      col.rgb+=streak*vec3(0.92,0.97,1.0);

      // 수면 반사 sparkle — 물방울 반짝임 (beat/air 때)
      float sparkMask=smoothstep(0.68,0.90,n3*(0.55+n4*0.7))*filmMask;
      float sparkle=sparkMask*(uBeat*0.06+uAir*0.035+uShimmer*0.025);
      col.rgb+=sparkle*vec3(0.88,0.96,1.0);

      // 물막 색조 — 아주 약한 청록 tint (평소엔 거의 없음)
      float tintStrength=(wStrength*0.032+baseStrength*0.5)*filmMask;
      col.rgb=mix(col.rgb, col.rgb*vec3(0.94,0.98,1.04), tintStrength);

      // 밝기 살짝 올리기 — 물 너머 보는 느낌
      col.rgb*=1.0+filmMask*wStrength*0.025;

      gl_FragColor=col;
    }
  `
};

function makeProceduralWaterNormals(size){
  size=size||1024;
  const canvas=document.createElement("canvas");
  canvas.width=size; canvas.height=size;
  const ctx=canvas.getContext("2d");
  const img=ctx.createImageData(size,size);

  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      const i=(y*size+x)*4;
      const xn=x/size, yn=y/size;
      // 레이어 1: 큰 너울 — 느리고 넓음
      const l1x = Math.sin(xn*4.2 + yn*1.8) * 0.38 + Math.cos(xn*2.6 - yn*3.1) * 0.24;
      const l1y = Math.cos(yn*4.5 - xn*1.6) * 0.38 + Math.sin(yn*2.8 + xn*2.9) * 0.24;
      // 레이어 2: 중간 잔결
      const l2x = Math.sin(xn*11.0 - yn*7.5) * 0.18 + Math.sin((xn+yn)*9.2) * 0.12;
      const l2y = Math.cos(yn*10.5 + xn*8.0) * 0.18 + Math.cos((xn-yn)*8.7) * 0.12;
      // 레이어 3: 미세 표면 질감
      const l3x = Math.sin(xn*28.0 + yn*22.0) * 0.06;
      const l3y = Math.cos(yn*26.0 - xn*24.0) * 0.06;
      const lx = l1x + l2x + l3x;
      const ly = l1y + l2y + l3y;
      img.data[i]   = 128 + lx * 52;
      img.data[i+1] = 128 + ly * 52;
      img.data[i+2] = 255;
      img.data[i+3] = 255;
    }
  }

  ctx.putImageData(img,0,0);
  const tex=new THREE.CanvasTexture(canvas);
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  tex.repeat.set(2.0, 2.0);
  return tex;
}

// ── Pool Sky (밝은 하늘색)
function buildPoolSky(){
  const skyGeo=new THREE.SphereGeometry(150,32,16);
  const skyMat=new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms:{
      uTopColor:     { value: new THREE.Color(0x010306) },
      uMidColor:     { value: new THREE.Color(0x03080f) },
      uHorizonColor: { value: new THREE.Color(0x060e18) },
      uSunColor:     { value: new THREE.Color(0x1a3a6a) },
      uSunDir:       { value: new THREE.Vector3(0.4,0.8,0.3).normalize() },
      uTime:         { value: 0 },
    },
    vertexShader:`
      varying vec3 vWorldPos;
      void main(){
        vWorldPos=(modelMatrix*vec4(position,1.0)).xyz;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
      }
    `,
    fragmentShader:`
      uniform vec3 uTopColor,uMidColor,uHorizonColor,uSunColor,uSunDir;
      uniform float uTime;
      varying vec3 vWorldPos;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5);}
      void main(){
        vec3 dir=normalize(vWorldPos);
        float h=clamp(dir.y,0.0,1.0);
        vec3 col=mix(uHorizonColor,mix(uMidColor,uTopColor,h*h),h);
        float sunDot=max(0.0,dot(dir,normalize(uSunDir)));
        float sun=pow(sunDot,380.0)*2.5;
        float halo=pow(sunDot,12.0)*0.32;
        col+=uSunColor*(sun+halo);
        float cloudH=smoothstep(0.06,0.30,h);
        float nx=dir.x/(dir.y+0.001), nz=dir.z/(dir.y+0.001);
        float cloud=0.0;
        for(int i=0;i<4;i++){
          float sc=pow(2.0,float(i));
          cloud+=hash(vec2(nx*sc+uTime*0.003,nz*sc+uTime*0.002))/sc;
        }
        cloud=smoothstep(0.58,0.88,cloud)*cloudH*0.55;
        col=mix(col,vec3(0.97,0.99,1.0),cloud);
        gl_FragColor=vec4(col,1.0);
      }
    `
  });
  const sky=new THREE.Mesh(skyGeo,skyMat);
  poolScene.add(sky);
  poolScene._sky=sky;
  poolScene._skyMat=skyMat;
}

// ── Pool Shell — 물튜브 박스 (세로로 길고, 투명 유리 벽, 내부 타일만)
function buildPoolShell(){
  const PW = POOL_DIMENSIONS.width;
  const PD = POOL_DIMENSIONS.length;
  const PH = POOL_DIMENSIONS.depth;
  const halfX = PW * 0.5;
  const halfZ = PD * 0.5;
  const floorY = -PH + POOL_WATER_LEVEL;

  poolGlassWalls = [];
  poolWallPanels = [];
  poolWallCaustics = [];
  poolWaterVolume = null;

  // ── 타일 바닥 — 더 깊고 맑은 풀 블루
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x2e7ea8,
    roughness: 0.18,
    metalness: 0.04,
    emissive: 0x082838,
    emissiveIntensity: 0.22,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(PW, PD, 24, 40), floorMat);
  floor.rotation.x = -Math.PI * 0.5;
  floor.position.y = floorY;
  floor.receiveShadow = true;
  poolScene.add(floor);
  poolFloor = floor;

  // ── 코스틱 오버레이 (바닥 위)
  const caustic = new THREE.Mesh(
    new THREE.PlaneGeometry(PW - 0.2, PD - 0.2),
    new THREE.MeshBasicMaterial({
      map: poolCausticsTex,
      color: 0xd8f4ff,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  caustic.rotation.x = -Math.PI * 0.5;
  caustic.position.y = floorY + 0.02;
  poolScene.add(caustic);
  poolScene._caustic = caustic;

  // ── 바닥 타일 그리드 선 (1m 간격)
  const gridMat = new THREE.MeshStandardMaterial({
    color: 0x2d79a2,
    roughness: 0.92,
    emissive: 0x0d2433,
    emissiveIntensity: 0.14,
  });
  for(let i = -Math.floor(halfZ); i <= Math.floor(halfZ); i++){
    const hz = new THREE.Mesh(new THREE.BoxGeometry(PW + 0.2, 0.014, 0.022), gridMat);
    hz.position.set(0, floorY + 0.01, i);
    poolScene.add(hz);
  }
  for(let i = -Math.floor(halfX); i <= Math.floor(halfX); i++){
    const vt = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.014, PD + 0.2), gridMat);
    vt.position.set(i, floorY + 0.01, 0);
    poolScene.add(vt);
  }

  // ── 물 볼륨 자체를 넣어서 측면이 진한 남색 덩어리처럼 안 보이게 함
  const volumeMat = new THREE.MeshPhysicalMaterial({
    color: 0x6fcaf2,
    transparent: true,
    opacity: 0.18,
    roughness: 0.06,
    metalness: 0.0,
    transmission: 0.90,
    thickness: 2.4,
    side: THREE.DoubleSide,
    depthWrite: false,
    clearcoat: 1.0,
    clearcoatRoughness: 0.10,
    emissive: 0x1a5c80,
    emissiveIntensity: 0.16,
  });
  poolWaterVolume = new THREE.Mesh(
    new THREE.BoxGeometry(PW - 0.08, PH - 0.02, PD - 0.08),
    volumeMat
  );
  poolWaterVolume.position.set(0, floorY + PH * 0.5, 0);
  poolScene.add(poolWaterVolume);

  // ── 투명 유리 벽
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdaf4ff,
    transparent: true,
    opacity: 0.22,
    roughness: 0.02,
    metalness: 0.0,
    transmission: 0.96,
    thickness: 1.25,
    side: THREE.DoubleSide,
    depthWrite: false,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
  });

  [-halfZ, halfZ].forEach(z => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), glassMat.clone());
    w.position.set(0, floorY + PH * 0.5, z);
    if(z < 0) w.rotation.y = Math.PI;
    poolScene.add(w);
    poolGlassWalls.push(w);
  });
  [-halfX, halfX].forEach(x => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(PD, PH), glassMat.clone());
    w.position.set(x, floorY + PH * 0.5, 0);
    w.rotation.y = x > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
    poolScene.add(w);
    poolGlassWalls.push(w);
  });

  // ── 안쪽 벽 패널: 조명을 덜 타고 항상 같은 수색으로 보이게
  const wallTileMat = new THREE.MeshPhysicalMaterial({
    color: 0x88d6f3,
    transparent: true,
    opacity: 0.32,
    roughness: 0.08,
    metalness: 0.0,
    transmission: 0.42,
    thickness: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
    emissive: 0x2b83b2,
    emissiveIntensity: 0.30,
    clearcoat: 1.0,
    clearcoatRoughness: 0.14,
  });

  [-halfZ + 0.01, halfZ - 0.01].forEach(z => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(PW - 0.06, PH - 0.04), wallTileMat.clone());
    w.position.set(0, floorY + PH * 0.5, z);
    if(z < 0) w.rotation.y = Math.PI;
    poolScene.add(w);
    poolWallPanels.push(w);
  });
  [-halfX + 0.01, halfX - 0.01].forEach(x => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(PD - 0.06, PH - 0.04), wallTileMat.clone());
    w.position.set(x, floorY + PH * 0.5, 0);
    w.rotation.y = x > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
    poolScene.add(w);
    poolWallPanels.push(w);
  });

  // ── 벽 코스틱 오버레이: 측면도 물결 질감이 보이게
  const makeWallCausticMat = () => new THREE.MeshBasicMaterial({
    map: poolCausticsTex,
    color: 0xe7fbff,
    transparent: true,
    opacity: 0.10,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  [-halfZ + 0.02, halfZ - 0.02].forEach(z => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(PW - 0.14, PH - 0.10), makeWallCausticMat());
    w.position.set(0, floorY + PH * 0.5, z);
    if(z < 0) w.rotation.y = Math.PI;
    poolScene.add(w);
    poolWallCaustics.push(w);
  });
  [-halfX + 0.02, halfX - 0.02].forEach(x => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(PD - 0.14, PH - 0.10), makeWallCausticMat());
    w.position.set(x, floorY + PH * 0.5, 0);
    w.rotation.y = x > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
    poolScene.add(w);
    poolWallCaustics.pus// ── Water Surface — GPU Wave Simulation (madebyevan WebGL Water style)
// GPU ping-pong: R=height, G=velocity, B=normal.x, A=normal.z
let gpuRtA = null, gpuRtB = null;
let gpuSimScene = null, gpuSimCamera = null, gpuSimQuad = null;
let gpuDropMat = null, gpuUpdateMat = null, gpuNormalMat = null;
let gpuSimInitialized = false;
const GPU_SIM_SIZE = 256;
let fluidPrevMouseUX = 0.5, fluidPrevMouseUY = 0.5;
let fluidMouseVX = 0, fluidMouseVY = 0;

function initGPUWaterSim() {
  if (!poolRenderer || gpuSimInitialized) return;
  const SZ = GPU_SIM_SIZE;
  const rtParams = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  };
  gpuRtA = new THREE.WebGLRenderTarget(SZ, SZ, rtParams);
  gpuRtB = new THREE.WebGLRenderTarget(SZ, SZ, rtParams);

  gpuSimCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  gpuSimCamera.position.z = 1;
  gpuSimScene = new THREE.Scene();
  gpuSimQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  gpuSimScene.add(gpuSimQuad);

  const simVS = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`;
  const delta = new THREE.Vector2(1.0 / SZ, 1.0 / SZ);

  gpuDropMat = new THREE.ShaderMaterial({
    uniforms: {
      tTexture:  { value: null },
      uCenter:   { value: new THREE.Vector2(0.5, 0.5) },
      uRadius:   { value: 0.03 },
      uStrength: { value: 0.0 },
    },
    vertexShader: simVS,
    fragmentShader: `
      const float PI = 3.141592653589793;
      uniform sampler2D tTexture;
      uniform vec2 uCenter;
      uniform float uRadius, uStrength;
      varying vec2 vUv;
      void main(){
        vec4 info = texture2D(tTexture, vUv);
        float drop = max(0.0, 1.0 - length(uCenter - vUv) / uRadius);
        drop = 0.5 - cos(drop * PI) * 0.5;
        info.r += drop * uStrength;
        gl_FragColor = info;
      }`,
  });

  gpuUpdateMat = new THREE.ShaderMaterial({
    uniforms: {
      tTexture: { value: null },
      uDelta:   { value: delta },
    },
    vertexShader: simVS,
    fragmentShader: `
      uniform sampler2D tTexture;
      uniform vec2 uDelta;
      varying vec2 vUv;
      void main(){
        vec4 info = texture2D(tTexture, vUv);
        vec2 dx = vec2(uDelta.x, 0.0);
        vec2 dy = vec2(0.0, uDelta.y);
        float average = (
          texture2D(tTexture, vUv - dx).r +
          texture2D(tTexture, vUv - dy).r +
          texture2D(tTexture, vUv + dx).r +
          texture2D(tTexture, vUv + dy).r
        ) * 0.25;
        info.g += (average - info.r) * 2.0;
        info.g *= 0.995;
        info.r += info.g;
        gl_FragColor = info;
      }`,
  });

  gpuNormalMat = new THREE.ShaderMaterial({
    uniforms: {
      tTexture: { value: null },
      uDelta:   { value: delta },
    },
    vertexShader: simVS,
    fragmentShader: `
      uniform sampler2D tTexture;
      uniform vec2 uDelta;
      varying vec2 vUv;
      void main(){
        vec4 info = texture2D(tTexture, vUv);
        vec3 dx = vec3(uDelta.x, texture2D(tTexture, vec2(vUv.x+uDelta.x, vUv.y)).r - info.r, 0.0);
        vec3 dy = vec3(0.0, texture2D(tTexture, vec2(vUv.x, vUv.y+uDelta.y)).r - info.r, uDelta.y);
        info.ba = normalize(cross(dy, dx)).xz;
        gl_FragColor = info;
      }`,
  });

  gpuSimInitialized = true;
  // Initial drops to prime the simulation
  for (let i = 0; i < 10; i++) {
    gpuAddDrop(
      Math.random() * 0.6 + 0.2, Math.random() * 0.6 + 0.2,
      0.02 + Math.random() * 0.03,
      (i & 1) ? 0.015 : -0.015
    );
  }
}

function gpuAddDrop(x, y, radius, strength) {
  if (!gpuSimInitialized || !poolRenderer) return;
  gpuDropMat.uniforms.tTexture.value = gpuRtA.texture;
  gpuDropMat.uniforms.uCenter.value.set(x, y);
  gpuDropMat.uniforms.uRadius.value = radius;
  gpuDropMat.uniforms.uStrength.value = strength;
  gpuSimQuad.material = gpuDropMat;
  poolRenderer.setRenderTarget(gpuRtB);
  poolRenderer.render(gpuSimScene, gpuSimCamera);
  poolRenderer.setRenderTarget(null);
  const tmp = gpuRtA; gpuRtA = gpuRtB; gpuRtB = tmp;
}

function gpuStepSim() {
  if (!gpuSimInitialized || !poolRenderer) return;
  gpuUpdateMat.uniforms.tTexture.value = gpuRtA.texture;
  gpuSimQuad.material = gpuUpdateMat;
  poolRenderer.setRenderTarget(gpuRtB);
  poolRenderer.render(gpuSimScene, gpuSimCamera);
  poolRenderer.setRenderTarget(null);
  const tmp = gpuRtA; gpuRtA = gpuRtB; gpuRtB = tmp;
}

function gpuUpdateNormals() {
  if (!gpuSimInitialized || !poolRenderer) return;
  gpuNormalMat.uniforms.tTexture.value = gpuRtA.texture;
  gpuSimQuad.material = gpuNormalMat;
  poolRenderer.setRenderTarget(gpuRtB);
  poolRenderer.render(gpuSimScene, gpuSimCamera);
  poolRenderer.setRenderTarget(null);
  const tmp = gpuRtA; gpuRtA = gpuRtB; gpuRtB = tmp;
}

// initFluidSim: backward-compat shim → GPU 초기화로 위임
function initFluidSim(){ initGPUWaterSim(); }

function stepFluidSim(delta){
  if(!gpuSimInitialized) return;
  const isMic = (mode === MODE_MIC);

  // ── onset 임펄스 — GPU 드롭으로 전달 ──
  if (_poolOnsetStrength > 0.04) {
    const str = _poolOnsetStrength;
    const shouldPulse = isMic ? (S.beat > 0.15 || LQ.bassShock > 0.10 || S.energy > 0.2) : true;
    if (shouldPulse) {
      const spots = isMic ? [
        {fx:0.5,fy:0.5},{fx:0.2,fy:0.2},{fx:0.8,fy:0.2},
        {fx:0.2,fy:0.8},{fx:0.8,fy:0.8},{fx:0.5,fy:0.15},
        {fx:0.5,fy:0.85},{fx:0.15,fy:0.5},
      ] : [{fx:0.5,fy:0.5},{fx:0.25,fy:0.35},{fx:0.75,fy:0.65}];
      const radius = 0.06 + str * (isMic ? 0.14 : 0.09);
      const amp    = str * (isMic ? 0.055 : 0.030);
      spots.forEach(sp => gpuAddDrop(sp.fx, sp.fy, radius, amp));
    }
  }

  // bass shock — 넓고 무거운 저음 파동 (large GPU drop)
  const shockThresh = isMic ? 0.05 : 0.18;
  if (LQ.bassShock > shockThresh) {
    const shockSpots = isMic ? [
      {fx:0.5,fy:0.5},{fx:0.10,fy:0.5},{fx:0.90,fy:0.5},
      {fx:0.5,fy:0.10},{fx:0.5,fy:0.90},
    ] : [{fx:0.5,fy:0.5}];
    const radius = isMic ? 0.16 : 0.12;
    const amp    = LQ.bassShock * (isMic ? 0.052 : 0.024);
    shockSpots.forEach(sp => gpuAddDrop(sp.fx, sp.fy, radius, amp));
  }

  // beat: 중간 파동 (mic 모드)
  if (isMic && S.beat > 0.20) {
    const beatSpots = [
      {fx:0.5,fy:0.5},{fx:0.3,fy:0.3},{fx:0.7,fy:0.3},
      {fx:0.3,fy:0.7},{fx:0.7,fy:0.7},{fx:0.5,fy:0.25},
    ];
    const radius = 0.07 + S.beat * 0.06;
    const amp    = S.beat * 0.032;
    beatSpots.forEach(sp => gpuAddDrop(sp.fx, sp.fy, radius, amp));
  }

  // high/air → 잔물결: 작고 빠른 다수 드롭
  if (S.high > 0.12 || S.air > 0.08) {
    const n = isMic ? 5 : 3;
    const shimmerStr = S.high * 0.020 + S.air * 0.014;
    for (let i = 0; i < n; i++) {
      gpuAddDrop(
        Math.random() * 0.8 + 0.1, Math.random() * 0.8 + 0.1,
        0.012 + Math.random() * 0.018,
        shimmerStr * (Math.random() < 0.5 ? 1 : -1)
      );
    }
  }

  // mid energy: 수면 흐름 (mic 모드)
  if (isMic && S.mid > 0.10 && Math.random() < 0.28) {
    gpuAddDrop(
      Math.random() * 0.8 + 0.1, Math.random() * 0.8 + 0.1,
      0.025 + Math.random() * 0.03,
      S.mid * 0.018 * (Math.random() < 0.5 ? 1 : -1)
    );
  }

  // 마우스 drag — GPU drop (velocity 기반)
  {
    const mux = poolMouseX, muy = 1.0 - poolMouseY;
    fluidMouseVX = fluidMouseVX * 0.62 + (mux - fluidPrevMouseUX) * 0.38;
    fluidMouseVY = fluidMouseVY * 0.62 + (muy - fluidPrevMouseUY) * 0.38;
    fluidPrevMouseUX = mux; fluidPrevMouseUY = muy;
    const speed = Math.sqrt(fluidMouseVX*fluidMouseVX + fluidMouseVY*fluidMouseVY);
    if (speed > 0.0004) {
      const radius = Math.min(0.025 + speed * 1.1, 0.14);
      const amp    = Math.min(speed * 0.75, 0.042);
      gpuAddDrop(mux, muy, radius, amp);
    } else if (speed > 0.00003) {
      gpuAddDrop(mux, muy, 0.016, speed * 0.18);
    }
  }

  // GPU wave propagation — 2 steps + normal update (reference: water.js)
  gpuStepSim();
  gpuStepSim();
  gpuUpdateNormals();
}

function buildWaterSurface(){
  const PW = POOL_DIMENSIONS.width, PD = POOL_DIMENSIONS.length;
  initFluidSim(); // → initGPUWaterSim()

  const waterGeom = new THREE.PlaneGeometry(PW, PD, 160, 240);

  const fallbackNormals = makeProceduralWaterNormals(1024);
  poolWaterNormals = fallbackNormals;
  new THREE.TextureLoader().load(
    "assets/waternormals.jpg",
    (tex)=>{
      tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
      tex.repeat.set(2.0, 2.0);
      poolWaterNormals = tex;
      if(waterMesh && waterMesh.material && waterMesh.material.uniforms['tNormal']){
        waterMesh.material.uniforms['tNormal'].value = tex;
      }
    },
    undefined, ()=>{}
  );

  // madebyevan WebGL Water 스타일 — GPU 시뮬 + Fresnel 반사/굴절 + caustics
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      tNormal:       { value: poolWaterNormals },
      tGPUWater:     { value: gpuRtA ? gpuRtA.texture : null },
      tCaustics:     { value: poolCausticsTex },
      uTime:         { value: 0 },
      uSunDir:       { value: new THREE.Vector3(0.42, 0.95, 0.28).normalize() },
      uSunColor:     { value: new THREE.Color(0xfff8e8) },
      uWaterDeep:    { value: new THREE.Color(0x0a3d5c) },
      uWaterMid:     { value: new THREE.Color(0x1a88cc) },
      uWaterShallow: { value: new THREE.Color(0x5ec8f0) },
      uCameraPos:    { value: new THREE.Vector3() },
      uFluidStrength:{ value: 0.0 },
      uSub:          { value: 0 },
      uMid:          { value: 0 },
      uHigh:         { value: 0 },
      uBeat:         { value: 0 },
      uMouseSpeed:   { value: 0 },
      uPaletteR:     { value: 0.5 },
      uPaletteG:     { value: 0.7 },
      uPaletteB:     { value: 1.0 },
    },
    vertexShader:`
      uniform sampler2D tGPUWater;
      uniform float uTime, uSub, uBeat, uFluidStrength;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying float vHeight;
      varying vec4 vSimData;
      void main(){
        vUv = uv;
        // GPU fluid: R=height (direct float), BA=normal XZ
        vec4 sim = texture2D(tGPUWater, uv);
        vSimData = sim;
        float h = sim.r * 0.44 * uFluidStrength;
        // 저음 너울
        float swell = sin(position.x*0.18+uTime*0.5)*0.028*uSub
                    + cos(position.z*0.14+uTime*0.4)*0.020*uSub;
        float beatBump = sin(length(position.xz)*0.6-uTime*5.5)*0.020*uBeat;
        // edge clamp (가장자리 고정)
        float ex = smoothstep(0.0,0.07,uv.x)*smoothstep(1.0,0.93,uv.x);
        float ey = smoothstep(0.0,0.07,uv.y)*smoothstep(1.0,0.93,uv.y);
        float em = ex * ey;
        float disp = (h + swell + beatBump) * em;
        vec3 pos = position + vec3(0.0, disp, 0.0);
        vHeight = disp;
        vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader:`
      precision highp float;
      uniform sampler2D tNormal;
      uniform sampler2D tGPUWater;
      uniform sampler2D tCaustics;
      uniform float uTime,uSub,uMid,uHigh,uBeat,uMouseSpeed,uFluidStrength;
      uniform float uPaletteR,uPaletteG,uPaletteB;
      uniform vec3 uSunDir,uSunColor,uWaterDeep,uWaterMid,uWaterShallow,uCameraPos;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying float vHeight;
      varying vec4 vSimData;

      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){
        vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }

      void main(){
        // ── GPU 시뮬 노말 재구성 (reference: water.js normalShader)
        // BA = normalize(cross(dy,dx)).xz — 직접 float 저장
        vec4 sim = texture2D(tGPUWater, vUv);
        vec2 nXZ = sim.ba;
        // "make water look more peaked" (reference renderer.js)
        vec2 coord = vUv;
        for(int i=0;i<5;i++){
          coord += sim.ba * 0.005;
          sim = texture2D(tGPUWater, coord);
        }
        nXZ = sim.ba;
        float ny = sqrt(max(0.001, 1.0 - nXZ.x*nXZ.x - nXZ.y*nXZ.y));
        vec3 simNorm = normalize(vec3(nXZ.x, ny, nXZ.y));

        // 미세 노말맵 레이어 (high-freq 잔결)
        vec2 uv1 = vUv*2.2 + vec2(uTime*0.022, uTime*0.016);
        vec2 uv2 = vUv*5.8 + vec2(-uTime*0.040, uTime*0.030);
        vec3 dn1 = texture2D(tNormal,uv1).rgb*2.0-1.0;
        vec3 dn2 = texture2D(tNormal,uv2).rgb*2.0-1.0;
        vec3 detailN = normalize(dn1*0.55+dn2*0.45);
        float detailBlend = 0.10 + uHigh*0.18 + uMouseSpeed*0.14;
        vec3 normal = normalize(simNorm*(1.0-detailBlend) + detailN*detailBlend);

        // ── Fresnel (Schlick) ──
        vec3 viewDir = normalize(uCameraPos - vWorldPos);
        float cosTheta = max(dot(normal, viewDir), 0.0);
        float fresnel = 0.02 + 0.98*pow(1.0-cosTheta, 5.0);
        fresnel = mix(0.06, 1.0, fresnel);

        // ── 굴절: 수면 아래 풀 바닥 (pool bottom through refraction) ──
        // normal XZ → UV 오프셋으로 굴절 근사
        vec2 refractOfs = nXZ * 0.20 * clamp(uFluidStrength*0.6, 0.4, 2.0);
        vec4 cSample = texture2D(tCaustics, vUv*0.5 + refractOfs*0.28 + 0.25);
        // 바닥 기본색
        vec3 poolBtm = mix(uWaterDeep, uWaterMid, 0.42);
        // caustics 광점 (굴절광)
        float cLight = cSample.r*(0.9 + uMid*0.6 + uBeat*0.5 + uMouseSpeed*0.35);
        poolBtm += vec3(0.60,0.92,1.0)*cLight*0.42;
        // 절차적 caustics (normal 기반)
        float pc = noise(vUv*9.5+vec2(uTime*0.30))*noise(vUv*17.0-vec2(uTime*0.22));
        pc = smoothstep(0.45,0.78,pc)*(0.14+uMid*0.18+uBeat*0.12+uMouseSpeed*0.10);
        poolBtm += vec3(0.55,0.90,1.0)*pc;
        // 깊이 감쇠
        float depth = clamp(-vHeight*2.5+0.42, 0.0, 1.0);
        poolBtm = mix(poolBtm, uWaterDeep, depth*0.65);
        // 수면 통과 산란
        float scatter = max(dot(normal, uSunDir),0.0);
        vec3 wColor = mix(uWaterShallow, uWaterMid, depth);
        wColor *= 0.55 + scatter*0.65;
        poolBtm = mix(poolBtm, poolBtm*0.6+wColor*0.5, 0.35);

        // ── 반사: 하늘 + 태양 글린트 ──
        vec3 reflRay = reflect(-viewDir, normal);
        float skyH = clamp(reflRay.y*0.5+0.5, 0.0, 1.0);
        // 밤하늘 pool 분위기
        vec3 skyRefl = mix(vec3(0.04,0.12,0.24), vec3(0.22,0.50,0.80), skyH*skyH);
        // 태양 글린트 (sharp + halo)
        float sunDot  = max(dot(reflRay, uSunDir), 0.0);
        float sunSpec = pow(sunDot, 750.0);
        float sunHalo = pow(sunDot, 22.0)*0.18;
        float shimmer = uHigh*0.75 + uMouseSpeed*0.45 + uBeat*0.22;
        sunSpec *= (2.8 + shimmer*2.2);
        skyRefl += uSunColor*(sunSpec + sunHalo);
        // 수면 sparkle (파고 반짝임)
        float sparkle = noise(vUv*15.0+vec2(uTime*0.40));
        sparkle = smoothstep(0.74,0.97,sparkle)*(uHigh*0.12+uBeat*0.08+uMouseSpeed*0.10);
        skyRefl += vec3(0.88,0.97,1.0)*sparkle;

        // ── 최종 합성 ──
        vec3 palColor = vec3(uPaletteR,uPaletteG,uPaletteB);
        poolBtm = mix(poolBtm, poolBtm*palColor*1.10, 0.07);
        vec3 col = mix(poolBtm, skyRefl, fresnel);
        // 파고(波高) 밝기
        col += vec3(0.78,0.95,1.0)*max(0.0,vHeight)*0.20;
        // beat 펄스
        col += vec3(0.40,0.78,1.0)*uBeat*0.044;
        // sub → 깊은 블루 가압
        col = mix(col, col*vec3(0.92,0.96,1.04), uSub*0.08);
        col = pow(max(col,vec3(0.0)),vec3(0.90));

        // alpha: Fresnel → 정면 맑게, 경사 반사
        float alpha = mix(0.24, 0.80, fresnel*fresnel);
        alpha += uSub*0.06 + uBeat*0.04;
        alpha = clamp(alpha, 0.17, 0.82);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  waterMesh = new THREE.Mesh(waterGeom, waterMat);
  waterMesh.rotation.x = -Math.PI * 0.5;
  waterMesh.position.y = POOL_WATER_LEVEL;
  poolScene.add(waterMesh);

  poolUnderGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(PW + 0.2, PD + 0.2),
    new THREE.MeshBasicMaterial({
      color:0xaae8ff, transparent:true, opacity:0.045,
      blending:THREE.AdditiveBlending, depthWrite:false
    })
  );
  poolUnderGlow.rotation.x = -Math.PI * 0.5;
  poolUnderGlow.position.y = POOL_WATER_LEVEL - 0.04;
  poolScene.add(poolUnderGlow);
}

// ── pia.glb 로드
function loadPiaModel(){
  const loader=new GLTFLoader();
  loader.load("assets/pia.glb",(gltf)=>{
    piaModel=gltf.scene;
    piaModel.traverse((c)=>{
      if(!c.isMesh) return;
      c.castShadow=true; c.receiveShadow=true;
      const mats=Array.isArray(c.material)?c.material:[c.material];
      mats.forEach((m)=>{
        if(!m) return;
        if("roughness" in m) m.roughness=Math.max(0.04,(m.roughness??0.5)*0.42);
        if("metalness" in m) m.metalness=Math.min(0.72,(m.metalness??0.0)+0.10);
        if("emissive" in m && "emissiveIntensity" in m){
          if(!m._origEmissive) m._origEmissive=m.emissive.clone();
          m.emissive=new THREE.Color(0x3399cc);
          m.emissiveIntensity=0.04;
        }
        m.needsUpdate=true;
      });
    });

    let box=new THREE.Box3().setFromObject(piaModel);
    const size=box.getSize(new THREE.Vector3());
    const maxDim=Math.max(size.x,size.y,size.z)||1;

    const scale=(22.0*POOL_SCENE_SCALE)/maxDim;
    piaModel.scale.setScalar(scale);

    box=new THREE.Box3().setFromObject(piaModel);
    const center=box.getCenter(new THREE.Vector3());

    const floorY = -POOL_DIMENSIONS.depth + POOL_WATER_LEVEL;
    piaModel.position.set(
      -center.x + 0.8,
      floorY - box.min.y + 0.02,
      -center.z - 4.5          // 카메라 반대방향으로 밀어서 아래쪽 여백 확보
    );
    piaModel.rotation.y=Math.PI*0.18;
    piaModel.rotation.x=Math.PI*0.02;
    piaModel._baseY=piaModel.position.y;
    piaModel._baseRotY=piaModel.rotation.y;

    poolScene.add(piaModel);
    piaLoaded=true;
  },undefined,(err)=>console.warn("pia.glb 로드 실패:",err));
}

function initPoolComposer(){
  poolComposer=new EffectComposer(poolRenderer);
  const renderPass=new RenderPass(poolScene,poolCamera);
  poolComposer.addPass(renderPass);
  poolDropPass=new ShaderPass(POOL_DROP_SHADER);
  poolComposer.addPass(poolDropPass);
}

function updateWaterSurface(delta){
  if(!waterMesh||!waterMesh.material||!waterMesh.material.uniforms) return;
  const u = waterMesh.material.uniforms;

  // 유체 시뮬 업데이트
  stepFluidSim(delta);

  const t = poolTime;
  if(u['uTime']) u['uTime'].value = t;
  if(u['uCameraPos']) u['uCameraPos'].value.copy(poolCamera.position);
  if(u['tFluid']) u['tFluid'].value = poolFluidTex;
  if(u['tNormal']) u['tNormal'].value = poolWaterNormals;

  // 유체 시뮬 반영 강도 — 음악 반응 (마이크 모드: 풀이 완전히 노래에 빠진 느낌)
  const isMicW = (mode === MODE_MIC);
  const fluidStrength = isMicW
    ? (2.0 + LQ.subPressure * 7.0 + poolMouseSpeed * 3.0 + S.beat * 2.5 + S.mid * 1.5 + S.energy * 2.0)
    : (1.05 + LQ.subPressure * 2.8 + poolMouseSpeed * 2.2 + S.beat * 0.72);
  if(u['uFluidStrength']) u['uFluidStrength'].value += (fluidStrength - u['uFluidStrength'].value) * (isMicW ? 0.35 : 0.18);

  if(u['uSub']) u['uSub'].value = isMicW ? Math.min(S.sub * 2.0, 1) : S.sub;
  if(u['uMid']) u['uMid'].value = isMicW ? Math.min(S.mid * 1.8, 1) : S.mid;
  if(u['uHigh']) u['uHigh'].value = isMicW ? Math.min(LQ.highShimmer * 1.6, 1) : LQ.highShimmer;
  if(u['uBeat']) u['uBeat'].value = isMicW
    ? Math.min(1, (S.beat + LQ.bassShock * 0.8) * 1.5)
    : Math.min(1, S.beat + LQ.bassShock * 0.5);
  if(u['uMouseSpeed']) u['uMouseSpeed'].value = poolMouseSpeed;

  // 팔레트 색상 반영 — 미세하게
  if(u['uPaletteR']) u['uPaletteR'].value = curPal.r / 255;
  if(u['uPaletteG']) u['uPaletteG'].value = curPal.g / 255;
  if(u['uPaletteB']) u['uPaletteB'].value = curPal.b / 255;

  // 물 색상 — 더 맑고 깊은 pool blue
  const poolBlueDeep    = new THREE.Color(0x062840);
  const poolBlueMid     = new THREE.Color(0x1472b8);
  const poolBlueShallow = new THREE.Color(0x4ec8ee);
  // 팔레트에서 미세 영향
  const pr = curPal.r/255, pg = curPal.g/255, pb = curPal.b/255;
  if(u['uWaterDeep'])    u['uWaterDeep'].value.setRGB(
    0.024 + pr * 0.04, 0.156 + pg * 0.06, 0.252 + pb * 0.08);
  if(u['uWaterMid'])     u['uWaterMid'].value.setRGB(
    0.08 + pr * 0.06,  0.44 + pg * 0.10,  0.72 + pb * 0.12);
  if(u['uWaterShallow']) u['uWaterShallow'].value.setRGB(
    0.20 + pr * 0.08,  0.72 + pg * 0.10,  0.92 + pb * 0.06);

  // undrer glow
  if(poolUnderGlow){
    poolUnderGlow.material.opacity = 0.050 + LQ.midDensity*0.065 + LQ.highShimmer*0.042 + poolMouseSpeed*0.025 + S.beat*0.02;
    const sc = 1 + S.beat * 0.018 + LQ.subPressure * 0.024;
    poolUnderGlow.scale.set(sc,sc,sc);
  }

  if(poolWaterVolume && poolWaterVolume.material){
    const m = poolWaterVolume.material;
    m.color.setRGB(
      Math.min(1, 0.22 + pr * 0.14),
      Math.min(1, 0.68 + pg * 0.12),
      Math.min(1, 0.90 + pb * 0.08)
    );
    m.emissive.setRGB(
      0.06 + pr * 0.06,
      0.22 + pg * 0.10,
      0.32 + pb * 0.10
    );
    m.opacity = 0.18 + LQ.midDensity * 0.06 + LQ.highShimmer * 0.03;
  }

  poolGlassWalls.forEach((wall, wi)=>{
    const m = wall.material;
    if(!m) return;
    m.color.setRGB(0.86 + pr * 0.06, 0.94 + pg * 0.05, 0.99);
    const isMicWall = (mode === MODE_MIC);
    // 마이크: 벽도 beat에 맞춰 밝아지고 진동
    const wallBeatPulse = isMicWall ? (S.beat * 0.12 + LQ.bassShock * 0.10) : 0;
    m.opacity = 0.18 + LQ.highShimmer * 0.07 + S.air * 0.04 + S.beat * 0.02 + wallBeatPulse;
    // 마이크: 벽 위치 미세 진동 (안쪽으로 찔끔 움직이는 느낌)
    if(isMicWall && wall._basePos) {
      const vibAmt = S.beat * 0.06 + LQ.bassShock * 0.08 + S.sub * 0.03;
      const vibPhase = (poolTime || 0) * 18 + wi * 1.57;
      const vibX = Math.sin(vibPhase) * vibAmt * wall._vibDir.x;
      const vibZ = Math.sin(vibPhase * 1.3) * vibAmt * wall._vibDir.z;
      wall.position.x = wall._basePos.x + vibX;
      wall.position.z = wall._basePos.z + vibZ;
    } else if(isMicWall && !wall._basePos) {
      wall._basePos = wall.position.clone();
      // 벽 방향에 따른 진동 방향 (법선 방향)
      const nx = Math.abs(wall.position.x) > Math.abs(wall.position.z) ? Math.sign(wall.position.x) : 0;
      const nz = Math.abs(wall.position.z) > Math.abs(wall.position.x) ? Math.sign(wall.position.z) : 0;
      wall._vibDir = { x: nx || 0.5, z: nz || 0.5 };
    }
  });

  poolWallPanels.forEach((wall, wi)=>{
    const m = wall.material;
    if(!m) return;
    const isMicPanel = (mode === MODE_MIC);
    m.color.setRGB(
      Math.min(1, 0.28 + pr * 0.18),
      Math.min(1, 0.70 + pg * 0.16),
      Math.min(1, 0.90 + pb * 0.10)
    );
    m.emissive.setRGB(0.05 + pr*0.06, 0.22 + pg*0.10, 0.30 + pb*0.08);
    // 마이크: 벽 패널도 beat/bass에 맞춰 빛이 커짐
    const panelBeatGlow = isMicPanel ? (S.beat * 0.16 + LQ.bassShock * 0.14 + S.sub * 0.08) : 0;
    m.opacity = 0.24 + LQ.midDensity * 0.10 + LQ.highShimmer * 0.08 + S.beat * 0.03 + panelBeatGlow;
    m.emissiveIntensity = 0.28 + LQ.highShimmer * 0.26 + S.air * 0.14 + S.beat * 0.06
      + (isMicPanel ? (S.beat * 0.35 + LQ.bassShock * 0.28 + S.mid * 0.15) : 0);
    // 마이크: 벽 패널 위치 진동
    if(isMicPanel && wall._basePos) {
      const vibAmt = S.beat * 0.05 + LQ.bassShock * 0.06 + S.bass * 0.025;
      const vibPhase = (poolTime || 0) * 22 + wi * 2.09;
      wall.position.x = wall._basePos.x + Math.sin(vibPhase) * vibAmt * (wall._vibDir?.x || 0);
      wall.position.z = wall._basePos.z + Math.cos(vibPhase * 0.8) * vibAmt * (wall._vibDir?.z || 0);
    } else if(isMicPanel && !wall._basePos) {
      wall._basePos = wall.position.clone();
      const nx = Math.abs(wall.position.x) > Math.abs(wall.position.z) ? Math.sign(wall.position.x) : 0;
      const nz = Math.abs(wall.position.z) > Math.abs(wall.position.x) ? Math.sign(wall.position.z) : 0;
      wall._vibDir = { x: nx || 0.5, z: nz || 0.5 };
    }
  });

  poolWallCaustics.forEach((wall, wi)=>{
    const m = wall.material;
    if(!m) return;
    const isMicC = (mode === MODE_MIC);
    const caustBeat = isMicC ? (S.beat * 0.18 + LQ.bassShock * 0.14 + S.mid * 0.08) : 0;
    m.opacity = 0.08 + LQ.highShimmer * 0.16 + S.air * 0.07 + poolMouseSpeed * 0.05 + S.beat * 0.04 + caustBeat;
    // 마이크: caustics 패턴 진동 — scale pulse
    if(isMicC) {
      const pulseScale = 1 + S.beat * 0.04 + LQ.bassShock * 0.03;
      wall.scale.set(pulseScale, pulseScale, 1);
    }
  });

  // ── Dawn water: 물색이 맑고 투명하게 ──
  if(_poolDawnSmooth > 0.001) {
    const d = _poolDawnSmooth;
    // 물 deep/mid/shallow → 더 밝고 맑은 터쿼이즈
    if(u['uWaterDeep']) {
      u['uWaterDeep'].value.r += d * 0.06;
      u['uWaterDeep'].value.g += d * 0.14;
      u['uWaterDeep'].value.b += d * 0.10;
    }
    if(u['uWaterMid']) {
      u['uWaterMid'].value.r += d * 0.08;
      u['uWaterMid'].value.g += d * 0.12;
      u['uWaterMid'].value.b += d * 0.06;
    }
    if(u['uWaterShallow']) {
      u['uWaterShallow'].value.r += d * 0.10;
      u['uWaterShallow'].value.g += d * 0.06;
      u['uWaterShallow'].value.b += d * 0.03;
    }
    // water volume → 더 투명하게
    if(poolWaterVolume && poolWaterVolume.material) {
      poolWaterVolume.material.opacity *= (1 - d * 0.35);
    }
    // 유리벽 → 더 맑게
    poolGlassWalls.forEach((wall) => {
      if(wall.material) wall.material.opacity *= (1 - d * 0.25);
    });
  }
}

function buildProceduralCaustics(){
  poolCausticsCanvas=document.createElement("canvas");
  poolCausticsCanvas.width=512; poolCausticsCanvas.height=512;
  poolCausticsCtx=poolCausticsCanvas.getContext("2d");
  poolCausticsTex=new THREE.CanvasTexture(poolCausticsCanvas);
  poolCausticsTex.wrapS=THREE.RepeatWrapping;
  poolCausticsTex.wrapT=THREE.RepeatWrapping;
  poolCausticsTex.repeat.set(2.0,2.0);
}

function updateProceduralCaustics(time){
  if(!poolCausticsCtx||!poolCausticsTex) return;
  const ctx2=poolCausticsCtx;
  const W=poolCausticsCanvas.width, H=poolCausticsCanvas.height;
  ctx2.clearRect(0,0,W,H);
  // 배경 — 매우 짙은 딥 블루
  ctx2.fillStyle="#020d14"; ctx2.fillRect(0,0,W,H);
  ctx2.globalCompositeOperation="lighter";

  // caustics 강도 — mid가 올라가면 세지고, air도 반응
  // 평소엔 절제, 과하면 안 됨
  const base = 0.08;
  const musicBoost = LQ.midDensity * 0.30 + S.air * 0.16 + LQ.highShimmer * 0.15;
  const sparkle = base + musicBoost;
  const pulse = 1 + S.beat * 0.24 + LQ.bassShock * 0.18;

  // 큰 물빛 패턴 — Voronoi-like caustic 모양
  for(let i=0;i<18;i++){
    const ang=i/18*Math.PI*2;
    const r=0.30+Math.sin(time*0.18+i*0.77)*0.14;
    const px=W*(0.5+r*Math.cos(ang+time*(0.04+i*0.003)));
    const py=H*(0.5+r*Math.sin(ang*1.1+time*(0.035+i*0.004)));
    const rad=(18+(i%4)*12+Math.sin(time*0.9+i*0.6)*6)*pulse;
    const g=ctx2.createRadialGradient(px,py,0,px,py,rad);
    // 더 차갑고 투명한 pool blue
    const alpha1=(0.038+sparkle*0.072);
    const alpha2=(0.018+sparkle*0.042);
    g.addColorStop(0,`rgba(180,238,255,${alpha1.toFixed(3)})`);
    g.addColorStop(0.5,`rgba(100,200,255,${alpha2.toFixed(3)})`);
    g.addColorStop(1,"rgba(60,160,220,0)");
    ctx2.fillStyle=g;
    ctx2.beginPath(); ctx2.arc(px,py,rad,0,Math.PI*2); ctx2.fill();
  }

  // 잔물결 라인 — 절제된 스트라이프
  const lineCount=24;
  for(let i=0;i<lineCount;i++){
    const y=(i/lineCount)*H;
    const amp=4.5+LQ.subPressure*10+S.beat*8;
    const alpha=(0.008+sparkle*0.024);
    if(alpha<0.003) continue;
    ctx2.strokeStyle=`rgba(160,230,255,${alpha.toFixed(3)})`;
    ctx2.lineWidth=0.9; ctx2.beginPath();
    for(let x=0;x<=W;x+=6){
      const yy=y+Math.sin(x*0.025+time*2.0+i*0.42)*amp;
      x===0?ctx2.moveTo(x,yy):ctx2.lineTo(x,yy);
    }
    ctx2.stroke();
  }

  // 수면 교차 반짝임 — beat 때 잠깐 더 밝게
  if(S.beat > 0.28 || LQ.bassShock > 0.10){
    const flashAlpha=(S.beat*0.08+LQ.bassShock*0.06);
    ctx2.fillStyle=`rgba(220,250,255,${flashAlpha.toFixed(3)})`;
    ctx2.fillRect(0,0,W,H);
  }

  ctx2.globalCompositeOperation="source-over";
  poolCausticsTex.needsUpdate=true;
}

function updateRainSystem(delta){
  return; // 비 시스템 비활성화
}

function renderPoolScene(delta){
  if(!poolRenderer||!poolScene||!poolCamera||!poolActive) return;
  poolTime+=delta;
  // 점성 감쇠 — 빠른 움직임 후엔 관성 남도록
  poolMouseSpeed *= (poolMouseSpeed > 0.15 ? 0.92 : 0.80);
  updateRainSystem(delta);
  updateProceduralCaustics(poolTime);
  updateWaterSurface(delta);

  if(poolScene._skyMat) poolScene._skyMat.uniforms.uTime.value=poolTime;

  // ── Pool Sky Dawn: 곡 끝 무렵 하늘이 맑고 청아하게 밝아짐 ──
  {
    let songProgress = 0;
    if(mode === MODE_FILE && audioEl.duration > 0 && isPlaying) {
      songProgress = audioEl.currentTime / audioEl.duration;
    }
    // 곡의 마지막 ~28%에서 서서히 시작, 끝에서 최대
    const dawnOnset = 0.72;
    const rawDawn = Math.max(0, (songProgress - dawnOnset) / (1.0 - dawnOnset));
    // ease-in-out cubic for natural feel
    _poolDawnFactor = rawDawn < 0.5
      ? 4 * rawDawn * rawDawn * rawDawn
      : 1 - Math.pow(-2 * rawDawn + 2, 3) / 2;
    // 곡 안 재생중이면 천천히 원래 밤으로 복귀
    if(!isPlaying || songProgress < dawnOnset) {
      _poolDawnFactor = 0;
    }
    // 부드러운 추적 (급격한 점프 방지)
    _poolDawnSmooth += (_poolDawnFactor - _poolDawnSmooth) * 0.012;
    const d = _poolDawnSmooth;

    if(poolScene._skyMat && d > 0.001) {
      const u = poolScene._skyMat.uniforms;
      // 밤하늘 → 맑은 청아한 하늘로 lerp
      // Top:  0x010306 → 0x1e5a9e (깊은 코발트)
      u.uTopColor.value.r += (0.118 - u.uTopColor.value.r) * d;
      u.uTopColor.value.g += (0.353 - u.uTopColor.value.g) * d;
      u.uTopColor.value.b += (0.620 - u.uTopColor.value.b) * d;
      // Mid:  0x03080f → 0x5aaad5 (밝은 스카이블루)
      u.uMidColor.value.r += (0.353 - u.uMidColor.value.r) * d;
      u.uMidColor.value.g += (0.667 - u.uMidColor.value.g) * d;
      u.uMidColor.value.b += (0.835 - u.uMidColor.value.b) * d;
      // Horizon: 0x060e18 → 0xb8ddf0 (밝고 투명한 수평선)
      u.uHorizonColor.value.r += (0.722 - u.uHorizonColor.value.r) * d;
      u.uHorizonColor.value.g += (0.867 - u.uHorizonColor.value.g) * d;
      u.uHorizonColor.value.b += (0.941 - u.uHorizonColor.value.b) * d;
      // Sun: 0x1a3a6a → 0x7ec8f0 (맑고 선명한 태양빛)
      u.uSunColor.value.r += (0.494 - u.uSunColor.value.r) * d;
      u.uSunColor.value.g += (0.784 - u.uSunColor.value.g) * d;
      u.uSunColor.value.b += (0.941 - u.uSunColor.value.b) * d;
    }

    // Scene background + fog 밝아짐
    if(d > 0.001) {
      // bg: 0x020508 → 0x1a4878 (청아한 딥블루)
      const bgR = 0.008 + (0.102 - 0.008) * d;
      const bgG = 0.020 + (0.282 - 0.020) * d;
      const bgB = 0.031 + (0.471 - 0.031) * d;
      poolScene.background.setRGB(bgR, bgG, bgB);
      // fog: 밀도를 살짝 낮추고 색상 밝게
      if(poolScene.fog) {
        poolScene.fog.color.setRGB(bgR * 1.2, bgG * 1.15, bgB * 1.08);
        poolScene.fog.density = 0.010 - d * 0.004;  // 안개 걷힘
      }
    }
  }

  if(piaLoaded&&piaModel){
    const isMicPia = (mode === MODE_MIC);
    const subMul = isMicPia ? 3.5 : 1.0;
    const beatMul = isMicPia ? 2.5 : 1.0;
    piaModel.position.y=piaModel._baseY+Math.sin(poolTime*0.8)*0.035*(1+LQ.subPressure*2.0*subMul)+S.beat*0.055*beatMul+LQ.bassShock*0.08*beatMul;
    piaModel.rotation.z=Math.sin(poolTime*0.6)*0.008*(1+LQ.subPressure*2.2*subMul)
      + (isMicPia ? S.beat * 0.025 : 0);
    piaModel.rotation.x=Math.PI*0.02+Math.cos(poolTime*0.5)*0.007*(1+LQ.midDensity*1.4)
      + (isMicPia ? S.mid * 0.012 : 0);
    // 수면 caustics 물빛 — 아주 약하게 fluctuate
    piaModel.traverse((c)=>{
      if(!c.isMesh||!c.material) return;
      const mats=Array.isArray(c.material)?c.material:[c.material];
      mats.forEach((m)=>{
        if(m&&"emissiveIntensity" in m){
          const target=0.04 + LQ.midDensity*0.09 + LQ.highShimmer*0.06 + Math.sin(poolTime*1.2)*0.016 + S.beat*0.04;
          m.emissiveIntensity+=(target-m.emissiveIntensity)*0.10;
        }
      });
    });
  }

  if(poolScene._causticsLight){
    const l=poolScene._causticsLight;
    const isMicL = (mode === MODE_MIC);
    // 마이크: caustics 조명이 beat에 맞춰 확 밝아짐
    l.intensity = 1.0 + LQ.midDensity*1.8 + LQ.highShimmer*1.2 + poolMouseSpeed*0.8 + S.beat*0.6
      + (isMicL ? (S.beat * 3.0 + LQ.bassShock * 2.5 + S.mid * 1.2) : 0);
    l.color.setRGB(0.45+curPal.r/255*0.18, 0.88+curPal.g/255*0.10, 1.0);
    l.position.x = Math.sin(poolTime*0.4)*1.0;
    l.position.z = Math.cos(poolTime*0.32)*0.8;
  }
  if(poolScene._waterLight){
    const l=poolScene._waterLight;
    const isMicL = (mode === MODE_MIC);
    l.intensity=2.5+S.sub*4.5+LQ.midDensity*2.8+LQ.highShimmer*2.0+poolMouseSpeed*2.0+S.beat*1.5
      + (isMicL ? (S.beat * 4.0 + S.energy * 3.0 + LQ.bassShock * 3.0) : 0);
    l.color.setRGB(0.30+curPal.r/255*0.25,0.82+curPal.g/255*0.16,1.0);
  }
  if(poolScene._beatLight){
    const l=poolScene._beatLight;
    const isMicL = (mode === MODE_MIC);
    l.intensity = S.beat*9.0+LQ.bassShock*7.0 + (isMicL ? (S.beat * 8.0 + S.sub * 4.0) : 0);
    l.color.setRGB(0.40+curPal.r/255*0.30,0.92,1.0);
  }
  if(poolScene._caustic){
    const c=poolScene._caustic;
    c.material.opacity=0.26+LQ.highShimmer*0.35+S.air*0.14+poolMouseSpeed*0.10+S.beat*0.06;
    const sc=1+Math.sin(poolTime*1.15)*0.038+S.beat*0.055;
    c.scale.set(sc,sc,sc);
    c.rotation.z+=delta*(0.022+S.air*0.055);
  }
  if(poolFloor&&poolFloor.material){
    poolFloor.material.color.setRGB(0.18+curPal.r/255*0.10, 0.50+curPal.g/255*0.12, 0.68+curPal.b/255*0.12);
    poolFloor.material.emissiveIntensity = 0.24 + LQ.midDensity*0.22 + LQ.highShimmer*0.16 + S.beat*0.06;
  }

  // ── Dawn lighting: 하늘과 함께 조명도 밝아짐 ──
  if(_poolDawnSmooth > 0.001) {
    const d = _poolDawnSmooth;
    // Hemisphere: 밝기 + 하늘색 톤
    if(poolScene._hemi) {
      poolScene._hemi.intensity = 1.7 + d * 2.8;
      // skyColor → 더 밝은 하늘색으로
      poolScene._hemi.color.r += (0.88 - poolScene._hemi.color.r) * d * 0.5;
      poolScene._hemi.color.g += (0.94 - poolScene._hemi.color.g) * d * 0.5;
      poolScene._hemi.color.b += (1.0  - poolScene._hemi.color.b) * d * 0.5;
    }
    // 바닥도 살짝 밝아짐
    if(poolFloor&&poolFloor.material) {
      poolFloor.material.color.r += d * 0.08;
      poolFloor.material.color.g += d * 0.12;
      poolFloor.material.color.b += d * 0.10;
    }
  }
  if(poolOrbitControls) poolOrbitControls.update();
  if(poolDropPass){
    poolDropPass.uniforms.uTime.value=poolTime;
    poolDropPass.uniforms.uBeat.value=Math.min(1,S.beat+LQ.bassShock*0.42);
    poolDropPass.uniforms.uShimmer.value=Math.min(1,LQ.highShimmer+S.air*0.4);
    poolDropPass.uniforms.uSub.value=Math.min(1,LQ.subPressure);
    poolDropPass.uniforms.uMid.value=Math.min(1,LQ.midDensity);
    poolDropPass.uniforms.uAir.value=Math.min(1,S.air);
    poolDropPass.uniforms.uMouseX.value=poolMouseX;
    poolDropPass.uniforms.uMouseY.value=poolMouseY;
    poolDropPass.uniforms.uMouseSpeed.value=poolMouseSpeed;
    poolDropPass.uniforms.uResolution.value.set(window.innerWidth,window.innerHeight);
  }
  if(poolComposer) poolComposer.render(delta);
  else poolRenderer.render(poolScene,poolCamera);
  drawPoolRain();
}

function drawPoolRain(){
  if(!rainCtx2||!rainCv) return;
  const W=window.innerWidth, H=window.innerHeight;
  rainCtx2.clearRect(0,0,W,H);
  return; // 비 효과 비활성화

  // fade in/out intensity smoothly
  const rawIntensity=poolRainActive?(1.0-poolRainTimer/poolRainDuration*0.25):0;
  const fadeIn=poolRainActive?Math.min(1, (poolRainDuration-poolRainTimer)*0.35):0;
  const fadeOut=poolRainActive?Math.min(1, poolRainTimer*0.5):0;
  const rainIntensity=rawIntensity*fadeIn*fadeOut;

  // gentle global wind drift that shifts over time
  const windT=poolTime||0;
  const globalWind=Math.sin(windT*0.25)*0.015+Math.sin(windT*0.11)*0.008;

  poolRainDrops.forEach((d)=>{
    const bv=S[d.band]||0;
    // smaller drops react less to music — more natural
    const musicMult=1+bv*1.2*d.size+S.energy*0.35;
    const spd=d.spd*musicMult*(poolRainActive?1.2:0.08);
    d.y+=spd;
    if(d.y>1.12){d.y=-0.06-Math.random()*0.08;d.x=Math.random();}
    if(!poolRainActive&&rainIntensity<0.03) return;

    // wind sway — each drop has its own phase, light drops sway more
    const windSway=globalWind*(1.4-d.size*0.9)+Math.sin(windT*0.6+d.windPhase)*0.004*(1-d.size*0.6);
    d.x+=windSway;
    if(d.x<-0.02) d.x=1.02;
    if(d.x>1.02) d.x=-0.02;

    const x=d.x*W, y=d.y*H;
    const len=d.len*H*(0.35+bv*0.35+d.size*0.25)*(0.5+rainIntensity*0.7);
    const angle=d.angle+globalWind*2.8;
    const dx=Math.sin(angle)*len*0.18, dy=Math.cos(angle)*len;

    // opacity: smaller drops are more transparent, smoother falloff
    const al=d.opacity*(0.25+bv*0.35)*rainIntensity*(0.45+LQ.midDensity*0.35);
    if(al<0.003) return;

    // color variation: heavier drops slightly bluer, lighter ones more white
    const colorB=Math.round(235+d.size*20);
    const colorG=Math.round(225+d.size*10+(1-d.size)*20);

    rainCtx2.beginPath();
    rainCtx2.strokeStyle=`rgba(${210+Math.round((1-d.size)*25)},${colorG},${colorB},${al.toFixed(3)})`;
    rainCtx2.lineWidth=d.thick*(0.5+bv*0.3);
    rainCtx2.lineCap='round';
    rainCtx2.moveTo(x,y); rainCtx2.lineTo(x+dx,y+dy); rainCtx2.stroke();

    // ripples — only heavy drops near water surface, less frequent
    if(poolRainActive&&d.size>0.45&&d.y>0.56&&d.y<0.64&&Math.random()<0.08+S.beat*0.10){
      const rippleSize=4+d.size*14+bv*8+S.beat*6;
      poolRipples.push({
        x, y:d.y*H,
        r:0, maxR:rippleSize,
        life:1, decay:0.028+Math.random()*0.035,
        al:Math.min(0.22,al*0.65),
      });
    }
  });

  // render ripples with softer ellipse
  for(let i=poolRipples.length-1;i>=0;i--){
    const rp=poolRipples[i];
    rp.r+=(rp.maxR-rp.r)*0.10; rp.life-=rp.decay;
    if(rp.life<=0){poolRipples.splice(i,1);continue;}
    const al=rp.al*rp.life*rp.life*(1-rp.r/rp.maxR);
    if(al<0.002){poolRipples.splice(i,1);continue;}
    rainCtx2.beginPath();
    rainCtx2.ellipse(rp.x,rp.y,rp.r,rp.r*0.28,0,0,Math.PI*2);
    rainCtx2.strokeStyle=`rgba(220,238,255,${al.toFixed(3)})`;
    rainCtx2.lineWidth=0.6*rp.life; rainCtx2.stroke();
  }
}


let poolMouseDisposer=null;

function setupPoolMouseEvents(){
  if(poolMouseDisposer) poolMouseDisposer();
  const cv=document.getElementById("pool-canvas");
  if(!cv) return;

  let _prevMX=0.5, _prevMY=0.5;
  let _velX=0, _velY=0;

  const onMove=(e)=>{
    const rect=cv.getBoundingClientRect();
    const nx=(e.clientX-rect.left)/rect.width;
    const ny=(e.clientY-rect.top)/rect.height;
    const dx=nx-_prevMX, dy=ny-_prevMY;
    _velX=_velX*0.55+dx*0.45;
    _velY=_velY*0.55+dy*0.45;
    _prevMX=nx; _prevMY=ny;
    poolMousePrevX=poolMouseX; poolMousePrevY=poolMouseY;
    poolMouseX=nx; poolMouseY=ny;
    const rawSpeed=Math.sqrt(dx*dx+dy*dy)*55;
    poolMouseSpeed=Math.min(1.0, poolMouseSpeed*0.72+rawSpeed*0.28);
    if(rawSpeed < 0.0001) poolMouseSpeed=Math.max(poolMouseSpeed, 0.0008);
  };

  const onLeave=()=>{
    _velX=0; _velY=0;
  };

  cv.addEventListener('mousemove',onMove,{passive:true});
  cv.addEventListener('mouseleave',onLeave,{passive:true});

  poolMouseDisposer=()=>{
    cv.removeEventListener('mousemove',onMove,{passive:true});
    cv.removeEventListener('mouseleave',onLeave,{passive:true});
  };
}


function setupPoolRainCanvas(){
  rainCv=document.getElementById("pool-rain-canvas");
  if(!rainCv) return;
  const W=window.innerWidth, H=window.innerHeight, dpr=window.devicePixelRatio||1;
  rainCv.width=W*dpr; rainCv.height=H*dpr;
  rainCtx2=rainCv.getContext("2d");
  if(rainCtx2){ rainCtx2.setTransform(1,0,0,1,0,0); rainCtx2.scale(dpr,dpr); }
}


function disposeComposer(composer){
  if(!composer) return;
  if(composer.passes){
    composer.passes.forEach((pass)=>{
      try{ pass.dispose?.(); }catch(_){}
      try{ pass.fsQuad?.dispose?.(); }catch(_){}
      try{ pass.material?.dispose?.(); }catch(_){}
    });
  }
  try{ composer.renderTarget1?.dispose?.(); }catch(_){}
  try{ composer.renderTarget2?.dispose?.(); }catch(_){}
}

function disposePoolRenderer({ preserveCanvas=true }={}){
  poolActive=false;

  if(poolOrbitControls){
    try{ poolOrbitControls.dispose(); }catch(_){}
    poolOrbitControls=null;
  }
  if(poolMouseDisposer){
    try{ poolMouseDisposer(); }catch(_){}
    poolMouseDisposer=null;
  }

  if(poolComposer){
    disposeComposer(poolComposer);
    poolComposer=null;
  }

  if(piaModel){
    try{ poolScene?.remove(piaModel); }catch(_){}
    disposeObject3D(piaModel,{ disposeGeometry:true, disposeMaterials:true, disposeTextures:false });
    piaModel=null;
    piaLoaded=false;
  }

  if(waterMesh){
    try{ poolScene?.remove(waterMesh); }catch(_){}
    disposeObject3D(waterMesh,{ disposeGeometry:true, disposeMaterials:true, disposeTextures:false });
    waterMesh=null;
  }

  if(poolUnderGlow){
    try{ poolScene?.remove(poolUnderGlow); }catch(_){}
    disposeObject3D(poolUnderGlow,{ disposeGeometry:true, disposeMaterials:true, disposeTextures:false });
    poolUnderGlow=null;
  }

  if(poolScene){
    poolScene.traverse((obj)=>{
      if(obj.isMesh){
        if(obj.geometry) try{ obj.geometry.dispose(); }catch(_){}
        if(obj.material){
          const mats=Array.isArray(obj.material)?obj.material:[obj.material];
          mats.forEach((mat)=>{
            if(!mat) return;
            getTextureSlots(mat).forEach((slot)=>{
              try{ mat[slot]?.dispose?.(); }catch(_){}
            });
            try{ mat.dispose(); }catch(_){}
          });
        }
      }
    });
    try{ poolScene.clear(); }catch(_){}
  }

  try{ poolFluidTex?.dispose?.(); }catch(_){}
  poolFluidTex=null;
  poolFluidCanvas=null;
  poolFluidCtx=null;
poolFluidCtx=null;

  try{ poolCausticsTex?.dispose?.(); }catch(_){}
  poolCausticsTex=null;
  poolCausticsCanvas=null;
  poolCausticsCtx=null;

  try{ poolWaterNormals?.dispose?.(); }catch(_){}
  poolWaterNormals=null;

  if(poolRenderer){
    try{ poolRenderer.renderLists.dispose(); }catch(_){}
    try{ poolRenderer.dispose(); }catch(_){}
    try{ poolRenderer.forceContextLoss(); }catch(_){}
  }

  poolRenderer=null;
  poolScene=null;
  poolCamera=null;
  poolClock=null;
  poolDropPass=null;
  poolFloor=null;
  poolGlassWalls=[];
  poolWallPanels=[];
  poolWallCaustics=[];
  poolWaterVolume=null;
  poolInited=false;

  if(!preserveCanvas){
    const cv=document.getElementById("pool-canvas");
    if(cv) replaceCanvasWithFreshClone(cv);
  }
}

function initPoolRenderer(){
  if(poolInited) return;
  const cv=document.getElementById("pool-canvas");
  if(!cv) return;
  const W=window.innerWidth, H=window.innerHeight;
  const shadowEnabled=!IS_MOBILE;
  const maxDpr=Math.min(window.devicePixelRatio||1, IS_MOBILE ? 1.1 : 1.5);

  poolRenderer=new THREE.WebGLRenderer({
    canvas:cv,
    antialias:!IS_MOBILE,
    alpha:false,
    powerPreference:"high-performance",
    preserveDrawingBuffer:false,
    stencil:false
  });
  poolRenderer.setPixelRatio(maxDpr);
  poolRenderer.setSize(W,H,false);
  poolRenderer.shadowMap.enabled=shadowEnabled;
  if(shadowEnabled){
    poolRenderer.shadowMap.type=THREE.PCFSoftShadowMap;
    poolRenderer.shadowMap.autoUpdate=false;
  }
  poolRenderer.outputColorSpace=THREE.SRGBColorSpace;
  poolRenderer.toneMapping=THREE.ACESFilmicToneMapping;
  poolRenderer.toneMappingExposure=1.25;

  if(!cv._poolContextBound){
    cv.addEventListener("webglcontextlost",(e)=>{
      e.preventDefault();
      poolActive=false;
    },false);

    cv.addEventListener("webglcontextrestored",()=>{
      disposePoolRenderer({ preserveCanvas:true });
      initPoolRenderer();
      if(LS.hIdx===3) startPoolRenderer();
    },false);

    cv._poolContextBound=true;
  }

  poolScene=new THREE.Scene();
  poolScene.background=new THREE.Color(0x020508);
  poolScene.fog=new THREE.FogExp2(0x030a14,0.010);

  poolCamera=new THREE.PerspectiveCamera(60,W/H,0.1,800);
  poolCamera.position.set(10.965*POOL_SCENE_SCALE, 5.2*POOL_SCENE_SCALE, 5.939*POOL_SCENE_SCALE);
  poolCamera.lookAt(1.5, -3.8, -5.5);

  const hemi=new THREE.HemisphereLight(0xd0ecff,0x4488aa,1.7);
  poolScene.add(hemi);
  poolScene._hemi=hemi;

  const sun=new THREE.DirectionalLight(0xfff6e0,2.6);
  sun.position.set(16,32,12);
  sun.castShadow=shadowEnabled;
  if(shadowEnabled){
    const shadowMapSize=IS_MOBILE ? 1024 : 1536;
    sun.shadow.mapSize.set(shadowMapSize,shadowMapSize);
    sun.shadow.camera.near=0.5; sun.shadow.camera.far=140;
    const sh=32*POOL_SCENE_SCALE;
    sun.shadow.camera.top=sh; sun.shadow.camera.bottom=-sh;
    sun.shadow.camera.left=-sh; sun.shadow.camera.right=sh;
    sun.shadow.bias=-0.0006;
  }
  poolScene.add(sun);
  poolScene._sun=sun;

  const fill=new THREE.DirectionalLight(0xa0d0ff,0.85);
  fill.position.set(-8,6,-5);
  poolScene.add(fill);

  const backLight=new THREE.DirectionalLight(0xffe0c0,0.42);
  backLight.position.set(0,4,-12);
  poolScene.add(backLight);

  const waterLight=new THREE.PointLight(0x44ccff,3.0,26);
  waterLight.position.set(0,-0.5,0);
  poolScene.add(waterLight);
  poolScene._waterLight=waterLight;

  const beatLight=new THREE.PointLight(0x88eeff,0,34);
  beatLight.position.set(0,3,0);
  poolScene.add(beatLight);
  poolScene._beatLight=beatLight;

  const causticsLight=new THREE.PointLight(0x7fe8ff,0.85,18);
  causticsLight.position.set(0,0.8,0);
  poolScene.add(causticsLight);
  poolScene._causticsLight=causticsLight;

  buildPoolSky();
  buildProceduralCaustics();
  buildPoolShell();
  buildWaterSurface();
  loadPiaModel();
  initPoolComposer();
  setupPoolRainCanvas();
  setupPoolMouseEvents();

  poolClock=new THREE.Clock();
  poolOrbitControls=createPoolOrbitControls(poolCamera,cv);

  poolInited=true;
}

function startPoolRenderer(){
  if(!poolInited) initPoolRenderer();
  poolActive=true;
  if(poolClock) poolClock.getDelta();
  if(poolRenderer && poolScene && poolCamera) {
    if(poolRenderer.shadowMap.enabled) poolRenderer.shadowMap.needsUpdate=true;
    if(poolComposer) poolComposer.render();
    else poolRenderer.render(poolScene, poolCamera);
  }
}


// ══════════════════════════════════════════════════════
// ALBUM 패널 — Glossy Magnetic Card Deck
// ══════════════════════════════════════════════════════
const ALBUM_DATA = [
  { title: "돈 벌 준비",         desc: "데뷔 전 믹테",   tags: ["2013", "믹스테이프"] },
  { title: "돈 벌 시간",         desc: "덕소 욕망기",   tags: ["2013", "믹스테이프"] },
  { title: "별 될 준비",         desc: "별 될 예고",   tags: ["2014", "믹스테이프"] },
  { title: "Incomplete",        desc: "미완의 청춘", tags: ["2015", "믹스테이프"] },
  { title: "M O T O W N",       desc: "덕소 헌정작",   tags: ["2016", "앨범"] },
  { title: "돈 벌 시간 2",       desc: "성장 가속기",   tags: ["2016", "EP"] },
  { title: "돈 벌 시간 3",       desc: "확장 전성기",   tags: ["2016", "EP"] },
  { title: "돈 번 순간",         desc: "성공 자각",     tags: ["2017", "믹스테이프"] },
  { title: "I Always",          desc: "청춘 OST",      tags: ["2017", "OST 싱글"] },
  { title: "닿는 순간",         desc: "감성 전환기",   tags: ["2018", "EP"] },
  { title: "BOY",               desc: "영원한 젊음",     tags: ["2018", "싱글"] },
  { title: "돈 Touch My Phone",           desc: "들으싈? 빠끄",   tags: ["2019", "공동 싱글"] },
  { title: "Boyhood",           desc: "첫 정규 서사",     tags: ["2019", "정규 1집"] },
  { title: "PAY DAY",           desc: "월.급.날.",     tags: ["2020", "공동 싱글"] },
  { title: "BIPOLAR",         desc: "양가 감정",     tags: ["2020", "EP"] },
  { title: "광장동에서",         desc: "20대 회고",       tags: ["2020", "싱글"] },
  { title: "UNDERGROUND ROCKSTAR", desc: "락스타 자전", tags: ["2021", "정규 2집"] },
  { title: "Wonderful Days",    desc: "오랜 기다림",     tags: ["2024", "EP"] },
  { title: "Op.1",              desc: "모리엔트 서막", tags: ["2025", "싱글"] },
  { title: "Op.2",              desc: "다음 장의 문",   tags: ["2025", "싱글"] },
];

let albumInited=false;
let albumCards=[];      // DOM 카드 배열
let deckTopIdx=0;       // 현재 덱 맨 위 카드 인덱스
let selectedIdx=-1;     // 클릭으로 선택된 카드 인덱스
let deckAnimating=false;

// 덱에서 보여줄 최대 카드 장수 (겹쳐 보이는 층)
const DECK_VISIBLE = 5;

// 각 레이어의 변환 값 (맨 위=0, 아래로 갈수록 index++)
function getDeckTransform(layerIdx, total, isSelected) {
  if (isSelected) {
    return {
      translateX: -30,  // 왼쪽으로 살짝 튀어나옴
      translateY: -14,
      translateZ: 60,
      rotateY: 6,
      rotateZ: 0,
      scale: 1.06,
      opacity: 1,
    };
  }
  const spread = 6;       // 카드간 X 오프셋(px)
  const stackY = 5;       // 카드간 Y 오프셋(px)
  const rotZ = [-1.2, 0.6, -0.4, 0.9, -0.3]; // 각 층 기울기
  const zStep = -8;
  return {
    translateX: layerIdx * spread,
    translateY: layerIdx * stackY,
    translateZ: layerIdx * zStep,
    rotateY: 0,
    rotateZ: (rotZ[layerIdx] || 0),
    scale: 1 - layerIdx * 0.015,
    opacity: 1 - layerIdx * 0.10,
  };
}

function applyDeckTransform(cardEl, layerIdx, total, isSelected, animate=true) {
  const t = getDeckTransform(layerIdx, total, isSelected);
  const tf = [
    `translateX(${t.translateX}px)`,
    `translateY(${t.translateY}px)`,
    `translateZ(${t.translateZ}px)`,
    `rotateY(${t.rotateY}deg)`,
    `rotateZ(${t.rotateZ}deg)`,
    `scale(${t.scale})`,
  ].join(' ');
  cardEl.style.transform = tf;
  cardEl.style.opacity = t.opacity;
  cardEl.style.zIndex = total - layerIdx + (isSelected ? 20 : 0);
  if (!animate) {
    cardEl.style.transition = 'none';
  } else {
    cardEl.style.transition =
      'transform 0.48s cubic-bezier(0.22,1,0.36,1), box-shadow 0.35s ease, filter 0.35s ease, opacity 0.35s ease';
  }
}

function showDeckDetail(idx) {
  const det = document.getElementById("album-detail");
  if (!det) return;
  const data = ALBUM_DATA[idx];
  det.querySelector(".ad-index").textContent = `${String(idx+1).padStart(2,"0")} — ${ALBUM_DATA.length}`;
  det.querySelector(".ad-title").textContent = data.title;
  det.querySelector(".ad-desc").textContent = data.desc;
  det.querySelector(".ad-tags").innerHTML = data.tags.map(t=>`<span class="ad-tag">${t}</span>`).join("");
  det.classList.add("visible");
}

function hideDeckDetail() {
  const det = document.getElementById("album-detail");
  if (det) det.classList.remove("visible");
}

function updateDeckCounterDots() {
  const counter = document.getElementById("album-deck-counter");
  if (!counter) return;
  counter.innerHTML = "";
  const total = ALBUM_DATA.length;
  const maxDots = 7;
  const step = Math.max(1, Math.floor(total / maxDots));
  for (let i = 0; i < total; i += step) {
    const dot = document.createElement("span");
    dot.className = "adc-dot" + (i === deckTopIdx ? " active" : "");
    counter.appendChild(dot);
  }
}

function layoutDeck(skipAnim=false) {
  const total = ALBUM_DATA.length;
  albumCards.forEach((card, dataIdx) => {
    // layerIdx: 덱 순서상 몇 번째 층인가 (deckTopIdx 기준)
    const layerIdx = (dataIdx - deckTopIdx + total) % total;
    const visible = layerIdx < DECK_VISIBLE;
    card.style.display = visible ? "block" : "none";
    const isSel = (dataIdx === selectedIdx);
    if (visible) applyDeckTransform(card, layerIdx, DECK_VISIBLE, isSel, !skipAnim);
    card.classList.toggle("is-selected", isSel);
  });
  updateDeckCounterDots();
}

function selectDeckCard(idx) {
  if (deckAnimating) return;

  if (selectedIdx === idx) {
    // 이미 선택된 카드 재클릭 → 선택 해제 + 덱 다음 카드로 전진
    selectedIdx = -1;
    deckAnimating = true;
    const total = ALBUM_DATA.length;
    deckTopIdx = (deckTopIdx + 1) % total;
    layoutDeck();
    showDeckDetail(deckTopIdx); // 다음 카드 정보 바로 표시
    setTimeout(() => { deckAnimating = false; }, 700);
  } else {
    deckTopIdx = idx;
    selectedIdx = idx;
    layoutDeck();
    showDeckDetail(idx);
  }
}

function deckHoverEnter(card, idx) {
  if (selectedIdx !== -1) return; // 선택 중엔 hover 무시
  const total = ALBUM_DATA.length;
  const layerIdx = (idx - deckTopIdx + total) % total;
  if (layerIdx >= DECK_VISIBLE) return;
  // 살짝 들리는 효과
  const t = getDeckTransform(layerIdx, DECK_VISIBLE, false);
  card.style.transform = [
    `translateX(${t.translateX - 4}px)`,
    `translateY(${t.translateY - 6}px)`,
    `translateZ(${t.translateZ + 12}px)`,
    `rotateZ(${t.rotateZ * 0.6}deg)`,
    `scale(${t.scale + 0.015})`,
  ].join(' ');
}

function deckHoverLeave(card, idx) {
  if (selectedIdx !== -1) return;
  const total = ALBUM_DATA.length;
  const layerIdx = (idx - deckTopIdx + total) % total;
  if (layerIdx >= DECK_VISIBLE) return;
  applyDeckTransform(card, layerIdx, DECK_VISIBLE, false, true);
}

// 마우스 이동으로 맨 위 카드 3D tilt
function deckMouseMove(e) {
  if (deckAnimating) return;
  const stage = document.getElementById("album-deck-stage");
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = (e.clientX - cx) / (rect.width / 2);   // -1 ~ 1
  const dy = (e.clientY - cy) / (rect.height / 2);  // -1 ~ 1

  const topCard = albumCards[deckTopIdx];
  if (!topCard || selectedIdx === deckTopIdx) return;
  const layerIdx = 0;
  const t = getDeckTransform(layerIdx, DECK_VISIBLE, false);
  topCard.style.transform = [
    `translateX(${t.translateX + dx * 6}px)`,
    `translateY(${t.translateY + dy * 4}px)`,
    `translateZ(${t.translateZ + 8}px)`,
    `rotateY(${dx * 8}deg)`,
    `rotateX(${-dy * 6}deg)`,
    `rotateZ(${t.rotateZ}deg)`,
    `scale(${t.scale})`,
  ].join(' ');
  topCard.style.transition = 'transform 0.12s ease-out';
}

function deckMouseLeave() {
  const topCard = albumCards[deckTopIdx];
  if (!topCard || selectedIdx === deckTopIdx) return;
  applyDeckTransform(topCard, 0, DECK_VISIBLE, false, true);
}

function buildAlbumCards(){
  const stage = document.getElementById("album-deck-stage");
  if (!stage) return;
  stage.innerHTML = "";
  albumCards = [];

  ALBUM_DATA.forEach((data, i) => {
    const card = document.createElement("div");
    card.className = "album-card-deck";
    card.dataset.idx = i;

    // thumb
    const thumb = document.createElement("div");
    thumb.className = "acd-thumb";
    const img = document.createElement("img");
    img.src = `assets/c${i+1}.png`;
    img.alt = data.title;
    img.loading = "lazy";
    img.onerror = () => {
      thumb.style.background = `linear-gradient(135deg,
        hsl(${260 + i*14},40%,14%) 0%,
        hsl(${240 + i*10},30%,8%) 100%)`;
    };
    thumb.appendChild(img);

    // overlay
    const overlay = document.createElement("div");
    overlay.className = "acd-overlay";

    // info
    const info = document.createElement("div");
    info.className = "acd-info";
    info.innerHTML = `
      <span class="acd-idx">${String(i+1).padStart(2,"0")}</span>
      <span class="acd-title">${data.title}</span>
      <span class="acd-tags">${data.tags.map(t=>`<span class="acd-tag">${t}</span>`).join("")}</span>
    `;

    card.appendChild(thumb);
    card.appendChild(overlay);
    card.appendChild(info);

    // events — hover로 detail 표시, click은 선택/해제
    card.addEventListener("mouseenter", () => {
      deckHoverEnter(card, i);
      // hover된 카드가 보이는 층이면 detail 바로 표시
      const total2 = ALBUM_DATA.length;
      const li = (i - deckTopIdx + total2) % total2;
      if (li < DECK_VISIBLE) showDeckDetail(i);
    });
    card.addEventListener("mouseleave", () => {
      deckHoverLeave(card, i);
      // 선택된 카드가 없으면 detail 숨김
      if (selectedIdx === -1) hideDeckDetail();
      else showDeckDetail(selectedIdx);
    });

    card.addEventListener("click", () => {
      const total2 = ALBUM_DATA.length;
      const layerIdx = (i - deckTopIdx + total2) % total2;
      if (layerIdx >= DECK_VISIBLE) return;
      if (layerIdx > 0) {
        // 뒤 카드 클릭 → 그 카드를 top으로 전진
        deckTopIdx = i;
        selectedIdx = -1;
        layoutDeck();
        showDeckDetail(i);
        return;
      }
      // 맨 위 카드 클릭 → 선택 토글
      selectDeckCard(i);
    });

    stage.appendChild(card);
    albumCards.push(card);
  });

  // stage-level mouse events for tilt
  stage.addEventListener("mousemove", deckMouseMove);
  stage.addEventListener("mouseleave", deckMouseLeave);

  // 초기 레이아웃 — 애니메이션 없이
  layoutDeck(true);
}

function updateAlbumPanel(){
  if(!albumInited||LS.hIdx!==2) return;
  // 음악 반응 제거 — filter/textShadow 매 프레임 갱신이 렉의 주범
  // 선택된 카드 brightness만 정적으로 유지
}

function initAlbumPanel(){
  if(albumInited) return;
  buildAlbumCards();
  albumInited=true;

  const panelScene=document.getElementById("panel-scene");
  if(!panelScene) return;
  const overlay=document.getElementById("album-panel-overlay");
  if(overlay){
    overlay.style.display="block";
    panelScene.appendChild(overlay);
  }

  // back → 이전 패널(piano), next → 다음 패널(pool)
  const btnBack = document.getElementById("album-back-btn");
  if(btnBack) btnBack.addEventListener("click", ()=>triggerNav(()=>goTo(1,0)));

  const btnNext = document.getElementById("album-next-btn");
  if(btnNext) btnNext.addEventListener("click", ()=>triggerNav(()=>goTo(LS.hIdx+1,0)));
}


let rafId=0;

function teardownApp(){
  if(rafId){
    cancelAnimationFrame(rafId);
    rafId=0;
  }

  Object.keys(glbRenderers).forEach((key)=>{
    disposeLiveGLB(Number(key));
  });

  disposePoolRenderer({ preserveCanvas:true });

  if(micStream){
    try{ micStream.getTracks().forEach((t)=>t.stop()); }catch(_){}
    micStream=null;
  }

  if(audioCtx && audioCtx.state!=="closed"){
    try{ audioCtx.close(); }catch(_){}
  }
}

function loop(){
  analyze(); smooth(); updateCSS(); updateHUD(); updatePalette();
  drawOverlay(); renderGL(); renderActiveGLB(); updateAlbumPanel();
  if(poolInited&&poolClock){
    const delta=Math.min(poolClock.getDelta(),0.05);
    if(poolActive) renderPoolScene(delta);
  }
  if(sceneActive) drawScene();
  rafId=requestAnimationFrame(loop);
}

// ── 진입점
(function init(){
  if(!initGL()) return;
  initAssetLoaders();
  initOverlay();
  bindAudioEvents();
  bindTrackButtons();
  bindLayoutEvents();
  mc.style.transform="translate(0px,0px)";
  audioEl.src="assets/track.mp3";
  audioEl.addEventListener("error",()=>audioEl.removeAttribute("src"),{once:true});

  const hint=document.getElementById("scroll-hint");
  if(hint) setTimeout(()=>{hint.style.opacity="0";},5000);

  // CPU-side GLB 프리로드만 먼저 수행하고,
  // 실제 WebGL 컨텍스트는 현재 보이는 섹션에만 생성
  primeGLBPreloadQueue();

  // Pool은 진입 시 즉시 뜨도록 한 번만 사전 초기화
  setTimeout(()=>{ initPoolRenderer(); }, 200);
