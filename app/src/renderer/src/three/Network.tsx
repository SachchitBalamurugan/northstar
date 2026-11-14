// Constellation network: the Northstar hero visual (design system v2, see app/DESIGN.md).
// Points in a slowly rotating 3D cloud, thin links between near neighbours, a few twinkling stars,
// and one bright mint "north star". Pauses offscreen; static for reduced motion; disposes on unmount.
import { useEffect, useRef } from "react";
import * as THREE from "three";

interface NetworkProps { size?: number; className?: string; intensity?: number; speed?: number }

const MINT = new THREE.Color("#3DDC97"), BLUE = new THREE.Color("#4C9AFF"), CYAN = new THREE.Color("#2BC3D8");

const VERT = /* glsl */ `
attribute float aSize; attribute float aPhase; attribute vec3 aColor;
uniform float uTime; uniform float uPixel; uniform float uIntensity;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.65 + 0.35 * sin(uTime * 1.6 + aPhase * 6.2831);
  float bright = step(1.6, aSize);
  vAlpha = mix(0.55, tw, bright) * uIntensity;
  vColor = aColor;
  gl_PointSize = aSize * uPixel * (3.2 / -mv.z) * mix(1.0, 0.85 + 0.3 * tw, bright);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
varying vec3 vColor; varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5; float d = length(c);
  float core = smoothstep(0.5, 0.0, d);
  float a = pow(core, 2.2) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

function seeded(seed: number) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

export default function Network({ size = 360, className = "", intensity = 1, speed = 1 }: NetworkProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ intensity, speed });
  live.current = { intensity, speed };

  useEffect(() => {
    const el = host.current; if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" }); }
    catch { return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr); renderer.setSize(size, size); renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.width = `${size}px`; renderer.domElement.style.height = `${size}px`;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50); camera.position.set(0, 0, 6.2);
    const group = new THREE.Group(); scene.add(group);

    // Nodes in a soft sphere.
    const N = 170, rnd = seeded(7);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N), ph = new Float32Array(N);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = 1.9 * Math.cbrt(0.15 + 0.85 * rnd());
      const s = Math.sqrt(1 - u * u);
      const v = new THREE.Vector3(r * s * Math.cos(t), r * u * 0.82, r * s * Math.sin(t));
      if (i === 0) v.set(0.35, 0.55, 0.6); // the north star sits near the front
      pts.push(v); pos.set([v.x, v.y, v.z], i * 3);
      const roll = rnd();
      const c = i === 0 ? MINT : roll < 0.5 ? MINT : roll < 0.8 ? BLUE : CYAN;
      const k = i === 0 ? 1 : 0.75;
      col.set([c.r * k, c.g * k, c.b * k], i * 3);
      sz[i] = i === 0 ? 5.2 : rnd() < 0.08 ? 2.2 : 0.9 + rnd() * 0.5;
      ph[i] = rnd();
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    pGeo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    pGeo.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
    pGeo.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
    const pMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixel: { value: dpr * 10 }, uIntensity: { value: intensity } },
    });
    group.add(new THREE.Points(pGeo, pMat));

    // Precomputed neighbour links (up to 3 nearest within range), opacity by distance.
    const MAX_D = 0.85, seen = new Set<string>(), lp: number[] = [], lc: number[] = [];
    for (let i = 0; i < N; i++) {
      const near = pts.map((p, j) => ({ j, d: p.distanceTo(pts[i]) })).filter(o => o.j !== i && o.d < MAX_D).sort((a, b) => a.d - b.d).slice(0, i === 0 ? 5 : 3);
      for (const { j, d } of near) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`; if (seen.has(key)) continue; seen.add(key);
        const a = (1 - d / MAX_D) * (i === 0 || j === 0 ? 0.9 : 0.45);
        const c = i === 0 || j === 0 ? MINT : CYAN;
        lp.push(pts[i].x, pts[i].y, pts[i].z, pts[j].x, pts[j].y, pts[j].z);
        lc.push(c.r * a, c.g * a, c.b * a, c.r * a, c.g * a, c.b * a);
      }
    }
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
    lGeo.setAttribute("color", new THREE.Float32BufferAttribute(lc, 3));
    const lMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 * intensity, blending: THREE.AdditiveBlending, depthWrite: false });
    group.add(new THREE.LineSegments(lGeo, lMat));

    // Pointer parallax.
    const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 0.5;
      target.y = (e.clientY / window.innerHeight - 0.5) * 0.35;
    };
    if (!reduced) window.addEventListener("pointermove", onMove);

    let raf = 0, visible = true, t = 0, last = performance.now();
    const draw = () => {
      pMat.uniforms.uIntensity.value = live.current.intensity;
      lMat.opacity = 0.55 * live.current.intensity;
      renderer.render(scene, camera);
    };
    const tick = (now: number) => {
      raf = 0; if (!visible) return;
      const dt = Math.min((now - last) / 1000, 0.05); last = now;
      t += dt * live.current.speed;
      cur.x += (target.x - cur.x) * 0.04; cur.y += (target.y - cur.y) * 0.04;
      group.rotation.y = t * 0.06 + cur.x;
      group.rotation.x = 0.12 + cur.y;
      pMat.uniforms.uTime.value = t;
      draw();
      raf = requestAnimationFrame(tick);
    };
    group.rotation.x = 0.12;

    const io = new IntersectionObserver(([en]) => {
      visible = en.isIntersecting;
      if (visible && !reduced && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    });
    io.observe(el);
    if (reduced) draw(); else raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf); io.disconnect();
      window.removeEventListener("pointermove", onMove);
      pGeo.dispose(); pMat.dispose(); lGeo.dispose(); lMat.dispose();
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [size]);

  return <div ref={host} aria-hidden className={`pointer-events-none ${className}`} style={{ width: size, height: size }} />;
}
