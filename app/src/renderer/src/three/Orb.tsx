import { useEffect, useRef } from "react";
import * as THREE from "three";

interface OrbProps {
  size?: number;
  intensity?: number;
  speed?: number;
  className?: string;
}

const SNOISE = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uAmp;
uniform float uPointSize;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vObjPos;
varying float vDepth;
${SNOISE}
void main(){
  vec3 n = normalize(position);
  float d = snoise(position * 1.1 + vec3(uTime * 0.25 * uSpeed));
  d += 0.18 * snoise(position * 2.2 - vec3(uTime * 0.18 * uSpeed));
  vec3 displaced = position + n * d * uAmp;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vNormalV = normalize(normalMatrix * n);
  vViewDir = normalize(-mv.xyz);
  vObjPos = displaced;
  // view-space z: camera at ~3.2, front points ~ -2.2, back ~ -4.2
  float front = clamp((-mv.z - 4.4) / -2.4, 0.0, 1.0);
  vDepth = front;
  gl_PointSize = uPointSize * mix(0.7, 1.35, front);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vObjPos;
varying float vDepth;

vec3 grad(float t){
  vec3 c0 = vec3(1.0, 0.541, 0.239);   // #FF8A3D
  vec3 c1 = vec3(1.0, 0.239, 0.647);   // #FF3DA5
  vec3 c2 = vec3(0.545, 0.361, 0.965); // #8B5CF6
  vec3 c3 = vec3(0.231, 0.510, 0.965); // #3B82F6
  vec3 c4 = vec3(0.133, 0.827, 0.933); // #22D3EE
  t = fract(t) * 5.0;
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  return mix(c4, c0, t - 4.0);
}

void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  float alpha = smoothstep(0.5, 0.1, r);
  // Broad, smooth color bands across the face (like Sentient's blob), slowly drifting.
  float t = vObjPos.x * 0.28 + vObjPos.y * 0.18 + vObjPos.z * 0.12 + uTime * 0.035;
  vec3 col = grad(t);
  float fres = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 2.0);
  col *= 0.95 + 0.55 * fres;
  col += vec3(1.0) * fres * 0.18;
  // Filled front face, dim back face, bright rim.
  float a = alpha * mix(0.12, 1.0, vDepth) * (0.8 + 0.5 * fres) * uIntensity;
  gl_FragColor = vec4(col, a);
}
`;

function fibonacciSphere(count: number, radius: number): Float32Array {
  const arr = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = golden * i;
    arr[i * 3] = Math.cos(th) * rr * radius;
    arr[i * 3 + 1] = y * radius;
    arr[i * 3 + 2] = Math.sin(th) * rr * radius;
  }
  return arr;
}

export default function Orb({ size = 420, intensity = 1, speed = 1, className = "" }: OrbProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.position = "relative";
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 3.4);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(fibonacciSphere(42000, 1), 3));

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: speed },
        uAmp: { value: 0.18 * intensity },
        uIntensity: { value: intensity },
        uPointSize: { value: 2.6 * dpr },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let t = 0;

    const renderFrame = (): void => {
      material.uniforms.uTime.value = t;
      points.rotation.y = t * 0.12 * speed;
      points.rotation.x = Math.sin(t * 0.07 * speed) * 0.3;
      renderer.render(scene, camera);
    };

    const loop = (now: number): void => {
      raf = 0;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      t += dt;
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

    t = 2.0;
    renderFrame();
    schedule();

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
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [size, intensity, speed]);

  return (
    <div
      className={className}
      style={{ position: "relative", width: size, height: size, pointerEvents: "none" }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "12%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 0deg, #FF8A3D, #FF3DA5, #8B5CF6, #3B82F6, #22D3EE, #FF8A3D)",
          filter: `blur(${Math.round(size * 0.14)}px)`,
          opacity: 0.35 * Math.min(intensity, 1.5),
        }}
      />
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
