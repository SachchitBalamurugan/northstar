import { useEffect, useRef } from "react";
import * as THREE from "three";

interface WormholeProps {
  className?: string;
  opacity?: number;
}

const RINGS = 18;
const SPOKES = 36;
const SEG = 96; // segments per ring
const R_MIN = 0.35;
const R_MAX = 6;
const K = 1.4;
const Z_MIN = -4;

const depth = (r: number): number => Math.max(-K / r, Z_MIN);
// alpha: bright mid funnel, fade toward the outer edge
const fade = (r: number): number => Math.max(0, 1 - (r - R_MIN) / (R_MAX - R_MIN)) ** 0.8;

const LINE_VERT = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
void main(){
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const LINE_FRAG = /* glsl */ `
uniform float uOpacity;
varying float vAlpha;
void main(){
  gl_FragColor = vec4(vec3(1.0), vAlpha * uOpacity);
}
`;

const STAR_VERT = /* glsl */ `
uniform float uTime;
uniform float uPx;
attribute float aSeed;
varying float vA;
void main(){
  float t = fract(aSeed + uTime * 0.03);
  // fall inward along the funnel
  float r = mix(4.5, 0.4, t);
  float ang = aSeed * 6.28318 * 7.0 + uTime * 0.15 * (0.5 + aSeed);
  float z = max(-${K.toFixed(2)} / r, ${Z_MIN.toFixed(1)}) + 0.15 + position.z;
  vec4 mv = modelViewMatrix * vec4(cos(ang) * r, sin(ang) * r, z, 1.0);
  vA = sin(t * 3.14159);
  gl_PointSize = uPx * (0.8 + aSeed);
  gl_Position = projectionMatrix * mv;
}
`;
const STAR_FRAG = /* glsl */ `
uniform float uOpacity;
varying float vA;
void main(){
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  gl_FragColor = vec4(1.0, 1.0, 1.0, smoothstep(0.5, 0.0, r) * vA * 0.8 * uOpacity);
}
`;

function buildFunnel(): THREE.BufferGeometry {
  const pos: number[] = [];
  const alpha: number[] = [];
  const push = (r: number, a: number): void => {
    pos.push(Math.cos(a) * r, Math.sin(a) * r, depth(r));
    alpha.push(fade(r) * 0.85 + 0.05);
  };
  // rings: denser toward center (quadratic spacing)
  for (let i = 0; i < RINGS; i++) {
    const u = i / (RINGS - 1);
    const r = R_MIN + (R_MAX - R_MIN) * u * u;
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2;
      const a1 = ((s + 1) / SEG) * Math.PI * 2;
      push(r, a0);
      push(r, a1);
    }
  }
  // spokes: subdivided so they follow the curve
  const STEPS = 48;
  for (let j = 0; j < SPOKES; j++) {
    const a = (j / SPOKES) * Math.PI * 2;
    for (let s = 0; s < STEPS; s++) {
      const u0 = s / STEPS;
      const u1 = (s + 1) / STEPS;
      push(R_MIN + (R_MAX - R_MIN) * u0 * u0, a);
      push(R_MIN + (R_MAX - R_MIN) * u1 * u1, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alpha, 1));
  return g;
}

export default function Wormhole({ className = "", opacity = 1 }: WormholeProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

    const funnelGeo = buildFunnel();
    const funnelMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
    });
    const funnel = new THREE.LineSegments(funnelGeo, funnelMat);
    scene.add(funnel);

    const STAR_COUNT = 60;
    const starPos = new Float32Array(STAR_COUNT * 3);
    const seeds = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      seeds[i] = Math.random();
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 0.2;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 }, uPx: { value: 2.5 * dpr }, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(starGeo, starMat);
    stars.frustumCulled = false;
    scene.add(stars);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let t = 0;

    const renderFrame = (): void => {
      // camera above, ~55deg tilt, gently orbiting
      const tilt = THREE.MathUtils.degToRad(55 + Math.sin(t * 0.2) * 6);
      const orbit = t * 0.05 + Math.sin(t * 0.13) * 0.3;
      const dist = 7.5;
      const horiz = Math.sin(tilt) * dist;
      camera.position.set(Math.sin(orbit) * horiz, -Math.cos(orbit) * horiz, Math.cos(tilt) * dist);
      camera.up.set(0, 0, 1);
      camera.lookAt(0, 0, -1.2);
      funnel.rotation.z = t * 0.03;
      starMat.uniforms.uTime.value = t;
      renderer.render(scene, camera);
    };

    const resize = (): void => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderFrame();
    };

    const loop = (now: number): void => {
      raf = 0;
      t += Math.min((now - last) / 1000, 0.1);
      last = now;
      renderFrame();
      schedule();
    };
    function schedule(): void {
      if (reduced || raf || !visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
    const stop = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    t = 3;
    resize();
    schedule();

    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const onVis = (): void => {
      if (document.hidden) stop();
      else schedule();
    };
    document.addEventListener("visibilitychange", onVis);

    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) schedule();
      else stop();
    });
    io.observe(mount);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      funnelGeo.dispose();
      funnelMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [opacity]);

  return (
    <div
      ref={mountRef}
      className={className}
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
    />
  );
}
