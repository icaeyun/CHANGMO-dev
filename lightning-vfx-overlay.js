/**
 * LIGHTNING VFX START
 * lightning-vfx-overlay.js
 *
 * Click/touch-triggered lightning overlay for static sites.
 * Based on Lightning-VFX (MIT License) by @ektogamat
 * Adapted: shaders inlined, orthographic screen-space camera,
 * no Vite/npm required, no auto-storm, UI-target filtering.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ─── Inlined GLSL shaders (source: Lightning-VFX, MIT License) ─────────────

const BOLT_VERT = /* glsl */`
attribute float aRatio;
attribute vec3  aDirection;
attribute float aSide;
attribute float aStrikeOffset;
attribute float aThickness;
attribute float aAlpha;
attribute vec3  aColor;

uniform float uTime;
uniform float uStrikeDur;
uniform float uFadeDur;
uniform float uSpread;

varying float vRatio;
varying float vStrikeOffset;
varying float vAlpha;
varying vec3  vColor;

void main() {
  float fadeT = clamp((uTime - uStrikeDur) / uFadeDur, 0.0, 1.0);
  vec3 pos = position;
  pos.xz += pos.xz * pow(fadeT, 2.0) * uSpread;

  vec4 worldPos  = modelMatrix * vec4(pos, 1.0);
  vec3 toCamera  = normalize(cameraPosition - worldPos.xyz);
  vec4 nextWorld = modelMatrix * vec4(position + aDirection, 1.0);
  vec3 tangent   = normalize(cross(normalize(nextWorld.xyz - worldPos.xyz), toCamera));
  worldPos.xyz  += tangent * aSide * aThickness;

  vRatio        = aRatio;
  vStrikeOffset = aStrikeOffset;
  vAlpha        = aAlpha;
  vColor        = aColor;
  gl_Position   = projectionMatrix * viewMatrix * worldPos;
}
`;

const BOLT_FRAG = /* glsl */`
uniform float uTime;
uniform float uStrikeDur;
uniform float uFadeDur;

varying float vRatio;
varying float vStrikeOffset;
varying float vAlpha;
varying vec3  vColor;

void main() {
  float strikeT = clamp(uTime / uStrikeDur, 0.0, 1.0);
  float fadeT   = clamp((uTime - uStrikeDur) / uFadeDur, 0.0, 1.0);
  float window  = max(1.0 - vStrikeOffset, 0.001);
  float localT  = clamp((strikeT - vStrikeOffset) / window, 0.0, 1.0);
  float reveal  = step(vRatio, localT);
  float alpha   = reveal * (1.0 - fadeT * fadeT) * vAlpha;
  gl_FragColor  = vec4(vColor, alpha);
}
`;

// Spark vert — floor clamp removed (no ground plane in 2D overlay)
const SPARK_VERT = /* glsl */`
attribute vec3  aVelocity;
attribute float aLifetime;
attribute float aSeed;

uniform float uTime;
uniform float uDelay;
uniform float uSize;
uniform float uGravity;
uniform float uDepthScale;

varying float vAge;
varying float vSeed;

void main() {
  float t  = max(0.0, uTime - uDelay);
  vAge     = clamp(t / aLifetime, 0.0, 1.5);
  vSeed    = aSeed;
  vec3 p   = position + aVelocity * t + vec3(0.0, -uGravity * t * t, 0.0);
  vec4 mv  = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * max(0.0, 1.0 - vAge * 0.8) * (uDepthScale / -mv.z);
  gl_Position  = projectionMatrix * mv;
}
`;

const SPARK_FRAG = /* glsl */`
varying float vAge;
varying float vSeed;

void main() {
  vec2  uv   = gl_PointCoord - 0.5;
  float r    = length(uv);
  if (r > 0.5) discard;
  float core = max(0.0, 1.0 - r * 5.0);
  float glow = max(0.0, 1.0 - r * 2.2);
  vec3  hot  = vec3(1.00, 0.92, 0.55);
  vec3  mid  = vec3(1.00, 0.42, 0.05);
  vec3  cool = vec3(0.70, 0.10, 0.00);
  vec3  col  = mix(cool, mix(mid, hot, core), glow);
  float fade = max(0.0, 1.0 - vAge * vAge);
  gl_FragColor = vec4(col, (core * 1.0 + glow * 0.45) * fade);
}
`;

const SHOCKWAVE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHOCKWAVE_FRAG = /* glsl */`
uniform float uTime;
uniform float uDelay;
uniform float uDur;
uniform float uAlphaMult;
uniform vec3  uColorA;
uniform vec3  uColorB;
varying vec2  vUv;

void main() {
  float t   = clamp((uTime - uDelay) / uDur, 0.0, 1.0);
  vec2  uvc = vUv - 0.5;
  float r   = length(uvc) * 2.0;
  float ring= abs(r - t);
  float alpha = smoothstep(0.12, 0.0, ring) * (1.0 - t) * (1.0 - t) * uAlphaMult;
  vec3  col = mix(uColorA, uColorB, t);
  gl_FragColor = vec4(col, alpha);
}
`;

const GFLASH_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GFLASH_FRAG = /* glsl */`
uniform float uTime;
uniform float uDur;
uniform vec3  uColor;
uniform float uIntensity;
uniform float uRadialPow;
uniform float uFadePow;
varying vec2  vUv;

void main() {
  float t      = clamp(uTime / uDur, 0.0, 1.0);
  float radial = max(0.0, 1.0 - length(vUv - vec2(0.5)) * 2.0);
  float alpha  = pow(radial, uRadialPow) * pow(1.0 - t, uFadePow) * uIntensity;
  gl_FragColor = vec4(uColor, alpha);
}
`;

// ─── UI-target filter ────────────────────────────────────────────────────────

const BLOCKED_TAGS = new Set([
  'BUTTON','A','INPUT','LABEL','SELECT','TEXTAREA','AUDIO','VIDEO',
]);
const BLOCKED_CLASSES = [
  'control-btn','track-btn','file-btn','mic-toggle',
  'back-hint','next-hint','down-hint','swipe-hint','scroll-hint',
  'album-back-hint','album-next-hint','album-drag-hint',
  'topbar','controls',
];

function isBlockedTarget(el) {
  if (!el || el === document.documentElement) return false;
  let cur = el;
  for (let d = 0; d < 12 && cur && cur !== document.documentElement; d++, cur = cur.parentElement) {
    if (!cur) break;
    if (BLOCKED_TAGS.has(cur.tagName)) return true;
    const role = cur.getAttribute?.('role');
    if (role === 'button' || role === 'link') return true;
    if (cur.hasAttribute?.('data-no-lightning')) return true;
    const cl = cur.classList;
    if (cl) {
      for (const c of BLOCKED_CLASSES) {
        if (cl.contains(c)) return true;
      }
    }
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ─── Main overlay ─────────────────────────────────────────────────────────────

class LightningVFXOverlay {
  constructor() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    this._el    = document.getElementById('lightning-vfx-canvas');
    this._flash = document.getElementById('lightning-flash-overlay');
    if (!this._el) return;

    this._mob  = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this._dpr  = Math.min(window.devicePixelRatio || 1, 2);
    this._W    = window.innerWidth;
    this._H    = window.innerHeight;
    this._bolts = [];
    this._flashT = -99;
    this._lastT  = performance.now();

    this._P = this._params();
    this._initThree();

    window.addEventListener('pointerdown', e => this._onDown(e), { passive: true });
    window.addEventListener('resize',      () => this._onResize(), { passive: true, capture: false });
    this._loop();
  }

  // ── Parameters (all sizes in CSS-pixel world units) ──────────────────────

  _params() {
    const m = this._mob;
    const S = Math.min(this._W, this._H);
    return {
      // Bolt path (startY is always screen top + 80px, not relative to click)
      topXJitter: 55,
      roughMin: 0.40, roughMax: 0.60,
      mainDepth: m ? 5 : 7,
      altDepth:  m ? 3 : 5,
      altRoughMult: 0.85,
      // Branches
      branchMin: 1, branchMax: m ? 2 : 4,
      branchFFMin: 0.12, branchFFMax: 0.67,
      branchLenMin: 0.22, branchLenMax: 0.54,
      branchDropMin: 0.55, branchDropMax: 0.90,
      branchYJitter: 55, branchYClamp: 20,
      branchXScale: 0.65,
      // Bolt layers (thickness in px, one side → ribbon total = thick px)
      strikeDur: 0.15, fadeDur: 1.0, tailExtra: 0.15, boltSpread: 0.008,
      mainThickMult: 1.5, mainAlphaMult: 1.0,
      altThickMult:  0.55, altAlphaMult: 0.75,
      layers: [
        { color: '#4764e1', thick: m ? 16 : 30, alpha: 0.20 },
        { color: '#1072bd', thick: m ?  6 : 11, alpha: 0.60 },
        { color: '#d8f4ff', thick: m ?  2 :  3, alpha: 1.0  },
      ],
      // Sparks
      sparkMin: m ? 12 : 28, sparkMax: m ? 22 : 42,
      sparkSize: m ? 3.5 : 6,          // CSS px before DPR scaling
      sparkGravity: 520,
      sparkDepthScale: 100,             // matches camera z=100
      sparkJitter: 14, sparkYOff: 8,
      sparkSpdMin: 60,  sparkSpdMax: m ? 210 : 380,
      sparkUpMin:  90,  sparkUpMax:  m ? 320 : 540,
      sparkLifeMin: 0.4, sparkLifeMax: 1.3,
      // Shockwave
      shockDur: 0.55, shockAlpha: m ? 0.20 : 0.35,
      shockSize: S * (m ? 0.38 : 0.48),
      shockColorA: '#ffb060', shockColorB: '#66b3ff',
      // Impact glow
      flashDur: 0.42, flashIntensity: m ? 0.22 : 0.32,
      flashRadPow: 1.2, flashFadePow: 1.5,
      flashSize: S * (m ? 0.20 : 0.26),
      flashColor: '#4db2ff',
      // Screen flash overlay
      overlayAlpha: 0.52, overlayDecay: 8, overlayTint: '#6496ff',
    };
  }

  // ── Three.js init ────────────────────────────────────────────────────────

  _initThree() {
    this._scene = new THREE.Scene();

    // Orthographic camera: 1 world unit = 1 CSS pixel, z=100 facing -Z
    this._cam = new THREE.OrthographicCamera(
      -this._W / 2, this._W / 2,
       this._H / 2, -this._H / 2,
      0.1, 2000
    );
    this._cam.position.set(0, 0, 100);
    this._cam.lookAt(0, 0, 0);

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._el, alpha: true, antialias: !this._mob,
    });
    this._renderer.setClearColor(0x000000, 0);
    this._renderer.setPixelRatio(this._dpr);
    this._renderer.setSize(this._W, this._H, false); // don't override CSS
  }

  // ── Coordinate conversion ────────────────────────────────────────────────

  _s2w(cx, cy) {
    return { x: cx - this._W / 2, y: this._H / 2 - cy };
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  _isNightHour() {
    const h = new Date().getHours();
    return h >= 0 && h < 3;
  }

  _onDown(e) {
    if (!this._isNightHour()) return;
    if (isBlockedTarget(e.target)) return;
    if (document.body.dataset.hIdx === '1') return;
    const { x, y } = this._s2w(e.clientX, e.clientY);
    this._spawnAt(x, y, performance.now() / 1000);
  }

  _onResize() {
    this._W = window.innerWidth;
    this._H = window.innerHeight;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._renderer.setPixelRatio(this._dpr);
    this._renderer.setSize(this._W, this._H, false);
    this._cam.left   = -this._W / 2;
    this._cam.right  =  this._W / 2;
    this._cam.top    =  this._H / 2;
    this._cam.bottom = -this._H / 2;
    this._cam.updateProjectionMatrix();
  }

  // ── Geometry builders ─────────────────────────────────────────────────────

  _fractalPath(a, b, depth, rough) {
    if (depth <= 0) return [a.clone(), b.clone()];
    const mid  = a.clone().lerp(b, 0.45 + Math.random() * 0.1);
    const dist = a.distanceTo(b);
    mid.x += (Math.random() - 0.5) * dist * rough * 1.35; // X-only jitter (screen horizontal)
    const L = this._fractalPath(a, mid, depth - 1, rough * 0.88);
    const R = this._fractalPath(mid, b, depth - 1, rough * 0.88);
    return [...L.slice(0, -1), ...R];
  }

  _boltGeo(points, strikeOff, thick, alpha, color) {
    const segs = points.length - 1;
    if (segs < 1) return null;
    const vc   = segs * 4;
    const pos  = new Float32Array(vc * 3);
    const rat  = new Float32Array(vc);
    const dir  = new Float32Array(vc * 3);
    const sid  = new Float32Array(vc);
    const sOff = new Float32Array(vc).fill(strikeOff);
    const thk  = new Float32Array(vc).fill(thick);
    const alp  = new Float32Array(vc).fill(alpha);
    const col  = new Float32Array(vc * 3);
    const idx  = [];

    for (let i = 0; i < segs; i++) {
      const pa = points[i], pb = points[i + 1];
      const rA = i / (points.length - 1);
      const rB = (i + 1) / (points.length - 1);
      const dv = new THREE.Vector3().subVectors(pb, pa).normalize();
      const vi = i * 4;

      [[pa, rA, -0.5], [pa, rA, 0.5], [pb, rB, -0.5], [pb, rB, 0.5]].forEach(([p, r, s], j) => {
        const k = (vi + j) * 3;
        pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
        rat[vi + j] = r;
        dir[k] = dv.x; dir[k + 1] = dv.y; dir[k + 2] = dv.z;
        sid[vi + j] = s;
        col[k] = color.r; col[k + 1] = color.g; col[k + 2] = color.b;
      });
      idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position',     new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRatio',       new THREE.BufferAttribute(rat, 1));
    g.setAttribute('aDirection',   new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aSide',        new THREE.BufferAttribute(sid, 1));
    g.setAttribute('aStrikeOffset',new THREE.BufferAttribute(sOff, 1));
    g.setAttribute('aThickness',   new THREE.BufferAttribute(thk, 1));
    g.setAttribute('aAlpha',       new THREE.BufferAttribute(alp, 1));
    g.setAttribute('aColor',       new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
  }

  _makeBolt(strands) {
    const P = this._P;
    const geos = [];
    for (const { pts, sOff, tM, aM } of strands) {
      for (const L of P.layers) {
        const g = this._boltGeo(pts, sOff, L.thick * tM, L.alpha * aM, new THREE.Color(L.color));
        if (g) geos.push(g);
      }
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos);
    geos.forEach(g => g.dispose());
    const mat = new THREE.ShaderMaterial({
      vertexShader: BOLT_VERT, fragmentShader: BOLT_FRAG,
      uniforms: {
        uTime:     { value: 0 },
        uStrikeDur:{ value: P.strikeDur },
        uFadeDur:  { value: P.fadeDur   },
        uSpread:   { value: P.boltSpread},
      },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.renderOrder = 2;
    this._scene.add(mesh);
    return { mesh, mat, geo: merged };
  }

  _makeGFlash(x, y) {
    const P = this._P;
    const mat = new THREE.ShaderMaterial({
      vertexShader: GFLASH_VERT, fragmentShader: GFLASH_FRAG,
      uniforms: {
        uTime:      { value: -0.1 },
        uDur:       { value: P.flashDur       },
        uColor:     { value: new THREE.Color(P.flashColor) },
        uIntensity: { value: P.flashIntensity  },
        uRadialPow: { value: P.flashRadPow     },
        uFadePow:   { value: P.flashFadePow    },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(P.flashSize, P.flashSize), mat);
    mesh.position.set(x, y, 1);
    mesh.renderOrder = 2;
    this._scene.add(mesh);
    return { mesh, mat };
  }

  _makeSparks(x, y) {
    const P = this._P;
    const n = P.sparkMin + Math.floor(Math.random() * (P.sparkMax - P.sparkMin + 1));
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const lif = new Float32Array(n);
    const sed = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      pos[i * 3]     = x + (Math.random() - 0.5) * P.sparkJitter;
      pos[i * 3 + 1] = y + P.sparkYOff;
      pos[i * 3 + 2] = 0;
      const a   = Math.random() * Math.PI * 2;
      const spd = P.sparkSpdMin + Math.random() * (P.sparkSpdMax - P.sparkSpdMin);
      const up  = P.sparkUpMin  + Math.random() * (P.sparkUpMax  - P.sparkUpMin);
      vel[i * 3]     = Math.cos(a) * spd;
      vel[i * 3 + 1] = up;
      vel[i * 3 + 2] = 0;
      lif[i] = P.sparkLifeMin + Math.random() * (P.sparkLifeMax - P.sparkLifeMin);
      sed[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',  new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aVelocity', new THREE.BufferAttribute(vel, 3));
    geo.setAttribute('aLifetime', new THREE.BufferAttribute(lif, 1));
    geo.setAttribute('aSeed',     new THREE.BufferAttribute(sed, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
      uniforms: {
        uTime:       { value: 0 },
        uDelay:      { value: P.strikeDur },
        uSize:       { value: P.sparkSize * this._dpr },  // DPR-corrected device px
        uGravity:    { value: P.sparkGravity },
        uDepthScale: { value: P.sparkDepthScale },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const mesh = new THREE.Points(geo, mat);
    mesh.renderOrder = 3;
    this._scene.add(mesh);
    return { mesh, mat, geo };
  }

  _makeShockwave(x, y) {
    const P = this._P;
    const mat = new THREE.ShaderMaterial({
      vertexShader: SHOCKWAVE_VERT, fragmentShader: SHOCKWAVE_FRAG,
      uniforms: {
        uTime:     { value: 0 },
        uDelay:    { value: P.strikeDur  },
        uDur:      { value: P.shockDur   },
        uAlphaMult:{ value: P.shockAlpha },
        uColorA:   { value: new THREE.Color(P.shockColorA) },
        uColorB:   { value: new THREE.Color(P.shockColorB) },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(P.shockSize, P.shockSize), mat);
    mesh.position.set(x, y, 1);
    mesh.renderOrder = 1;
    this._scene.add(mesh);
    return { mesh, mat };
  }

  // ── Spawn a full lightning strike at world position (wx, wy) ─────────────

  _spawnAt(wx, wy, nowSec) {
    const P = this._P;
    const rough = P.roughMin + Math.random() * (P.roughMax - P.roughMin);

    // Bolt always starts from just above the screen top, falls to click position
    const startY = this._H / 2 + 80;
    const top = new THREE.Vector3(wx + (Math.random() - 0.5) * P.topXJitter, startY, 0);
    const bot = new THREE.Vector3(wx, wy, 0);
    const mainPts = this._fractalPath(top, bot, P.mainDepth, rough);

    const strands = [{ pts: mainPts, sOff: 0, tM: P.mainThickMult, aM: P.mainAlphaMult }];

    const bH = top.distanceTo(bot);
    const bc = P.branchMin + Math.floor(Math.random() * (P.branchMax - P.branchMin + 1));
    for (let b = 0; b < bc; b++) {
      const ff = P.branchFFMin + Math.random() * (P.branchFFMax - P.branchFFMin);
      const fi = Math.floor(ff * (mainPts.length - 1));
      const fp = mainPts[fi].clone();
      const ba = Math.random() * Math.PI * 2;
      const bl = (1 - ff) * bH * (P.branchLenMin + Math.random() * (P.branchLenMax - P.branchLenMin));
      const be = fp.clone();
      be.x += Math.cos(ba) * bl * P.branchXScale;
      be.y -= bl * (P.branchDropMin + Math.random() * (P.branchDropMax - P.branchDropMin));
      be.y  = Math.max(be.y, wy + P.branchYClamp + Math.random() * P.branchYJitter);
      const altPts = this._fractalPath(fp, be, P.altDepth, rough * P.altRoughMult);
      strands.push({ pts: altPts, sOff: ff, tM: P.altThickMult, aM: P.altAlphaMult });
    }

    const bolt      = this._makeBolt(strands);
    const gflash    = this._makeGFlash(wx, wy);
    const sparks    = this._makeSparks(wx, wy);
    const shockwave = this._makeShockwave(wx, wy);

    this._bolts.push({ bolt, gflash, sparks, shockwave, t0: nowSec });
    this._flashT = nowSec;
  }

  // ── Per-frame flash overlay update ───────────────────────────────────────

  _updateFlash(nowSec) {
    if (!this._flash) return;
    const P = this._P;
    const t = nowSec - this._flashT;
    const a = Math.max(0, Math.exp(-t * P.overlayDecay) * P.overlayAlpha);
    if (a < 0.002) {
      this._flash.style.opacity = '0';
    } else {
      const { r, g, b } = hexToRgb(P.overlayTint);
      this._flash.style.background = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      this._flash.style.opacity = '1';
    }
  }

  // ── Per-frame bolt update + cleanup ──────────────────────────────────────

  _update(nowSec) {
    const P = this._P;
    const maxD = Math.max(
      P.strikeDur + P.fadeDur + P.tailExtra,
      P.strikeDur + P.sparkLifeMax + 0.4,
      P.strikeDur + P.shockDur + 0.1,
      P.flashDur + 0.1
    ) + 0.3;

    for (let i = this._bolts.length - 1; i >= 0; i--) {
      const B = this._bolts[i];
      const e = nowSec - B.t0;

      if (B.bolt)    B.bolt.mat.uniforms.uTime.value     = e;
      B.gflash.mat.uniforms.uTime.value    = e - P.strikeDur;
      B.sparks.mat.uniforms.uTime.value    = e;
      B.shockwave.mat.uniforms.uTime.value = e;

      if (e > maxD) {
        if (B.bolt) {
          this._scene.remove(B.bolt.mesh);
          B.bolt.mat.dispose();
          B.bolt.geo.dispose();
        }
        this._scene.remove(B.gflash.mesh);    B.gflash.mat.dispose();
        this._scene.remove(B.sparks.mesh);    B.sparks.mat.dispose();  B.sparks.geo.dispose();
        this._scene.remove(B.shockwave.mesh); B.shockwave.mat.dispose();
        this._bolts.splice(i, 1);
      }
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  _loop() {
    requestAnimationFrame(() => this._loop());
    const now    = performance.now();
    this._lastT  = now;
    const nowSec = now / 1000;
    this._update(nowSec);
    this._updateFlash(nowSec);
    this._renderer.render(this._scene, this._cam);
  }
}

new LightningVFXOverlay();
// LIGHTNING VFX END
