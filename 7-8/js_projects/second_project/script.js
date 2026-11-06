/* =====================================================================
   Happy Diwali & Dhanteras - a 3D greeting from Naya Prayog
   Built with Three.js. There are no model files: every shape is made in code.

   How the idols are made:
   1. Each body part is described by a maths function that gives the distance
      from any point to that shape (a "signed distance field", or SDF).
   2. The parts are blended together with a "smooth minimum", which is why
      they melt into each other like cast metal.
   3. A "surface nets" pass turns the result into a triangle mesh.

   Sections: helpers > sculpting > materials > decorations > Ganesha >
   Lakshmi > temple > diyas and flames > particles > UI > animation loop
   ===================================================================== */
(function () {
  "use strict";

  const fatal = () => {
    document.getElementById("fatal").hidden = false;
    document.getElementById("loader").classList.add("done");
  };
  if (!window.THREE || !THREE.EffectComposer || !THREE.UnrealBloomPass) return fatal();

  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  // Waits for the browser to paint, so the loading screen stays alive between heavy steps.
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const smooth = (a, b, v) => ease((v - a) / (b - a));
  const mixRGB = (a, b, t, o) => { for (let i = 0; i < 3; i++) o[i] = a[i] + (b[i] - a[i]) * t; };

  const isSmall = Math.min(innerWidth, innerHeight) < 700;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const QUALITY = isSmall ? 1.3 : 1; // bigger number = coarser sculpt, faster loading

  /* ---------------- 1. SDF building blocks ---------------- */

  // A capsule whose radius changes from r1 at a to r2 at b (a limb segment).
  function roundCone(a, b, r1, r2, k) {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0] - ax, by = b[1] - ay, bz = b[2] - az;
    const len2 = bx * bx + by * by + bz * bz;
    return {
      k: k === undefined ? 0.05 : k,
      d(x, y, z) {
        const px = x - ax, py = y - ay, pz = z - az;
        const t = clamp((px * bx + py * by + pz * bz) / len2, 0, 1);
        const qx = px - bx * t, qy = py - by * t, qz = pz - bz * t;
        return Math.sqrt(qx * qx + qy * qy + qz * qz) - (r1 + (r2 - r1) * t);
      },
      box: [Math.min(ax, b[0]) - Math.max(r1, r2), Math.min(ay, b[1]) - Math.max(r1, r2), Math.min(az, b[2]) - Math.max(r1, r2),
            Math.max(ax, b[0]) + Math.max(r1, r2), Math.max(ay, b[1]) + Math.max(r1, r2), Math.max(az, b[2]) + Math.max(r1, r2)],
    };
  }

  function ellipsoid(c, r, k) {
    const cx = c[0], cy = c[1], cz = c[2], rx = r[0], ry = r[1], rz = r[2];
    return {
      k: k === undefined ? 0.05 : k,
      d(x, y, z) {
        const px = x - cx, py = y - cy, pz = z - cz;
        const ax = px / rx, ay = py / ry, az = pz / rz;
        const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
        if (k0 < 1e-5) return -Math.min(rx, ry, rz);
        const bx = ax / rx, by = ay / ry, bz = az / rz;
        return (k0 * (k0 - 1)) / Math.sqrt(bx * bx + by * by + bz * bz);
      },
      box: [cx - rx, cy - ry, cz - rz, cx + rx, cy + ry, cz + rz],
    };
  }

  // Joins a list of [x,y,z,radius] points into one smooth, tapering limb.
  function limb(points, k) {
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i], q = points[i + 1];
      out.push(roundCone(p, q, p[3], q[3], k === undefined ? 0.03 : k));
    }
    return out;
  }

  // A hand: palm, four fingers and a thumb. w = wrist, d = finger direction, s = sideways.
  function handParts(w, d, s, size) {
    const at = (a, b) => [w[0] + d[0] * a + s[0] * b, w[1] + d[1] * a + s[1] * b, w[2] + d[2] * a + s[2] * b];
    const parts = [
      roundCone(at(0, -0.022 * size), at(0.1 * size, -0.038 * size), 0.038 * size, 0.026 * size, 0.012),
      roundCone(at(0, 0.022 * size), at(0.1 * size, 0.038 * size), 0.038 * size, 0.026 * size, 0.012),
    ];
    const lengths = [0.075, 0.095, 0.1, 0.085];
    [-0.052, -0.018, 0.018, 0.052].forEach((off, i) => {
      parts.push(roundCone(at(0.118 * size, off * size), at((0.118 + lengths[i]) * size, off * 1.1 * size), 0.0165 * size, 0.0125 * size, 0.005));
    });
    parts.push(roundCone(at(0.03 * size, 0.05 * size), at(0.09 * size, 0.105 * size), 0.019 * size, 0.0135 * size, 0.012));
    return parts;
  }

  // A foot resting on its side: sole, heel and five toes. dir points towards the toes.
  function footParts(heel, dir, size) {
    const at = (a, up, out) => [heel[0] + dir * a * size, heel[1] + up * size, heel[2] + out * size];
    const parts = [roundCone(at(0, 0, 0), at(0.1, -0.002, 0.004), 0.072, 0.056, 0.03)];
    const toes = [[0.046, 0.019], [0.023, 0.015], [0.002, 0.014], [-0.019, 0.013], [-0.037, 0.0115]];
    toes.forEach((toe, i) => {
      const a = 0.172 - i * 0.008;
      parts.push(roundCone(at(a - 0.05, toe[0], 0.012), at(a, toe[0], 0.016), toe[1], toe[1] * 0.92, 0.012));
    });
    return parts;
  }

  // Combines parts with a smooth minimum so they melt together.
  function makeSDF(parts) {
    const n = parts.length;
    return function (x, y, z) {
      let d = parts[0].d(x, y, z);
      for (let i = 1; i < n; i++) {
        const b = parts[i].d(x, y, z), k = parts[i].k;
        const h = Math.max(k - Math.abs(d - b), 0) / k;
        d = Math.min(d, b) - h * h * k * 0.25;
      }
      return d;
    };
  }

  /* Surface nets: find grid cells the surface passes through, put one vertex in each,
     then connect neighbouring vertices into quads. */
  function polygonize(parts, h, colorFn) {
    h *= QUALITY;
    const sdf = makeSDF(parts);
    const pad = h * 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    parts.forEach((p) => {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p.box[a] - pad);
        max[a] = Math.max(max[a], p.box[a + 3] + pad);
      }
    });
    const nx = Math.ceil((max[0] - min[0]) / h) + 1;
    const ny = Math.ceil((max[1] - min[1]) / h) + 1;
    const nz = Math.ceil((max[2] - min[2]) / h) + 1;
    const field = new Float32Array(nx * ny * nz);
    const id = (i, j, k) => i + nx * (j + ny * k);

    // Skip whole blocks that are far from the surface. This saves most of the work.
    const B = 4, far = h * B * 1.732 * 1.6;
    for (let kb = 0; kb < nz; kb += B) for (let jb = 0; jb < ny; jb += B) for (let ib = 0; ib < nx; ib += B) {
      const c = sdf(min[0] + (ib + B / 2) * h, min[1] + (jb + B / 2) * h, min[2] + (kb + B / 2) * h);
      const skip = Math.abs(c) > far;
      const kEnd = Math.min(kb + B, nz), jEnd = Math.min(jb + B, ny), iEnd = Math.min(ib + B, nx);
      for (let k = kb; k < kEnd; k++) for (let j = jb; j < jEnd; j++) for (let i = ib; i < iEnd; i++) {
        field[id(i, j, k)] = skip ? c : sdf(min[0] + i * h, min[1] + j * h, min[2] + k * h);
      }
    }

    const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cellVert = new Int32Array(nx * ny * nz).fill(-1);
    const pos = [];
    const vals = new Float32Array(8);

    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const v = field[id(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
        vals[c] = v;
        if (v < 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, count = 0;
      for (let e = 0; e < 12; e++) {
        const a = edges[e][0], b = edges[e][1];
        if ((vals[a] < 0) === (vals[b] < 0)) continue;
        const t = vals[a] / (vals[a] - vals[b]);
        sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
        sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
        sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
        count++;
      }
      cellVert[id(i, j, k)] = pos.length / 3;
      pos.push(min[0] + (i + sx / count) * h, min[1] + (j + sy / count) * h, min[2] + (k + sz / count) * h);
    }

    const index = [];
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) index.push(a, c, b, a, d, c);
      else index.push(a, b, c, a, c, d);
    };
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const v0 = field[id(i, j, k)] < 0;
      if (v0 !== (field[id(i + 1, j, k)] < 0)) {
        quad(cellVert[id(i, j - 1, k - 1)], cellVert[id(i, j, k - 1)], cellVert[id(i, j, k)], cellVert[id(i, j - 1, k)], !v0);
      }
      if (v0 !== (field[id(i, j + 1, k)] < 0)) {
        quad(cellVert[id(i - 1, j, k - 1)], cellVert[id(i - 1, j, k)], cellVert[id(i, j, k)], cellVert[id(i, j, k - 1)], !v0);
      }
      if (v0 !== (field[id(i, j, k + 1)] < 0)) {
        quad(cellVert[id(i - 1, j - 1, k)], cellVert[id(i, j - 1, k)], cellVert[id(i, j, k)], cellVert[id(i - 1, j, k)], !v0);
      }
    }

    // Smooth normals come straight from the slope of the distance field.
    const count = pos.length / 3;
    const normal = new Float32Array(count * 3);
    const color = colorFn ? new Float32Array(count * 3) : null;
    const out = [1, 1, 1], e = h * 0.7;
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let gx = sdf(x + e, y, z) - sdf(x - e, y, z);
      let gy = sdf(x, y + e, z) - sdf(x, y - e, z);
      let gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const len = Math.hypot(gx, gy, gz) || 1;
      gx /= len; gy /= len; gz /= len;
      normal[i * 3] = gx; normal[i * 3 + 1] = gy; normal[i * 3 + 2] = gz;
      if (color) {
        colorFn(x, y, z, gx, gy, gz, out);
        color[i * 3] = out[0]; color[i * 3 + 1] = out[1]; color[i * 3 + 2] = out[2];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    if (color) geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
    geo.setIndex(index);
    geo.userData.sdf = sdf;
    return geo;
  }

  // Finds the front (+z) of a sculpt at (x, y), so jewellery can sit exactly on the surface.
  function frontZ(x, y, sdfs, zStart) {
    let z = zStart === undefined ? 1.6 : zStart;
    for (let i = 0; i < 70; i++) {
      let d = Infinity;
      for (const f of sdfs) d = Math.min(d, f(x, y, z));
      if (d < 0.002) return z;
      z -= Math.max(d * 0.8, 0.002);
      if (z < -1.5) break;
    }
    return 0;
  }

  /* ---------------- 2. Renderer, scene and camera ---------------- */

  THREE.ColorManagement.legacyMode = false;

  let renderer;
  const canvas = document.getElementById("scene");
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  } catch (err) {
    return fatal();
  }
  const maxDPR = 1.5;
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxDPR));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // the idols barely move, so shadows are redrawn every few frames
  renderer.physicallyCorrectLights = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x16060f, 0.022);
  const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 160);

  /* A tiny bright "studio" that is captured into an environment map.
     Polished metal is really just a mirror, so gold needs warm shapes to reflect. */
  function buildEnvironment() {
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x0d0407);
    const panel = (color, power, w, h, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }));
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(0xffb468, 1.5, 26, 14, 0, 2, 13);  // broad fill behind the camera
    panel(0xffdca8, 9, 7, 4, 0, 8, 5);      // soft top-front window
    panel(0xff9a3d, 7, 3, 7, -9, 1, 4);     // warm left
    panel(0xff7a2e, 6, 3, 7, 9, 1, 4);      // warm right
    panel(0xffb765, 5, 12, 1.5, 0, -4, 8);  // lamps on the floor
    panel(0xff4f7a, 3, 4, 8, -5, 3, -9);    // rose back light
    panel(0xffc070, 4, 4, 8, 6, 3, -9);     // gold back light
    panel(0xfff0d0, 14, 1, 5, 4, 3, 10);    // long specular streak
    panel(0xfff0d0, 12, 1, 5, -4, 3, 10);
    const pm = new THREE.PMREMGenerator(renderer);
    const tex = pm.fromScene(env, 0.025).texture;
    pm.dispose();
    return tex;
  }
  const envMap = buildEnvironment();
  scene.environment = envMap;

  /* ---------------- 3. Materials ---------------- */

  const standard = (o) => new THREE.MeshStandardMaterial(Object.assign({ envMapIntensity: 1 }, o));
  const MAT = {
    gold: standard({ color: 0xf4b04a, metalness: 1, roughness: 0.24, envMapIntensity: 0.85 }),
    goldDull: standard({ color: 0xc88c34, metalness: 1, roughness: 0.42 }),
    ganeshaSkin: standard({ color: 0xffffff, vertexColors: true, metalness: 0.82, roughness: 0.34, envMapIntensity: 0.72 }),
    lakshmiSkin: standard({ color: 0xffffff, vertexColors: true, metalness: 0.78, roughness: 0.32, envMapIntensity: 0.72 }),
    silk: standard({ color: 0xffffff, vertexColors: true, metalness: 0.38, roughness: 0.46, envMapIntensity: 0.9 }),
    hair: standard({ color: 0x120908, metalness: 0.3, roughness: 0.42 }),
    ivory: standard({ color: 0xfff0d2, metalness: 0.05, roughness: 0.28 }),
    eyeWhite: standard({ color: 0xfffaf0, metalness: 0, roughness: 0.25, emissive: 0x2a2520 }),
    eyeDark: standard({ color: 0x0c0605, metalness: 0.1, roughness: 0.2 }),
    sindoor: standard({ color: 0xe0121e, metalness: 0.2, roughness: 0.35, emissive: 0x3a0205 }),
    ruby: standard({ color: 0xe5102c, metalness: 0.3, roughness: 0.08, emissive: 0x50030c }),
    emerald: standard({ color: 0x0fb269, metalness: 0.3, roughness: 0.08, emissive: 0x013a20 }),
    pearl: standard({ color: 0xfff6e8, metalness: 0.1, roughness: 0.2 }),
    clay: standard({ color: 0xa4522a, metalness: 0, roughness: 0.75 }),
    oil: standard({ color: 0x4f2a08, metalness: 0.7, roughness: 0.15 }),
    leaf: standard({ color: 0x1b7d3b, metalness: 0.05, roughness: 0.4, side: THREE.DoubleSide }),
    maroon: standard({ color: 0x4d0d18, metalness: 0.35, roughness: 0.5 }),
    petal: standard({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: 0.42, side: THREE.DoubleSide, emissive: 0x5a0d2e, emissiveIntensity: 0.28 }),
  };

  const hex = (c) => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; };
  const GOLD_RGB = hex(0xe6b24c);

  function addMesh(parent, geo, mat, shadow) {
    const m = new THREE.Mesh(geo, mat);
    if (shadow) m.castShadow = true;
    parent.add(m);
    return m;
  }

  /* ---------------- 4. Decoration helpers ---------------- */

  function tube(parent, points, radius, mat, closed) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : V3(p[0], p[1], p[2]))), !!closed, "centripetal");
    return addMesh(parent, new THREE.TubeGeometry(curve, Math.max(24, points.length * 8), radius, 8, !!closed), mat);
  }

  const beadGeo = new THREE.SphereGeometry(1, 12, 10);
  // Places many spheres cheaply: all of them share one draw call.
  function beads(parent, points, size, mat) {
    const m = new THREE.InstancedMesh(beadGeo, mat, points.length);
    const d = new THREE.Object3D();
    points.forEach((p, i) => {
      d.position.set(p[0], p[1], p[2]);
      d.scale.setScalar(typeof size === "function" ? size(i) : size);
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
    });
    parent.add(m);
    return m;
  }

  function sampleCurve(points, n) {
    const c = new THREE.CatmullRomCurve3(points.map((p) => V3(p[0], p[1], p[2])), false, "centripetal");
    return c.getSpacedPoints(n - 1).map((p) => [p.x, p.y, p.z]);
  }

  function gem(parent, x, y, z, size, mat) {
    const m = addMesh(parent, new THREE.SphereGeometry(size, 16, 12), mat || MAT.ruby);
    m.position.set(x, y, z);
    m.scale.z = 0.6;
    const bezel = addMesh(parent, new THREE.TorusGeometry(size * 1.08, size * 0.2, 8, 20), MAT.gold);
    bezel.position.set(x, y, z);
    return m;
  }

  // A closed band around the body, such as an armlet or a bangle.
  function band(parent, center, radius, thickness, axis, mat) {
    const m = addMesh(parent, new THREE.TorusGeometry(radius, thickness, 10, 30), mat || MAT.gold);
    m.position.set(center[0], center[1], center[2]);
    m.quaternion.setFromUnitVectors(V3(0, 0, 1), V3(axis[0], axis[1], axis[2]).normalize());
    return m;
  }

  // A marigold: a bumpy little ball, reused for every garland.
  const marigoldGeo = (function () {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = V3(p.getX(i), p.getY(i), p.getZ(i)).normalize();
      const bump = 0.85 + 0.22 * Math.abs(Math.sin(v.x * 9) * Math.sin(v.y * 9 + 1) * Math.sin(v.z * 9 + 2));
      p.setXYZ(i, v.x * bump, v.y * bump, v.z * bump);
    }
    g.computeVertexNormals();
    return g;
  })();
  const marigoldMat = standard({ color: 0xffffff, metalness: 0, roughness: 0.62, emissive: 0x4a1a00, emissiveIntensity: 0.4 });
  const marigoldColors = [0xff9a0e, 0xffb31a, 0xff7b0a, 0xffc72e].map((c) => new THREE.Color(c));

  function garland(parent, points, count, size) {
    const m = new THREE.InstancedMesh(marigoldGeo, marigoldMat, count);
    const d = new THREE.Object3D();
    sampleCurve(points, count).forEach((p, i) => {
      d.position.set(p[0], p[1], p[2]);
      d.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
      d.scale.setScalar(size * rand(0.86, 1.14));
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
      m.setColorAt(i, marigoldColors[i % 4]);
    });
    parent.add(m);
    return m;
  }

  // A pointed lotus petal, shared by every lotus in the scene.
  const petalGeo = (function () {
    const g = new THREE.PlaneGeometry(1, 1, 8, 10);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const root = hex(0xfff0dc), mid = hex(0xff77ae), tip = hex(0xd31c72);
    for (let i = 0; i < p.count; i++) {
      const v = p.getX(i) * 2;       // -1..1 across the petal
      const u = p.getY(i) + 0.5;     // 0..1 along the petal
      const w = Math.sin(Math.PI * Math.pow(u, 0.72)) * 0.5;
      p.setXYZ(i, v * w, 0.55 * u * u + 0.32 * v * v * w, u);
      const a = u < 0.5 ? root : mid, b = u < 0.5 ? mid : tip, t = u < 0.5 ? u * 2 : (u - 0.5) * 2;
      for (let c = 0; c < 3; c++) col[i * 3 + c] = a[c] + (b[c] - a[c]) * t;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  })();

  function lotus(parent, x, y, z, r, tiltX, open) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    if (tiltX) group.rotation.x = tiltX;
    const rings = [
      { n: 15, len: 1.0, wid: 0.5, tilt: open ? 0.02 : 0.14, h: 0 },
      { n: 13, len: 0.82, wid: 0.46, tilt: open ? 0.2 : 0.62, h: 0.03 },
      { n: 9, len: 0.58, wid: 0.36, tilt: open ? 0.42 : 1.08, h: 0.06 },
    ];
    const total = rings.reduce((s, q) => s + q.n, 0);
    const mesh = new THREE.InstancedMesh(petalGeo, MAT.petal, total);
    const d = new THREE.Object3D();
    let idx = 0;
    rings.forEach((ring, ri) => {
      for (let i = 0; i < ring.n; i++) {
        const a = ((i + ri * 0.5) / ring.n) * Math.PI * 2;
        d.position.set(Math.sin(a) * r * 0.12, ring.h * r, Math.cos(a) * r * 0.12);
        d.rotation.set(-ring.tilt, a, 0, "YXZ");
        d.scale.set(r * ring.wid * 1.5, r * ring.len, r * ring.len);
        d.updateMatrix();
        mesh.setMatrixAt(idx++, d.matrix);
      }
    });
    group.add(mesh);
    const pod = addMesh(group, new THREE.SphereGeometry(r * 0.16, 16, 12), MAT.gold);
    pod.position.y = r * 0.2;
    parent.add(group);
    return group;
  }

  /* A tiered temple-style crown (mukut). */
  function crown(parent, x, y, z, r, h) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const profile = [
      [r * 1.04, 0], [r * 1.09, 0.03 * h], [r * 1.0, 0.07 * h], [r * 0.9, 0.2 * h],
      [r * 0.98, 0.23 * h], [r * 0.74, 0.27 * h], [r * 0.62, 0.42 * h],
      [r * 0.72, 0.45 * h], [r * 0.5, 0.49 * h], [r * 0.38, 0.64 * h],
      [r * 0.47, 0.67 * h], [r * 0.26, 0.71 * h], [r * 0.17, 0.86 * h],
      [r * 0.1, 0.92 * h], [r * 0.03, 1.0 * h], [0.0005, 1.0 * h],
    ];
    const m = addMesh(group, new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), 56), MAT.gold, true);
    m.geometry.computeVertexNormals();

    const beadRing = (ry, rr, n, size, mat) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push([Math.sin(a) * rr, ry, Math.cos(a) * rr]);
      }
      beads(group, pts, size, mat);
    };
    beadRing(0.035 * h, r * 1.1, 42, r * 0.034, MAT.pearl);
    beadRing(0.23 * h, r * 0.99, 30, r * 0.034, MAT.gold);
    beadRing(0.45 * h, r * 0.73, 24, r * 0.032, MAT.gold);
    beadRing(0.67 * h, r * 0.48, 18, r * 0.03, MAT.gold);

    // A leaf-shaped front plate and two smaller side plates.
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, 0);
    shape.bezierCurveTo(-0.62, 0.42, -0.28, 0.62, 0, 1);
    shape.bezierCurveTo(0.28, 0.62, 0.62, 0.42, 0.5, 0);
    shape.lineTo(-0.5, 0);
    const plateGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
    const plate = (px, py, pz, sx, sy, ry) => {
      const p = addMesh(group, plateGeo, MAT.gold);
      p.position.set(px, py, pz);
      p.rotation.y = ry;
      p.scale.set(sx, sy, sx * 0.5);
      return p;
    };
    plate(0, 0.06 * h, r * 0.95, r * 1.0, h * 0.52, 0);
    [-1, 1].forEach((s) => plate(s * r * 0.72, 0.05 * h, r * 0.68, r * 0.62, h * 0.33, s * 0.82));

    gem(group, 0, 0.21 * h, r * 1.03, r * 0.13, MAT.ruby);
    gem(group, 0, 0.39 * h, r * 0.99, r * 0.075, MAT.emerald);
    [-1, 1].forEach((s) => gem(group, s * r * 0.84, 0.14 * h, r * 0.78, r * 0.065, MAT.emerald));
    const finial = addMesh(group, new THREE.SphereGeometry(r * 0.08, 14, 10), MAT.ruby);
    finial.position.y = h * 1.0;
    parent.add(group);
    return group;
  }

  /* A round, tiered golden pedestal. */
  function pedestal(parent, x, z, r, h) {
    const profile = [
      [0.0005, 0], [r * 1.13, 0], [r * 1.14, h * 0.2], [r * 1.02, h * 0.28], [r * 0.9, h * 0.34],
      [r * 0.86, h * 0.68], [r * 0.98, h * 0.76], [r * 1.05, h * 0.86], [r * 1.05, h], [0.0005, h],
    ];
    const m = addMesh(parent, new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), 64), MAT.goldDull);
    m.position.set(x, 0, z);
    m.castShadow = true;
    m.receiveShadow = true;
    const gems = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      gems.push([x + Math.sin(a) * r * 0.885, h * 0.51, z + Math.cos(a) * r * 0.885]);
    }
    beads(parent, gems, r * 0.03, MAT.ruby);
    return m;
  }

  /* Almond eyes, a lash line and a brow, placed on the face surface.
     s = -1 or 1 for the side, tilt lifts the outer corner. */
  function faceEye(parent, sdfs, cx, cy, w, hgt, tilt, browGap, lineR) {
    [-1, 1].forEach((s) => {
      const x = s * cx;
      const z = frontZ(x, cy, sdfs);
      const white = addMesh(parent, new THREE.SphereGeometry(1, 24, 14), MAT.eyeWhite);
      white.position.set(x, cy, z - 0.002);
      white.scale.set(w, hgt, hgt * 0.55);
      white.rotation.z = s * tilt;
      const iris = addMesh(parent, new THREE.SphereGeometry(hgt * 0.86, 16, 12), MAT.eyeDark);
      iris.position.set(x, cy - hgt * 0.05, z + hgt * 0.2);
      iris.scale.z = 0.4;
      const lineAt = (t, lift) => {
        const lx = x + s * t * w * 1.08;
        const ly = cy + (1 - t * t) * hgt * lift + t * s * s * w * Math.sin(tilt);
        return [lx, ly, frontZ(lx, ly, sdfs) + 0.003];
      };
      const upper = [], brow = [];
      for (let i = 0; i <= 8; i++) {
        const t = -1 + i / 4;
        upper.push(lineAt(t, 1.02));
        const bx = x + s * t * w * 1.28 + s * w * 0.1;
        const by = cy + browGap + (1 - t * t) * hgt * 0.8 - t * w * 0.1;
        brow.push([bx, by, frontZ(bx, by, sdfs) + 0.002]);
      }
      tube(parent, upper, lineR, MAT.eyeDark);
      tube(parent, brow, lineR * 0.72, MAT.eyeDark);
      // Soft lower lid, so the eye reads as calm rather than staring.
      const lower = [];
      for (let i = 0; i <= 8; i++) lower.push(lineAt(-1 + i / 4, -0.82));
      tube(parent, lower, lineR * 0.42, MAT.eyeDark);
    });
  }

  /* ---------------- 5. Ganesha ---------------- */

  function buildGanesha() {
    const root = new THREE.Group();
    const seatH = 0.42;
    pedestal(root, 0, 0.12, 1.08, seatH);

    const body = new THREE.Group();
    body.position.y = seatH + 0.06;
    root.add(body);

    // Round red cushion
    const cushion = addMesh(body, new THREE.SphereGeometry(1, 40, 20), standard({ color: 0x9c0f24, metalness: 0.3, roughness: 0.42 }));
    cushion.scale.set(1.0, 0.12, 0.92);
    cushion.position.set(0, 0, 0.14);
    band(body, [0, 0.015, 0.14], 1, 0.02, [0, 1, 0]).scale.z = 0.92;

    const skinColor = (x, y, z, nx, ny, nz, o) => {
      o[0] = 0.9; o[1] = 0.48; o[2] = 0.15;
    };

    /* Body: big belly, chest and four arms */
    const torso = [
      ellipsoid([0, 0.62, 0.15], [0.57, 0.55, 0.5], 0.12),
      ellipsoid([0, 1.06, 0.0], [0.46, 0.42, 0.34], 0.2),
      ellipsoid([-0.41, 1.25, 0], [0.18, 0.17, 0.17], 0.12),
      ellipsoid([0.41, 1.25, 0], [0.18, 0.17, 0.17], 0.12),
      roundCone([0, 1.25, 0], [0, 1.45, 0.03], 0.22, 0.22, 0.1),
      // lower arms
      ...limb([[-0.47, 1.22, 0.02, 0.135], [-0.76, 0.84, 0.2, 0.115], [-0.74, 1.02, 0.5, 0.083]], 0.03),
      ...limb([[0.47, 1.22, 0.02, 0.135], [0.8, 0.76, 0.2, 0.115], [0.63, 0.62, 0.56, 0.083]], 0.03),
      // upper arms, reaching outwards and up
      ...limb([[-0.42, 1.34, -0.08, 0.115], [-0.94, 1.3, -0.14, 0.095], [-1.05, 1.72, -0.08, 0.07]], 0.03),
      ...limb([[0.42, 1.34, -0.08, 0.115], [0.94, 1.3, -0.14, 0.095], [1.05, 1.72, -0.08, 0.07]], 0.03),
    ];
    const torsoGeo = polygonize(torso, 0.024, skinColor);
    addMesh(body, torsoGeo, MAT.ganeshaSkin, true);

    /* Dhoti (silk with gold zari stripes) */
    const dhotiColor = (x, y, z, nx, ny, nz, o) => {
      const stripe = smooth(0.84, 0.96, Math.sin((z * 0.6 + Math.abs(x)) * 24));
      const edge = smooth(0.45, 0.48, y);
      mixRGB([0.62, 0.015, 0.035], GOLD_RGB, Math.max(stripe, edge), o);
    };
    const dhotiParts = [
      ellipsoid([0, 0.26, 0.12], [0.66, 0.29, 0.52], 0.1),
      ...limb([[-0.22, 0.26, 0.24, 0.26], [-0.8, 0.2, 0.56, 0.2], [0.05, 0.18, 0.84, 0.13]], 0.07),
      ...limb([[0.22, 0.26, 0.24, 0.26], [0.8, 0.2, 0.56, 0.2], [-0.05, 0.13, 0.9, 0.13]], 0.07),
    ];
    const dhotiGeo = polygonize(dhotiParts, 0.024, dhotiColor);
    addMesh(body, dhotiGeo, MAT.silk, true);

    const bodySDFs = [torsoGeo.userData.sdf, dhotiGeo.userData.sdf];

    // Hands. Abhaya mudra (blessing) on one side, a bowl of modak on the other.
    const hands = [
      ...handParts([-0.74, 1.05, 0.52], [0, 1, 0.12], [1, 0, 0], 1.32),
      ...handParts([0.63, 0.61, 0.6], [-0.42, 0.04, 0.9], [0.9, 0, 0.42], 1.25),
      ...handParts([-1.05, 1.74, -0.07], [0, 1, 0.1], [1, 0, 0], 1.08),
      ...handParts([1.05, 1.74, -0.07], [0, 1, 0.1], [-1, 0, 0], 1.08),
    ];
    addMesh(body, polygonize(hands, 0.0105, skinColor), MAT.ganeshaSkin, true);

    // Bangles and armlets
    band(body, [-0.74, 1.0, 0.49], 0.09, 0.016, [0, 1, 0.3]);
    band(body, [-0.74, 0.96, 0.46], 0.095, 0.012, [0, 1, 0.3]);
    band(body, [0.64, 0.63, 0.55], 0.09, 0.016, [0.3, 0.2, 1]);
    band(body, [-1.05, 1.67, -0.08], 0.078, 0.014, [0, 1, 0.1]);
    band(body, [1.05, 1.67, -0.08], 0.078, 0.014, [0, 1, 0.1]);
    band(body, [-0.62, 1.03, 0.11], 0.135, 0.022, [-0.6, -0.8, 0.3]);
    band(body, [0.62, 1.0, 0.11], 0.135, 0.022, [0.6, -0.8, 0.3]);
    band(body, [-0.7, 1.32, -0.11], 0.11, 0.018, [1, 0, 0]);
    band(body, [0.7, 1.32, -0.11], 0.11, 0.018, [1, 0, 0]);
    addMesh(body, polygonize([
      ...footParts([-0.2, 0.18, 0.86], -1, 1.45),
      ...footParts([0.2, 0.11, 0.94], 1, 1.45),
    ], 0.0095, skinColor), MAT.ganeshaSkin, true);
    band(body, [-0.17, 0.18, 0.86], 0.082, 0.011, [1, 0, 0]);
    band(body, [0.17, 0.11, 0.94], 0.082, 0.011, [1, 0, 0]);

    // Waist belt following the top of the dhoti, and a navel jewel
    const belt = [];
    for (let i = -8; i <= 8; i++) {
      const x = (i / 8) * 0.5;
      const y = 0.47 + 0.05 * (i / 8) * (i / 8);
      belt.push([x, y, frontZ(x, y, bodySDFs) + 0.004]);
    }
    tube(body, belt, 0.022, MAT.gold);
    gem(body, 0, 0.47, frontZ(0, 0.47, bodySDFs) + 0.02, 0.042, MAT.ruby);

    // Necklace layers that hug the chest
    const drape = (depth, n, width, top, offset) => {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * 2 - 1;
        const x = t * width;
        const y = top - depth * (1 - t * t);
        pts.push([x, y, frontZ(x, y, bodySDFs) + offset]);
      }
      return pts;
    };
    tube(body, drape(0.1, 24, 0.33, 1.33, 0.006), 0.018, MAT.gold);
    beads(body, drape(0.22, 26, 0.36, 1.33, 0.012), 0.022, MAT.pearl);
    tube(body, drape(0.36, 28, 0.42, 1.34, 0.008), 0.016, MAT.gold);
    gem(body, 0, 0.97, frontZ(0, 0.97, bodySDFs) + 0.02, 0.05, MAT.emerald);
    // Marigold garland
    garland(body, drape(0.72, 30, 0.5, 1.28, 0.03), 40, 0.05);

    // Sacred thread across the belly
    const thread = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18;
      const x = -0.34 + t * 0.78;
      const y = 1.28 - t * 0.78;
      thread.push([x, y, frontZ(x, y, bodySDFs) + 0.006]);
    }
    tube(body, thread, 0.009, MAT.gold);

    /* Head, as its own group so it can gently nod */
    const head = new THREE.Group();
    head.position.set(0, 1.4, 0);
    body.add(head);
    const toHead = (p) => [p[0], p[1] - 1.4, p[2]];
    const trunkPts = [
      [0, 1.62, 0.34, 0.185], [0, 1.44, 0.49, 0.155], [-0.02, 1.24, 0.59, 0.13], [0.0, 1.05, 0.68, 0.11],
      [0.08, 0.87, 0.75, 0.092], [0.22, 0.73, 0.82, 0.076], [0.37, 0.68, 0.84, 0.062], [0.47, 0.74, 0.82, 0.05], [0.5, 0.82, 0.78, 0.042],
    ].map((p) => [...toHead(p), p[3]]);
    const headParts = [
      ellipsoid(toHead([0, 1.7, 0.03]), [0.37, 0.39, 0.37], 0.1),
      ellipsoid(toHead([-0.165, 1.94, 0.14]), [0.17, 0.16, 0.16], 0.1),
      ellipsoid(toHead([0.165, 1.94, 0.14]), [0.17, 0.16, 0.16], 0.1),
      ellipsoid(toHead([-0.22, 1.54, 0.2]), [0.17, 0.19, 0.17], 0.12),
      ellipsoid(toHead([0.22, 1.54, 0.2]), [0.17, 0.19, 0.17], 0.12),
      ...limb(trunkPts, 0.05),
    ];
    // Trunk folds are shaded in with slightly darker colour bands.
    const headColor = (x, y, z, nx, ny, nz, o) => {
      const wy = y + 1.4;
      const onTrunk = z > 0.34 && wy < 1.42;
      const fold = onTrunk && Math.sin(wy * 62) > 0.5;
      const f = fold ? 0.72 : 1;
      o[0] = 0.9 * f; o[1] = 0.48 * f; o[2] = 0.15 * f;
    };
    const headGeo = polygonize(headParts, 0.015, headColor);
    addMesh(head, headGeo, MAT.ganeshaSkin, true);
    const headSDF = [headGeo.userData.sdf];

    // Gold rings around the trunk
    [[0, 1.36, 0.53, 0.146, [0.03, -0.75, 0.5]], [0, 1.15, 0.63, 0.122, [0.06, -0.9, 0.35]]].forEach((r) => {
      band(head, toHead(r), r[3], 0.013, r[4]);
    });

    // Tusks: the left is whole, the right is traditionally broken
    addMesh(head, polygonize(limb([[-0.22, 0.05, 0.3, 0.052], [-0.26, -0.05, 0.38, 0.042]], 0.01), 0.01), MAT.ivory);
    addMesh(head, polygonize(limb([[0.22, 0.05, 0.3, 0.052], [0.27, -0.1, 0.4, 0.036], [0.23, -0.26, 0.5, 0.008]], 0.01), 0.01), MAT.ivory);
    band(head, [-0.22, 0.05, 0.3], 0.055, 0.009, [0, -0.4, 0.8]);
    band(head, [0.22, 0.05, 0.3], 0.055, 0.009, [0, -0.4, 0.8]);

    faceEye(head, headSDF, 0.19, 0.33, 0.056, 0.03, 0.2, 0.08, 0.0058);

    // Red and gold tilak on the forehead
    const tilakZ = (x, y) => frontZ(x, y, headSDF) + 0.003;
    tube(head, [[-0.07, 0.56, tilakZ(-0.07, 0.56)], [-0.045, 0.47, tilakZ(-0.045, 0.47)], [0, 0.43, tilakZ(0, 0.43)], [0.045, 0.47, tilakZ(0.045, 0.47)], [0.07, 0.56, tilakZ(0.07, 0.56)]], 0.011, MAT.sindoor);
    gem(head, 0, 0.5, tilakZ(0, 0.5) + 0.006, 0.026, MAT.ruby);

    // Big ears, each on its own pivot so it can flap
    const ears = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.33, 0.29, -0.02);
      head.add(pivot);
      const earColor = (x, y, z, nx, ny, nz, o) => {
        const edge = Math.abs(x) > 0.5 || y < -0.34 || y > 0.31;
        const inner = nz > 0.3 && !edge;
        const c = edge ? GOLD_RGB : inner ? [0.8, 0.12, 0.08] : [0.9, 0.48, 0.15];
        o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
      };
      const earGeo = polygonize([
        ellipsoid([s * 0.27, 0.03, -0.04], [0.31, 0.32, 0.038], 0.05),
        ellipsoid([s * 0.2, -0.24, -0.02], [0.17, 0.2, 0.034], 0.1),
        ellipsoid([s * 0.03, 0, 0], [0.09, 0.18, 0.05], 0.09),
      ], 0.013, earColor);
      addMesh(pivot, earGeo, MAT.ganeshaSkin, true);
      const dangle = addMesh(pivot, new THREE.SphereGeometry(0.038, 14, 12), MAT.ruby);
      dangle.position.set(s * 0.2, -0.46, 0.0);
      band(pivot, [s * 0.2, -0.41, 0], 0.024, 0.006, [0, 0, 1]);
      return pivot;
    });

    crown(head, 0, 0.58, 0.06, 0.3, 0.74);

    /* Objects he holds */
    // Modak bowl in the lower hand
    const bowl = addMesh(body, new THREE.LatheGeometry([[0.0005, -0.04], [0.11, -0.03], [0.18, 0.05], [0.19, 0.07], [0.17, 0.05], [0.0005, 0.02]].map((p) => new THREE.Vector2(p[0], p[1])), 32), MAT.gold);
    bowl.position.set(0.56, 0.71, 0.76);
    const modakGeo = new THREE.LatheGeometry([[0.0005, 0], [0.06, 0.005], [0.066, 0.03], [0.045, 0.07], [0.018, 0.1], [0.0005, 0.12]].map((p) => new THREE.Vector2(p[0], p[1])), 12);
    const modakMat = standard({ color: 0xfff3da, roughness: 0.55 });
    [[0.5, 0.78, 0.74], [0.61, 0.78, 0.8], [0.58, 0.77, 0.68], [0.55, 0.83, 0.76]].forEach((p) => {
      addMesh(body, modakGeo, modakMat).position.set(p[0], p[1] - 0.02, p[2]);
    });

    // Axe (parashu) in the upper right hand
    tube(body, [[-1.08, 1.32, -0.03], [-1.08, 2.32, -0.03]], 0.017, MAT.gold);
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0, -0.07);
    bladeShape.quadraticCurveTo(-0.15, -0.12, -0.3, -0.2);
    bladeShape.quadraticCurveTo(-0.38, 0, -0.3, 0.2);
    bladeShape.quadraticCurveTo(-0.15, 0.12, 0, 0.07);
    bladeShape.lineTo(0, -0.07);
    const blade = addMesh(body, new THREE.ExtrudeGeometry(bladeShape, { depth: 0.012, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 1 }), MAT.gold);
    blade.position.set(-1.08, 2.2, -0.04);
    beads(body, [[-1.08, 2.34, -0.03]], 0.03, MAT.ruby);

    // Lotus in the upper left hand
    lotus(body, 1.06, 2.03, -0.06, 0.2, 0.18);
    tube(body, [[1.06, 1.74, -0.06], [1.06, 2.04, -0.06]], 0.013, MAT.leaf);

    root.userData = { head, ears };
    return root;
  }

  /* ---------------- 6. Lakshmi ---------------- */

  function buildLakshmi() {
    const root = new THREE.Group();
    const seatH = 0.3;
    pedestal(root, 0, 0.12, 1.08, seatH);

    lotus(root, 0, seatH + 0.02, 0.14, 1.2, 0, true);

    const body = new THREE.Group();
    const bodyY = seatH + 0.25, bodyScale = 1.08;
    body.position.y = bodyY;
    body.scale.setScalar(bodyScale);
    root.add(body);

    const skinColor = (x, y, z, nx, ny, nz, o) => { o[0] = 1; o[1] = 0.69; o[2] = 0.32; };

    const skinParts = [
      ellipsoid([0, 0.9, 0.0], [0.205, 0.26, 0.15], 0.1),                 // midriff
      ellipsoid([0, 1.26, 0.0], [0.29, 0.22, 0.17], 0.1),                 // upper chest
      roundCone([0, 1.44, -0.005], [0, 1.6, 0.012], 0.085, 0.078, 0.04),  // neck
      ellipsoid([-0.285, 1.4, -0.01], [0.09, 0.085, 0.085], 0.08),
      ellipsoid([0.285, 1.4, -0.01], [0.09, 0.085, 0.085], 0.08),
      // lower arms, offering blessings
      ...limb([[-0.31, 1.39, 0, 0.066], [-0.5, 1.0, 0.1, 0.056], [-0.56, 0.84, 0.44, 0.041]], 0.02),
      ...limb([[0.31, 1.39, 0, 0.066], [0.5, 1.0, 0.1, 0.056], [0.56, 0.84, 0.44, 0.041]], 0.02),
      // upper arms, holding lotuses high
      ...limb([[-0.3, 1.42, -0.05, 0.058], [-0.67, 1.3, -0.1, 0.05], [-0.76, 1.68, -0.06, 0.036]], 0.02),
      ...limb([[0.3, 1.42, -0.05, 0.058], [0.67, 1.3, -0.1, 0.05], [0.76, 1.68, -0.06, 0.036]], 0.02),
    ];
    const skinGeo = polygonize(skinParts, 0.015, skinColor);
    addMesh(body, skinGeo, MAT.lakshmiSkin, true);

    // Sari: deep crimson silk with gold woven dots and a heavy border
    const sariColor = (x, y, z, nx, ny, nz, o) => {
      const buti = smooth(0.62, 0.86, Math.sin(x * 42) * Math.sin(y * 42 + 0.5) * Math.sin(z * 42 + 1)) * 0.5;
      const hem = Math.max(smooth(0.76, 0.8, z), smooth(0.645, 0.665, y) * smooth(0.705, 0.685, y));
      // Golden lines down the pleats at the front
      const pleat = z > 0.1 && y < 0.64 ? smooth(0.15, 0.1, Math.abs(x)) * smooth(0.45, 0.9, Math.sin(x * 62)) : 0;
      mixRGB([0.6, 0.012, 0.05], GOLD_RGB, Math.max(buti, hem, pleat), o);
    };
    const sariParts = [
      roundCone([0, 0.66, 0.015], [0, 0.34, 0.08], 0.225, 0.345, 0.08),     // skirt flaring from the waist
      ellipsoid([0, 0.22, 0.12], [0.5, 0.17, 0.4], 0.1),                    // seat
      ...limb([[0, 0.62, 0.2, 0.06], [0, 0.3, 0.42, 0.095], [0, 0.13, 0.72, 0.11]], 0.07), // front pleats
      ...limb([[-0.16, 0.26, 0.22, 0.2], [-0.72, 0.16, 0.5, 0.15], [0.02, 0.13, 0.76, 0.1]], 0.06),
      ...limb([[0.16, 0.26, 0.22, 0.2], [0.72, 0.16, 0.5, 0.15], [-0.02, 0.09, 0.8, 0.1]], 0.06),
      roundCone([0, 0.63, 0.0], [0, 0.72, -0.0], 0.255, 0.215, 0.07),       // waistband
      ...limb([[0.25, 1.42, 0.075, 0.066], [0.14, 1.2, 0.16, 0.08], [-0.05, 0.96, 0.15, 0.085], [-0.22, 0.72, 0.17, 0.085]], 0.06), // pallu across the body
    ];
    const sariGeo = polygonize(sariParts, 0.016, sariColor);
    addMesh(body, sariGeo, MAT.silk, true);

    // Blouse
    const blouseColor = (x, y, z, nx, ny, nz, o) => {
      const c = y < 1.09 ? GOLD_RGB : [0.6, 0.012, 0.05];
      o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
    };
    const blouseGeo = polygonize([
      ellipsoid([0, 1.2, 0.012], [0.298, 0.135, 0.178], 0.08),
    ], 0.015, blouseColor);
    addMesh(body, blouseGeo, MAT.silk, true);

    const bodySDFs = [skinGeo.userData.sdf, sariGeo.userData.sdf, blouseGeo.userData.sdf];

    // Hands. Palms face forward and down, the gesture of giving.
    const giveDir = [0, -0.38, 0.92], giveSide = [1, 0, 0];
    const hands = [
      ...handParts([-0.56, 0.84, 0.46], giveDir, giveSide, 1.04),
      ...handParts([0.56, 0.84, 0.46], giveDir, [-1, 0, 0], 1.04),
      ...handParts([-0.76, 1.7, -0.05], [0, 1, 0.08], [1, 0, 0], 0.95),
      ...handParts([0.76, 1.7, -0.05], [0, 1, 0.08], [-1, 0, 0], 0.95),
    ];
    addMesh(body, polygonize(hands, 0.0085, skinColor), MAT.lakshmiSkin, true);

    // Bangles and armlets
    [-1, 1].forEach((s) => {
      [0.4, 0.37, 0.34].forEach((z, i) => band(body, [s * 0.553, 0.867 + i * 0.01, z], 0.05 + i * 0.002, 0.009, [0, 0.3, 1], i === 1 ? MAT.ruby : MAT.gold));
      band(body, [s * 0.757, 1.63, -0.065], 0.042, 0.008, [0, 1, 0.08]);
      band(body, [s * 0.75, 1.59, -0.07], 0.044, 0.008, [0, 1, 0.08]);
      band(body, [s * 0.4, 1.2, 0.05], 0.066, 0.012, [-s * 0.42, -0.9, 0.1]);
      band(body, [s * 0.5, 1.37, -0.075], 0.058, 0.01, [1, -0.3, 0]);
    });

    // Gold waist belt
    const belt = [];
    for (let i = -8; i <= 8; i++) {
      const x = (i / 8) * 0.235;
      const y = 0.745 + 0.02 * (i / 8) * (i / 8);
      belt.push([x, y, frontZ(x, y, bodySDFs) + 0.003]);
    }
    tube(body, belt, 0.016, MAT.gold);
    gem(body, 0, 0.745, frontZ(0, 0.745, bodySDFs) + 0.012, 0.03, MAT.ruby);

    // Sari edge and pallu trim
    tube(body, [[0.34, 1.42, 0.075], [0.23, 1.2, 0.2], [0.05, 0.96, 0.22], [-0.13, 0.73, 0.24]], 0.012, MAT.gold);
    tube(body, [[0.16, 1.44, 0.11], [0.04, 1.19, 0.24], [-0.14, 0.95, 0.22], [-0.31, 0.72, 0.23]], 0.012, MAT.gold);

    // Layered necklaces
    const drape = (depth, n, width, top, offset) => {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * 2 - 1;
        const x = t * width;
        const y = top - depth * (1 - t * t);
        pts.push([x, y, frontZ(x, y, bodySDFs) + offset]);
      }
      return pts;
    };
    tube(body, drape(0.075, 20, 0.11, 1.5, 0.004), 0.013, MAT.gold);
    beads(body, drape(0.13, 26, 0.15, 1.5, 0.008), 0.0125, MAT.pearl);
    beads(body, drape(0.21, 26, 0.18, 1.5, 0.008), 0.0135, MAT.gold);
    gem(body, 0, 1.285, frontZ(0, 1.285, bodySDFs) + 0.012, 0.03, MAT.ruby);
    garland(body, drape(0.5, 26, 0.25, 1.47, 0.02), 38, 0.03);

    /* Head on its own group for a soft, graceful sway */
    const head = new THREE.Group();
    head.position.set(0, 1.55, 0.01);
    body.add(head);
    const faceParts = [
      ellipsoid([0, 0.2, 0.0], [0.175, 0.21, 0.185], 0.06),       // skull
      ellipsoid([0, 0.08, 0.035], [0.13, 0.135, 0.14], 0.075),    // cheeks and jaw
      ellipsoid([0, -0.015, 0.075], [0.058, 0.05, 0.065], 0.06),  // chin
      roundCone([0, 0.16, 0.175], [0, 0.085, 0.2], 0.012, 0.018, 0.022), // nose bridge
      ellipsoid([0, 0.08, 0.205], [0.024, 0.013, 0.016], 0.012),  // nose tip
      roundCone([0, -0.1, -0.03], [0, 0.04, -0.01], 0.075, 0.075, 0.04), // neck join
    ];
    const faceGeo = polygonize(faceParts, 0.0085, skinColor);
    addMesh(head, faceGeo, MAT.lakshmiSkin, true);
    const faceSDF = [faceGeo.userData.sdf];

    faceEye(head, faceSDF, 0.08, 0.145, 0.047, 0.0195, 0.08, 0.05, 0.0034);

    // Lips: gentle smile
    const lipUpper = [[-0.04, 0.041], [-0.016, 0.036], [0, 0.032], [0.016, 0.036], [0.04, 0.041]].map((p) => [p[0], p[1], frontZ(p[0], p[1], faceSDF) + 0.001]);
    const lipLower = [[-0.04, 0.041], [-0.016, 0.024], [0, 0.02], [0.016, 0.024], [0.04, 0.041]].map((p) => [p[0], p[1], frontZ(p[0], p[1], faceSDF) + 0.0015]);
    tube(head, lipUpper, 0.0048, MAT.sindoor);
    tube(head, lipLower, 0.0058, MAT.sindoor);

    // Bindi, nose ring and maang tikka
    gem(head, 0, 0.215, frontZ(0, 0.215, faceSDF) + 0.003, 0.012, MAT.ruby);
    const tikkaTop = frontZ(0, 0.3, faceSDF);
    beads(head, sampleCurve([[0, 0.35, tikkaTop + 0.003], [0, 0.32, tikkaTop + 0.012], [0, 0.285, frontZ(0, 0.285, faceSDF) + 0.006]], 7), 0.0055, MAT.pearl);
    gem(head, 0, 0.272, frontZ(0, 0.272, faceSDF) + 0.006, 0.016, MAT.emerald);
    band(head, [0.031, 0.067, frontZ(0.03, 0.08, faceSDF) - 0.006], 0.018, 0.0028, [1, 0, 0.3]);

    // Hair, parted at the centre and flowing down her back
    const hairParts = [
      ellipsoid([0, 0.235, -0.025], [0.188, 0.205, 0.183], 0.04),
      ellipsoid([0, 0.1, -0.1], [0.172, 0.19, 0.11], 0.06),
      ...limb([[-0.09, 0.12, -0.13, 0.09], [-0.15, -0.26, -0.15, 0.1], [-0.13, -0.55, -0.18, 0.06]], 0.06),
      ...limb([[0.09, 0.12, -0.13, 0.09], [0.15, -0.26, -0.15, 0.1], [0.13, -0.55, -0.18, 0.06]], 0.06),
      // hair swept from a centre parting across the top of the forehead
      ...limb([[-0.006, 0.325, 0.125, 0.02], [-0.085, 0.292, 0.115, 0.036], [-0.16, 0.225, 0.07, 0.03]], 0.03),
      ...limb([[0.006, 0.325, 0.125, 0.02], [0.085, 0.292, 0.115, 0.036], [0.16, 0.225, 0.07, 0.03]], 0.03),
      // two soft side locks in front of the ears
      ...limb([[-0.17, 0.2, 0.04, 0.03], [-0.175, 0.1, 0.05, 0.016]], 0.025),
      ...limb([[0.17, 0.2, 0.04, 0.03], [0.175, 0.1, 0.05, 0.016]], 0.025),
    ];
    const hairGeo = polygonize(hairParts, 0.013);
    // The hairline is cut by moving the hair back from the forehead.
    const hair = addMesh(head, hairGeo, MAT.hair, true);
    hair.position.z = -0.012;

    // Jhumka earrings
    [-1, 1].forEach((s) => {
      const group = new THREE.Group();
      group.position.set(s * 0.178, 0.08, 0.025);
      head.add(group);
      const dome = addMesh(group, new THREE.LatheGeometry([[0.0005, 0], [0.018, -0.008], [0.036, -0.045], [0.042, -0.06], [0.03, -0.055], [0.0005, -0.04]].map((p) => new THREE.Vector2(p[0], p[1])), 18), MAT.gold);
      dome.position.y = -0.01;
      const pts = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        pts.push([Math.sin(a) * 0.042, -0.078, Math.cos(a) * 0.042]);
      }
      beads(group, pts, 0.0065, MAT.pearl);
      beads(group, [[0, 0.002, 0]], 0.012, MAT.ruby);
      head.userData["ear" + s] = group;
    });

    crown(head, 0, 0.335, -0.018, 0.17, 0.62);

    // Lotuses in the raised hands
    [-1, 1].forEach((s) => {
      const x = s * 0.77;
      tube(body, [[x, 1.66, -0.05], [x, 1.92, -0.05]], 0.0085, MAT.leaf);
      lotus(body, x, 1.9, -0.05, 0.19, 0.15);
    });

    root.userData = { head, coinHand: V3(-0.57, 0.68, 0.64).multiplyScalar(bodyScale).add(V3(0, bodyY, 0)) };
    return root;
  }

  /* ---------------- 7. The temple around them ---------------- */

  const dynamic = { lanterns: [], halos: [], lights: [] };

  function glowCanvas(size, stops) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const x = c.getContext("2d");
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach((s) => g.addColorStop(s[0], s[1]));
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  /* The spinning sun-ray aura behind each idol, drawn entirely in a shader. */
  function buildHalo(x, y, z, r, tint) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uTint: { value: new THREE.Color(tint) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uTime, uPower; uniform vec3 uTint;
        void main(){
          float r = length(vUv), a = atan(vUv.y, vUv.x);
          float rays  = pow(0.5 + 0.5 * sin(a * 24.0 + uTime * 0.25), 3.0);
          float rays2 = pow(0.5 + 0.5 * sin(a * 11.0 - uTime * 0.16 + 1.3), 2.0);
          float falloff = smoothstep(1.0, 0.18, r);
          float glow = pow(falloff, 1.7) * 0.26 + (rays * 0.38 + rays2 * 0.28) * pow(falloff, 1.25) * 0.66;
          float ring  = smoothstep(0.018, 0.0, abs(r - 0.60)) * 0.75;
          float ring2 = smoothstep(0.009, 0.0, abs(r - 0.66)) * 0.5;
          vec3 col = uTint * glow * 0.85 + vec3(1.0, 0.82, 0.48) * (ring + ring2) * 1.9;
          gl_FragColor = vec4(col * uPower, 1.0);
        }`,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), mat);
    m.position.set(x, y, z);
    scene.add(m);
    dynamic.halos.push(mat);
    // A carved gold ring sits in the middle of the glow.
    const ring = addMesh(scene, new THREE.TorusGeometry(r * 0.6, 0.032, 12, 90), MAT.gold);
    ring.position.set(x, y, z + 0.02);
    const pts = [];
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      pts.push([x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, z + 0.05]);
    }
    beads(scene, pts, 0.036, MAT.pearl);
    return m;
  }

  /* A rangoli floor pattern, painted onto a 2D canvas. */
  function rangoliTexture() {
    const S = 1024;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    x.translate(S / 2, S / 2);
    const R = S / 2 - 12;
    const ring = (rad, n, draw) => {
      for (let i = 0; i < n; i++) {
        x.save();
        x.rotate((i / n) * Math.PI * 2);
        x.translate(0, -rad);
        draw(i);
        x.restore();
      }
    };
    const petal = (w, h, color) => {
      x.fillStyle = color;
      x.beginPath();
      x.moveTo(0, h / 2);
      x.quadraticCurveTo(w, 0, 0, -h / 2);
      x.quadraticCurveTo(-w, 0, 0, h / 2);
      x.fill();
    };
    const disc = (r, c2) => { x.fillStyle = c2; x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.fill(); };
    disc(R * 0.995, "#7d0f3f");
    disc(R * 0.93, "#2a0a2c");
    ring(R * 0.965, 72, () => disc(R * 0.016, "#ffe2a0"));
    ring(R * 0.79, 16, (i) => petal(R * 0.14, R * 0.27, i % 2 ? "#ff7a0a" : "#e01e7c"));
    ring(R * 0.79, 16, () => petal(R * 0.055, R * 0.15, "#ffd24a"));
    disc(R * 0.635, "#0c6d66");
    ring(R * 0.61, 48, () => disc(R * 0.012, "#fff2c6"));
    ring(R * 0.47, 12, (i) => petal(R * 0.1, R * 0.23, i % 2 ? "#ffc21c" : "#ff5b2e"));
    ring(R * 0.47, 12, () => petal(R * 0.035, R * 0.12, "#fff5d8"));
    disc(R * 0.33, "#a6125a");
    ring(R * 0.25, 10, () => petal(R * 0.05, R * 0.14, "#ffd24a"));
    disc(R * 0.14, "#fff2c6");
    disc(R * 0.115, "#f27a10");
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  // One tile of the carved wall pattern, repeated across the whole wall.
  function wallTileTexture() {
    const S = 256;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    x.fillStyle = "#330811";
    x.fillRect(0, 0, S, S);
    x.strokeStyle = "#6e3f1b";
    x.lineWidth = 2;
    x.strokeRect(0, 0, S, S);
    x.beginPath();
    x.moveTo(S / 2, 8); x.lineTo(S - 8, S / 2); x.lineTo(S / 2, S - 8); x.lineTo(8, S / 2); x.closePath();
    x.stroke();
    x.translate(S / 2, S / 2);
    for (let i = 0; i < 8; i++) {
      x.rotate(Math.PI / 4);
      x.fillStyle = i % 2 ? "#5e2f17" : "#7a451c";
      x.beginPath();
      x.moveTo(0, -12);
      x.quadraticCurveTo(21, -40, 0, -68);
      x.quadraticCurveTo(-21, -40, 0, -12);
      x.fill();
    }
    x.fillStyle = "#a9722c";
    x.beginPath();
    x.arc(0, 0, 11, 0, Math.PI * 2);
    x.fill();
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.85, 0.85);
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  function buildTemple() {
    // Night sky with a warm glow near the horizon
    const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 20), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vP;
        void main(){
          float h = clamp(normalize(vP).y, -0.1, 1.0);
          vec3 low = vec3(0.17, 0.035, 0.05), mid = vec3(0.045, 0.012, 0.055), top = vec3(0.008, 0.008, 0.03);
          vec3 c = mix(low, mid, smoothstep(0.0, 0.16, h));
          c = mix(c, top, smoothstep(0.12, 0.5, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    scene.add(sky);

    // Polished dark floor
    const fadeCanvas = document.createElement("canvas");
    fadeCanvas.width = 4; fadeCanvas.height = 256;
    const fadeCtx = fadeCanvas.getContext("2d");
    const fade = fadeCtx.createLinearGradient(0, 0, 0, 256);
    fade.addColorStop(0, "#000");
    fade.addColorStop(0.3, "#fff");
    fadeCtx.fillStyle = fade;
    fadeCtx.fillRect(0, 0, 4, 256);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 44), standard({
      color: 0x1c0a0e, metalness: 0.2, roughness: 0.34, envMapIntensity: 0.1,
      alphaMap: new THREE.CanvasTexture(fadeCanvas), transparent: true,
    }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = 7.5;   // the plane runs from z = -14.5 (faded) to z = 29.5
    floor.receiveShadow = true;
    scene.add(floor);

    // Pools of warm lamplight on the floor (cheap, and they sell the glow)
    const poolTex = glowCanvas(256, [[0, "rgba(255,150,60,0.55)"], [0.35, "rgba(255,105,30,0.2)"], [1, "rgba(255,70,15,0)"]]);
    const pool = (x, z, r) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.012, z);
      m.renderOrder = 1;
      scene.add(m);
    };
    pool(0, 2, 3.8);
    pool(-3.62, 1, 2.5);
    pool(3.62, 1, 2.5);

    // Rangoli in front of the idols
    const rangoli = new THREE.Mesh(new THREE.CircleGeometry(1.36, 64), standard({ map: rangoliTexture(), metalness: 0.05, roughness: 0.7, emissive: 0xffffff, emissiveIntensity: 0.1 }));
    rangoli.material.emissiveMap = rangoli.material.map;
    rangoli.rotation.x = -Math.PI / 2;
    rangoli.position.set(0, 0.006, 2.02);
    rangoli.receiveShadow = true;
    scene.add(rangoli);

    /* The arched gateway: outer rectangle with a scalloped opening cut out */
    const AW = 4.3, spring = 3.95, rise = 2.75;
    const outer = new THREE.Shape();
    outer.moveTo(-24, 0); outer.lineTo(24, 0); outer.lineTo(24, 16); outer.lineTo(-24, 16); outer.lineTo(-24, 0);
    const opening = new THREE.Path();
    const archPts = [];
    opening.moveTo(AW, 0);
    opening.lineTo(AW, spring);
    archPts.push(V3(AW, 0.02, 0), V3(AW, spring, 0));
    const steps = 150;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI;
      const lobes = 1 + 0.04 * Math.abs(Math.sin(a * 5.5));
      const pointed = 1 + 0.14 * Math.pow(Math.sin(a), 16);
      const px = AW * Math.cos(a) * lobes;
      const py = spring + rise * Math.sin(a) * lobes * pointed;
      opening.lineTo(px, py);
      archPts.push(V3(px, py, 0));
    }
    opening.lineTo(-AW, 0);
    opening.lineTo(AW, 0);
    archPts.push(V3(-AW, 0.02, 0));
    outer.holes.push(opening);
    const wallTex = wallTileTexture();
    const wallMat = standard({ map: wallTex, metalness: 0.3, roughness: 0.55, emissive: 0xffffff, emissiveMap: wallTex, emissiveIntensity: 0.1 });
    const gate = new THREE.Mesh(new THREE.ExtrudeGeometry(outer, { depth: 0.46, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2, curveSegments: 4 }), wallMat);
    gate.position.set(0, 0, -1.65);
    gate.receiveShadow = true;
    scene.add(gate);
    const washTex = glowCanvas(256, [[0, "rgba(255,120,45,0.14)"], [0.45, "rgba(235,70,30,0.05)"], [1, "rgba(200,30,20,0)"]]);
    [-1, 1].forEach((s) => {
      const wash = new THREE.Mesh(new THREE.PlaneGeometry(6, 7.5), new THREE.MeshBasicMaterial({ map: washTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      wash.position.set(s * 6.1, 2.6, -1.14);
      scene.add(wash);
    });

    // Gold moulding following the opening
    const trim = (z, r, mat) => {
      const pts = archPts.map((p) => p.clone().setZ(z));
      const curve = new THREE.CurvePath();
      for (let i = 0; i < pts.length - 1; i++) curve.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
      const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 360, r, 8, false), mat);
      scene.add(m);
    };
    trim(-1.15, 0.05, MAT.gold);
    trim(-1.28, 0.022, MAT.gold);
    trim(-1.57, 0.035, MAT.goldDull);

    // Pillars either side of the idols
    [-1, 1].forEach((s) => {
      const x = s * 5.1;
      const lathe = (pts, mat) => {
        const m = addMesh(scene, new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), 40), mat);
        m.position.set(x, 0, -1.02);
        return m;
      };
      lathe([[0.0005, 0], [0.56, 0], [0.56, 0.2], [0.42, 0.3], [0.34, 0.44], [0.0005, 0.44]], MAT.goldDull);
      lathe([[0.32, 0.44], [0.3, 1.2], [0.26, 3.3], [0.0005, 3.3]], MAT.maroon);
      lathe([[0.0005, 3.3], [0.27, 3.3], [0.36, 3.42], [0.5, 3.62], [0.56, 3.95], [0.0005, 3.95]], MAT.goldDull);
      [0.7, 1.35, 2.0, 2.65].forEach((y) => {
        const b = addMesh(scene, new THREE.TorusGeometry(0.314 - (y - 0.6) * 0.02, 0.02, 10, 36), MAT.goldDull);
        b.rotation.x = Math.PI / 2;
        b.position.set(x, y, -1.02);
      });
      // Garland wrapped down the inside of the opening
      const wrap = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        wrap.push([s * (AW - 0.06 + Math.sin(t * 34) * 0.05), 3.95 - t * 3.8, -1.1 + Math.cos(t * 34) * 0.05]);
      }
      garland(scene, wrap, 74, 0.062);
    });

    // Swags hanging at the shoulders of the arch
    [-1, 1].forEach((s) => {
      const y1 = 4.75, x1 = 4.05, x2 = 3.05, y2 = 5.55;
      garland(scene, [[s * x1, y1, -1.08], [s * (x1 + x2) * 0.47, 4.25, -1.05], [s * x2, y2, -1.08]], 40, 0.06);
      addMesh(scene, new THREE.ConeGeometry(0.05, 0.25, 10), MAT.gold).position.set(s * (x1 + 0.02), y1 - 0.12, -1.08);
      // Mango leaves on the swag, a classic toran detail
      const leafShape = new THREE.Shape();
      leafShape.moveTo(0, 0);
      leafShape.quadraticCurveTo(0.07, -0.13, 0, -0.33);
      leafShape.quadraticCurveTo(-0.07, -0.13, 0, 0);
      const lg = new THREE.ShapeGeometry(leafShape);
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const lx = s * (x1 - 0.1 - t * (x1 - x2 - 0.2));
        const ly = 4.3 + Math.pow(Math.abs(t - 0.45) * 1.7, 2) * 0.55;
        const l = addMesh(scene, lg, MAT.leaf);
        l.position.set(lx, ly, -1.0);
        l.rotation.z = (t - 0.5) * 0.5;
      }
    });

    // Hanging paper lanterns (akash kandil), lit from the inside
    const lanternGlow = glowCanvas(128, [[0, "rgba(255,190,110,0.95)"], [0.3, "rgba(255,120,40,0.4)"], [1, "rgba(255,80,20,0)"]]);
    [[-3.72, 3.72, -0.75, 0xff5a1f], [3.72, 3.72, -0.75, 0xe81e68]].forEach((L) => {
      const pivot = new THREE.Group();
      pivot.position.set(L[0], 5.5, L[2]);
      scene.add(pivot);
      const dy = L[1] - 5.5;
      tube(pivot, [[0, 0, 0], [0, dy + 0.33, 0]], 0.006, MAT.gold);
      const shade = addMesh(pivot, new THREE.LatheGeometry([[0.1, 0.33], [0.18, 0.27], [0.33, 0.06], [0.34, 0], [0.33, -0.06], [0.18, -0.27], [0.1, -0.33]].map((p) => new THREE.Vector2(p[0], p[1])), 8),
        standard({ color: L[3], emissive: L[3], emissiveIntensity: 0.9, roughness: 0.55, side: THREE.DoubleSide, flatShading: true }));
      shade.position.y = dy;
      [0.33, -0.33].forEach((y) => band(pivot, [0, dy + y, 0], 0.1, 0.012, [0, 1, 0]));
      band(pivot, [0, dy, 0], 0.34, 0.012, [0, 1, 0]);
      const tasselY = dy - 0.33;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        tube(pivot, [[Math.cos(a) * 0.05, tasselY, Math.sin(a) * 0.05], [Math.cos(a) * 0.08, tasselY - 0.32, Math.sin(a) * 0.08]], 0.006, MAT.gold);
      }
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: lanternGlow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.45, color: L[3] }));
      sprite.scale.setScalar(1.8);
      sprite.position.y = dy;
      pivot.add(sprite);
      dynamic.lanterns.push({ pivot, phase: rand(0, 6) });
    });

    return archPts;
  }

  /* A Dhanteras kalash: a brass pot full of coins, with mango leaves and a coconut. */
  function buildKalash(x, y, z, s) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    const profile = [[0.0005, 0], [0.2, 0], [0.22, 0.03], [0.16, 0.08], [0.33, 0.3], [0.38, 0.47], [0.3, 0.68], [0.16, 0.8], [0.14, 0.86], [0.24, 0.94], [0.26, 0.97], [0.15, 0.95], [0.0005, 0.95]];
    addMesh(g, new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), 48), MAT.gold, true);
    [0.47, 0.32, 0.62].forEach((yy, i) => {
      const r = [0.385, 0.325, 0.325][i];
      band(g, [0, yy, 0], r, 0.012, [0, 1, 0], i === 0 ? MAT.ruby : MAT.gold);
    });
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.quadraticCurveTo(0.09, 0.2, 0, 0.5);
    leafShape.quadraticCurveTo(-0.09, 0.2, 0, 0);
    const lg = new THREE.ShapeGeometry(leafShape);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const l = addMesh(g, lg, MAT.leaf);
      l.position.set(Math.sin(a) * 0.15, 0.93, Math.cos(a) * 0.15);
      l.rotation.set(1.1, a, 0, "YXZ");
    }
    const coconut = addMesh(g, new THREE.SphereGeometry(0.17, 24, 18), standard({ color: 0x6b3a18, roughness: 0.8 }));
    coconut.position.y = 1.14;
    coconut.scale.y = 1.2;
    const cloth = addMesh(g, new THREE.ConeGeometry(0.19, 0.2, 24, 1, true), standard({ color: 0xc4102a, roughness: 0.6, side: THREE.DoubleSide }));
    cloth.position.y = 1.03;
    cloth.rotation.x = Math.PI;
    scene.add(g);
    return g;
  }

  /* ---------------- 8. Diyas and flames ---------------- */

  const flameSpots = []; // {x, y, z, size, order}

  // Clay diya with the little pinched spout that holds the wick
  const diyaGeo = (function () {
    const g = new THREE.LatheGeometry([[0.0005, 0], [0.09, 0], [0.13, 0.03], [0.19, 0.075], [0.215, 0.11], [0.2, 0.112], [0.16, 0.075], [0.0005, 0.06]].map((p) => new THREE.Vector2(p[0], p[1])), 36);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
      const a = Math.atan2(z, x);
      const pinch = Math.pow(Math.max(Math.cos(a), 0), 14) * clamp(y / 0.11, 0, 1);
      p.setX(i, x * (1 + 0.5 * pinch));
      p.setZ(i, z * (1 - 0.08 * pinch));
      p.setY(i, y + pinch * 0.012);
    }
    g.computeVertexNormals();
    return g;
  })();
  const oilGeo = new THREE.CircleGeometry(0.165, 24).rotateX(-Math.PI / 2);

  function placeDiyas(list) {
    const bowls = new THREE.InstancedMesh(diyaGeo, standard({ color: 0xffffff, metalness: 0.02, roughness: 0.72 }), list.length);
    const oils = new THREE.InstancedMesh(oilGeo, MAT.oil, list.length);
    const rimPts = [];
    const d = new THREE.Object3D();
    const paint = [0xc25a2c, 0xa8461f, 0xd27030].map((c) => new THREE.Color(c));
    list.forEach((D, i) => {
      d.position.set(D.x, D.y || 0, D.z);
      d.rotation.y = D.yaw;
      d.scale.setScalar(D.s);
      d.updateMatrix();
      bowls.setMatrixAt(i, d.matrix);
      bowls.setColorAt(i, paint[i % 3]);
      d.position.y = (D.y || 0) + 0.085 * D.s;
      d.updateMatrix();
      oils.setMatrixAt(i, d.matrix);
      // The wick sits on the spout, in the direction the diya is turned.
      const wickX = D.x + Math.cos(D.yaw) * 0.25 * D.s;
      const wickZ = D.z - Math.sin(D.yaw) * 0.25 * D.s;
      flameSpots.push({ x: wickX, y: (D.y || 0) + 0.135 * D.s, z: wickZ, size: 0.165 * Math.min(D.s, 1.55) * rand(0.92, 1.08), order: D.order });
      rimPts.push([wickX, (D.y || 0) + 0.12 * D.s, wickZ]);
    });
    bowls.castShadow = true;
    scene.add(bowls, oils);
    // Small cotton wick at each spout
    beads(scene, rimPts, 0.016, standard({ color: 0x281006, roughness: 1 }));
  }

  // A tall brass standing lamp (samai) with five flames
  function buildSamai(x, z) {
    const profile = [[0.0005, 0], [0.42, 0], [0.43, 0.04], [0.32, 0.09], [0.14, 0.15], [0.06, 0.28], [0.04, 0.55], [0.1, 0.63], [0.04, 0.72], [0.035, 1.2], [0.09, 1.28], [0.035, 1.37], [0.04, 1.58], [0.34, 1.68], [0.47, 1.76], [0.47, 1.79], [0.34, 1.73], [0.06, 1.71], [0.05, 1.85], [0.11, 1.93], [0.03, 2.08], [0.08, 2.14], [0.0005, 2.25]];
    const m = addMesh(scene, new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), 36), MAT.gold, true);
    m.position.set(x, 0, z);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
      flameSpots.push({ x: x + Math.cos(a) * 0.43, y: 1.8, z: z + Math.sin(a) * 0.43, size: 0.2 * rand(0.94, 1.06), order: 0.25 + i * 0.02 });
    }
    const buds = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
      buds.push([x + Math.cos(a) * 0.43, 1.79, z + Math.sin(a) * 0.43]);
    }
    beads(scene, buds, 0.022, standard({ color: 0x281006, roughness: 1 }));
  }

  /* All flames are one mesh: each flame is a four-corner quad that always faces
     the camera, and the shader paints the teardrop, flicker and glow. */
  const FLAME_VS = `
    attribute vec3 aCenter; attribute vec2 aCorner; attribute float aSize; attribute float aPhase; attribute float aLit;
    uniform float uTime; uniform float uMirror;
    varying vec2 vP; varying float vPhase; varying float vLit;
    void main(){
      vec3 c = aCenter;
      float breathe = 1.0 + 0.09 * sin(uTime * 7.3 + aPhase) + 0.05 * sin(uTime * 13.1 + aPhase * 2.1);
      float s = aSize * mix(0.2, breathe, aLit);
      c.y *= uMirror;
      vec4 mv = viewMatrix * vec4(c, 1.0);
      mv.xy += vec2(aCorner.x, aCorner.y * uMirror) * s;
      vP = aCorner; vPhase = aPhase; vLit = aLit;
      gl_Position = projectionMatrix * mv;
    }`;
  const FLAME_FS = `
    precision highp float;
    varying vec2 vP; varying float vPhase; varying float vLit;
    uniform float uTime; uniform float uDim;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    void main(){
      if (vLit < 0.003) discard;
      float t = uTime;
      float y = vP.y * 0.82 + 0.26;           // 0 at the wick, 1 at the tip
      float yc = clamp(y, 0.0, 1.0);
      // Sideways licks get stronger towards the tip, which is what makes it look alive.
      float lick = (noise(vec2(yc * 2.4 - t * 2.6, vPhase)) - 0.5) * 0.3
                 + (noise(vec2(yc * 5.5 - t * 5.2, vPhase + 9.0)) - 0.5) * 0.11;
      float x = vP.x - lick * yc * yc * 0.95;
      float width = 0.235 * pow(sin(3.14159 * pow(yc, 0.5)), 0.9) + 0.004;
      float d = abs(x) / width;
      float body = smoothstep(1.0, 0.62, d) * step(0.0, y) * step(y, 1.0);
      // From the outside in: deep orange, gold, then a white-hot heart.
      vec3 col = mix(vec3(1.0, 0.11, 0.005), vec3(1.0, 0.42, 0.02), smoothstep(1.0, 0.5, d));
      float hot = smoothstep(0.5, 0.04, d) * smoothstep(0.72, 0.2, yc);
      col = mix(col, vec3(1.0, 0.74, 0.26) * 1.9, hot);
      // A faint blue base right at the wick
      float blue = smoothstep(0.17, 0.02, yc);
      col = mix(col, vec3(0.1, 0.2, 1.0), blue * 0.45);
      float alpha = body * (1.0 - blue * 0.45) * smoothstep(1.0, 0.8, yc);
      // Soft halo of light in the air around the flame
      float r = length(vec2(vP.x, (vP.y - 0.1) * 0.85));
      float halo = pow(max(1.0 - r, 0.0), 2.8) * (0.72 + 0.28 * noise(vec2(t * 3.4, vPhase)));
      vec3 out_ = col * alpha * 1.12 + vec3(1.0, 0.3, 0.04) * halo * 0.34;
      gl_FragColor = vec4(out_ * vLit * uDim, 1.0);
    }`;

  let flameLit = null;
  const flameUniforms = { uTime: { value: 0 } };

  function buildFlames() {
    const n = flameSpots.length;
    const center = new Float32Array(n * 12), corner = new Float32Array(n * 8), size = new Float32Array(n * 4), phase = new Float32Array(n * 4), lit = new Float32Array(n * 4);
    const index = [];
    const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    flameSpots.forEach((f, i) => {
      const ph = rand(0, 50);
      // The quad is taller than the flame: the extra room holds the soft halo.
      const offsetY = f.size * 0.66;
      for (let v = 0; v < 4; v++) {
        center.set([f.x, f.y + offsetY, f.z], (i * 4 + v) * 3);
        corner.set(quad[v], (i * 4 + v) * 2);
        size[i * 4 + v] = f.size * 2.1;
        phase[i * 4 + v] = ph;
      }
      const b = i * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(center.slice(), 3));
    geo.setAttribute("aCenter", new THREE.BufferAttribute(center, 3));
    geo.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    flameLit = new THREE.BufferAttribute(lit, 1);
    flameLit.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aLit", flameLit);
    geo.setIndex(index);

    const makeMat = (mirror, dim) => new THREE.ShaderMaterial({
      vertexShader: FLAME_VS,
      fragmentShader: FLAME_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: flameUniforms.uTime, uMirror: { value: mirror }, uDim: { value: dim } },
    });
    const flames = new THREE.Mesh(geo, makeMat(1, 1));
    flames.frustumCulled = false;
    flames.renderOrder = 5;
    scene.add(flames);
    // The same flames, flipped below the floor and dimmed, read as reflections in polished stone.
    const reflections = new THREE.Mesh(geo, makeMat(-1, 0.17));
    reflections.frustumCulled = false;
    reflections.material.depthTest = false;
    reflections.renderOrder = 1;
    scene.add(reflections);
  }

  /* ---------------- 9. Particles: twinkle lights, embers, coins, petals, fireworks ---------------- */

  const softPointFS = `
    varying vec3 vColor; varying float vAlpha;
    void main(){
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float a = pow(max(1.0 - d, 0.0), 2.0);
      gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
    }`;

  function pointMaterial(vertexShader, uniforms) {
    return new THREE.ShaderMaterial({ vertexShader, fragmentShader: softPointFS, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  const pixelScale = { value: renderer.getPixelRatio() * innerHeight * 0.5 };

  // Fairy lights along the arch: a chase of brightness runs up both sides.
  let twinkleMat;
  function buildTwinkles(archPts) {
    const curve = new THREE.CurvePath();
    for (let i = 0; i < archPts.length - 1; i++) curve.add(new THREE.LineCurve3(archPts[i], archPts[i + 1]));
    const N = 150;
    const pos = new Float32Array(N * 3), seq = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = curve.getPointAt(i / (N - 1));
      pos.set([p.x * 0.988, p.y * 0.992, -1.1], i * 3);
      seq[i] = Math.abs(i / (N - 1) - 0.5) * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeq", new THREE.BufferAttribute(seq, 1));
    twinkleMat = pointMaterial(`
      attribute float aSeq; uniform float uTime, uScale, uPower;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        float wave = 0.5 + 0.5 * sin(aSeq * 26.0 + uTime * 2.6);
        vAlpha = (0.32 + 1.5 * pow(wave, 4.0)) * uPower;
        vColor = mix(vec3(1.0, 0.56, 0.17), vec3(1.0, 0.9, 0.62), wave);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uScale * 0.095 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`, { uTime: { value: 0 }, uScale: pixelScale, uPower: { value: 0 } });
    const pts = new THREE.Points(g, twinkleMat);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  // Stars and a far-off town full of lamps
  function buildBackdrop() {
    const N = 460, N2 = 120, total = N + N2;
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), size = new Float32Array(total), ph = new Float32Array(total);
    for (let i = 0; i < N; i++) {
      const a = rand(-1.5, 1.5), e = rand(0.08, 0.95), R = 80;
      pos.set([Math.sin(a) * Math.cos(e) * R, Math.sin(e) * R, -Math.cos(a) * Math.cos(e) * R], i * 3);
      const warm = rand(0, 1);
      col.set([0.8 + warm * 0.2, 0.8, 1 - warm * 0.3], i * 3);
      size[i] = rand(0.14, 0.42);
      ph[i] = rand(0, 7);
    }
    for (let i = N; i < total; i++) {
      pos.set([rand(-48, 48), rand(0.15, 1.7), rand(-44, -22)], i * 3);
      col.set(Math.random() < 0.8 ? [1, 0.58, 0.17] : [1, 0.25, 0.42], i * 3);
      size[i] = rand(0.14, 0.34);
      ph[i] = rand(0, 7);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
    const mat = pointMaterial(`
      attribute vec3 aColor; attribute float aSize, aPhase; uniform float uTime, uScale;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vColor = aColor;
        vAlpha = 0.5 + 0.5 * sin(uTime * 1.6 + aPhase);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(uScale * aSize / -mv.z, 1.5);
        gl_Position = projectionMatrix * mv;
      }`, { uTime: flameUniforms.uTime, uScale: pixelScale });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  // Embers drifting upwards from the lamps
  let emberState;
  function buildEmbers() {
    const N = isSmall ? 70 : 150;
    const pos = new Float32Array(N * 3), size = new Float32Array(N), life = new Float32Array(N);
    const data = [];
    for (let i = 0; i < N; i++) { data.push({ life: rand(0, 1), speed: rand(0.04, 0.12), sway: rand(0, 6) }); size[i] = rand(0.016, 0.042); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aLife", new THREE.BufferAttribute(life, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = pointMaterial(`
      attribute float aSize, aLife; uniform float uScale, uPower;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vColor = mix(vec3(1.0, 0.68, 0.27), vec3(1.0, 0.25, 0.05), aLife);
        vAlpha = sin(aLife * 3.14159) * 1.25 * uPower;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uScale * aSize / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`, { uScale: pixelScale, uPower: { value: 0 } });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    emberState = { N, g, data, mat };
    for (let i = 0; i < N; i++) {
      const s = flameSpots[i % flameSpots.length];
      data[i].x = s.x; data[i].y = s.y; data[i].z = s.z; data[i].src = s;
    }
  }
  function updateEmbers(t, dt) {
    if (!emberState) return;
    const p = emberState.g.attributes.position, l = emberState.g.attributes.aLife;
    emberState.data.forEach((e, i) => {
      e.life += dt * e.speed;
      if (e.life > 1) {
        e.life = 0;
        e.x = e.src.x + rand(-0.06, 0.06);
        e.y = e.src.y + 0.1;
        e.z = e.src.z + rand(-0.06, 0.06);
      }
      e.y += dt * (0.3 + e.speed * 3);
      e.x += Math.sin(t * 1.3 + e.sway + e.y * 1.2) * dt * 0.1;
      p.setXYZ(i, e.x, e.y, e.z);
      l.setX(i, e.life);
    });
    p.needsUpdate = true;
    l.needsUpdate = true;
  }

  /* Gold coins: Dhanteras is the day for welcoming wealth home. */
  let coinMesh, coins;
  const coinPool = 260;
  const coinDummy = new THREE.Object3D();
  function buildCoins() {
    const g = new THREE.CylinderGeometry(0.052, 0.052, 0.01, 18);
    coinMesh = new THREE.InstancedMesh(g, standard({ color: 0xffc94f, metalness: 1, roughness: 0.2, envMapIntensity: 1.5, emissive: 0x4a2b02, emissiveIntensity: 0.3 }), coinPool);
    coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    coinMesh.frustumCulled = false;
    coins = [];
    for (let i = 0; i < coinPool; i++) coins.push({ alive: false, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, spin: 0 });
    scene.add(coinMesh);

    // A resting heap of coins in front of the kalash
    const heap = new THREE.InstancedMesh(g, coinMesh.material, 95);
    const d = new THREE.Object3D();
    const spots = [[0, 0.86, 0.34], [-0.76, 0.5, 0.24], [0.76, 0.5, 0.24]];
    for (let i = 0; i < 95; i++) {
      const s = spots[i % 3];
      const a = rand(0, 6.28), r = Math.pow(Math.random(), 0.65) * s[2];
      const x = s[0] + Math.sin(a) * r, z = s[1] + Math.cos(a) * r * 0.65;
      d.position.set(x, 0.012 + (1 - r / s[2]) * rand(0, 0.12), z);
      d.rotation.set(rand(-0.3, 0.3), rand(0, 6), rand(-0.3, 0.3));
      d.updateMatrix();
      heap.setMatrixAt(i, d.matrix);
    }
    scene.add(heap);
  }
  function emitCoin(x, y, z, vx, vy, vz) {
    const c = coins.find((q) => !q.alive);
    if (!c) return;
    Object.assign(c, { alive: true, life: 0, x, y, z, vx, vy, vz, rx: rand(0, 6), rz: rand(0, 6), spin: rand(2, 8), bounced: false });
  }
  function updateCoins(dt) {
    coins.forEach((c, i) => {
      let scale = 0;
      if (c.alive) {
        c.life += dt;
        c.vy -= 3.1 * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
        c.rx += c.spin * dt; c.rz += c.spin * 0.6 * dt;
        if (c.y < 0.03) {
          c.y = 0.03;
          if (!c.bounced && Math.abs(c.vy) > 0.5) {
            c.vy = -c.vy * 0.3; c.vx *= 0.5; c.vz *= 0.5; c.bounced = true;
          } else {
            c.vy = 0; c.vx = 0; c.vz = 0; c.spin = 0; c.rx = 0; c.rz = 0;
          }
        }
        if (c.life > 4.6) c.alive = false;
        scale = c.life > 4.0 ? (4.6 - c.life) / 0.6 : 1;
      }
      coinDummy.position.set(c.x, c.y, c.z);
      coinDummy.rotation.set(c.rx, 0, c.rz);
      coinDummy.scale.setScalar(Math.max(scale, 0.0001));
      coinDummy.updateMatrix();
      coinMesh.setMatrixAt(i, coinDummy.matrix);
    });
    coinMesh.instanceMatrix.needsUpdate = true;
  }

  // Rose petals drifting down
  let petalMesh, petals;
  function buildPetals() {
    const N = isSmall ? 50 : 90;
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.05);
    shape.bezierCurveTo(0.05, -0.02, 0.045, 0.04, 0, 0.055);
    shape.bezierCurveTo(-0.045, 0.04, -0.05, -0.02, 0, -0.05);
    petalMesh = new THREE.InstancedMesh(new THREE.ShapeGeometry(shape, 4), standard({ color: 0xffffff, roughness: 0.55, side: THREE.DoubleSide, emissive: 0x500512, emissiveIntensity: 0.5 }), N);
    petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    petalMesh.frustumCulled = false;
    const tints = [0xff2a55, 0xff6a1a, 0xffa412, 0xe81577].map((c) => new THREE.Color(c));
    petals = [];
    for (let i = 0; i < N; i++) {
      petals.push({ x: rand(-5.6, 5.6), y: rand(0, 7), z: rand(-0.8, 4), fall: rand(0.16, 0.34), sway: rand(0, 6), spin: rand(0.5, 1.7), s: rand(0.8, 1.35) });
      petalMesh.setColorAt(i, tints[i % 4]);
    }
    scene.add(petalMesh);
  }
  function updatePetals(t, dt, boost) {
    petals.forEach((p, i) => {
      p.y -= dt * p.fall * (1 + boost * 3.5);
      if (p.y < 0.03) { p.y = rand(5.5, 7.5); p.x = rand(-5.6, 5.6); p.z = rand(-0.8, 4); }
      coinDummy.position.set(p.x + Math.sin(t * 0.8 + p.sway) * 0.3, p.y, p.z);
      coinDummy.rotation.set(t * p.spin + p.sway, t * p.spin * 0.7, p.sway);
      coinDummy.scale.setScalar(p.s);
      coinDummy.updateMatrix();
      petalMesh.setMatrixAt(i, coinDummy.matrix);
    });
    petalMesh.instanceMatrix.needsUpdate = true;
  }

  /* Fireworks: a pool of particles that is shared and reused between bursts. */
  const FW = { N: isSmall ? 800 : 1800, cursor: 0, next: 1.6 };
  function buildFireworks() {
    const N = FW.N;
    FW.pos = new Float32Array(N * 3);
    FW.col = new Float32Array(N * 3);
    FW.alpha = new Float32Array(N);
    FW.vel = new Float32Array(N * 3);
    FW.life = new Float32Array(N);
    FW.decay = new Float32Array(N);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(FW.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aColor", new THREE.BufferAttribute(FW.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(FW.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = pointMaterial(`
      attribute vec3 aColor; attribute float aAlpha; uniform float uScale;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vColor = aColor; vAlpha = aAlpha * 1.15;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(uScale * 0.3 / -mv.z, 1.5);
        gl_Position = projectionMatrix * mv;
      }`, { uScale: pixelScale });
    FW.points = new THREE.Points(g, mat);
    FW.points.frustumCulled = false;
    scene.add(FW.points);
  }
  const FW_COLORS = [[1, 0.6, 0.12], [1, 0.14, 0.3], [0.42, 0.28, 1], [0.1, 0.85, 0.6], [1, 0.3, 0.06], [1, 0.8, 0.42]];
  function burst(x, y, z, count, speed) {
    const c = FW_COLORS[Math.floor(Math.random() * FW_COLORS.length)];
    const c2 = FW_COLORS[Math.floor(Math.random() * FW_COLORS.length)];
    for (let i = 0; i < count; i++) {
      const k = FW.cursor;
      FW.cursor = (FW.cursor + 1) % FW.N;
      const u = rand(-1, 1), a = rand(0, 6.283), s = Math.sqrt(1 - u * u);
      // Most sparks ride near the shell's edge, which gives a crisp peony shape.
      const sp = speed * (Math.random() < 0.72 ? rand(0.86, 1.04) : rand(0.25, 0.75));
      FW.pos.set([x, y, z], k * 3);
      FW.vel.set([s * Math.cos(a) * sp, u * sp, s * Math.sin(a) * sp], k * 3);
      const mix = i % 3 === 0 ? c2 : c;
      FW.col.set(mix, k * 3);
      FW.life[k] = 1;
      FW.decay[k] = rand(0.3, 0.5);
    }
  }
  function launchFirework() {
    const side = Math.random() < 0.5 ? -1 : 1;
    burst(side * rand(3.5, 9.5), rand(6, 12), rand(-28, -22), isSmall ? 70 : 150, rand(3.2, 5));
  }
  function updateFireworks(dt) {
    FW.next -= dt;
    if (FW.next < 0) {
      launchFirework();
      FW.next = reducedMotion ? rand(5, 8) : rand(1.1, 2.9);
    }
    const drag = Math.pow(0.32, dt);
    for (let i = 0; i < FW.N; i++) {
      if (FW.life[i] <= 0) { FW.alpha[i] = 0; continue; }
      const j = i * 3;
      FW.life[i] -= dt * FW.decay[i];
      FW.vel[j] *= drag; FW.vel[j + 1] = FW.vel[j + 1] * drag - dt * 0.7; FW.vel[j + 2] *= drag;
      FW.pos[j] += FW.vel[j] * dt; FW.pos[j + 1] += FW.vel[j + 1] * dt; FW.pos[j + 2] += FW.vel[j + 2] * dt;
      const l = Math.max(FW.life[i], 0);
      FW.alpha[i] = l * l * (0.85 + 0.15 * Math.sin(i + l * 40));
    }
    const a = FW.points.geometry.attributes;
    a.position.needsUpdate = a.aColor.needsUpdate = a.aAlpha.needsUpdate = true;
  }

  /* ---------------- 10. Lights ---------------- */

  const LIGHT = {};
  function buildLights() {
    scene.add(new THREE.HemisphereLight(0xffcfa0, 0x2a0a10, 0.42));

    const keyAt = (x, target, power) => {
      const spot = new THREE.SpotLight(0xffe0b5, power, 18, 0.34, 0.8, 1.6);
      spot.position.set(x, 6.4, 6.6);
      spot.target.position.set(target, 1.5, 0);
      scene.add(spot, spot.target);
      return spot;
    };
    LIGHT.keyG = keyAt(-2.7, -2.0, 0);
    LIGHT.keyL = keyAt(2.7, 2.0, 0);
    LIGHT.keyG.castShadow = true;
    LIGHT.keyG.shadow.mapSize.set(1024, 1024);
    LIGHT.keyG.shadow.bias = -0.0006;
    LIGHT.keyL.castShadow = !isSmall;
    LIGHT.keyL.shadow.mapSize.set(1024, 1024);
    LIGHT.keyL.shadow.bias = -0.0006;

    // Rim lights from behind separate the gold from the dark background.
    const rim = (color, x, y, z, power) => {
      const d = new THREE.DirectionalLight(color, power);
      d.position.set(x, y, z);
      scene.add(d);
      return d;
    };
    LIGHT.rimA = rim(0xff7a3a, -7, 5, -6, 0);
    LIGHT.rimB = rim(0xff5a9c, 7, 5, -6, 0);

    // These flicker with the flames. Everything else is faked with additive glow.
    const flicker = (x, y, z, power, range) => {
      const p = new THREE.PointLight(0xff9a48, 0, range, 1.8);
      p.position.set(x, y, z);
      scene.add(p);
      dynamic.lights.push({ light: p, base: power, phase: rand(0, 50) });
      return p;
    };
    flicker(0, 0.75, 2.02, 7, 8);
    flicker(-3.62, 2.1, 0.95, 5, 8);
    flicker(3.62, 2.1, 0.95, 5, 8);
  }

  /* ---------------- 11. Post-processing ---------------- */

  const rtSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const composer = new THREE.EffectComposer(renderer, new THREE.WebGLRenderTarget(rtSize.x, rtSize.y, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new THREE.RenderPass(scene, camera));
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.6, 1.05);
  const setBloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => setBloomSize(w * 0.6, h * 0.6);
  composer.addPass(bloom);
  // Final grade: filmic tone mapping, vignette and a touch of warmth.
  const gradePass = new THREE.ShaderPass({
    uniforms: { tDiffuse: { value: null }, uExposure: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uExposure;
      vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
        c = aces(c);
        c = pow(c, vec3(1.0 / 2.2));
        vec2 q = vUv - 0.5;
        c *= 1.0 - dot(q, q) * 0.7;
        c = mix(c, c * vec3(1.03, 1.0, 0.95), 0.6);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  composer.addPass(gradePass);

  /* ---------------- 12. Camera framing and input ---------------- */

  const view = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0, dist: 11, lookY: 1.9, dragging: false };

  function frame() {
    const aspect = innerWidth / innerHeight;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    // Keep the idols and lamps visible on wide and on tall screens.
    const fitWidth = (aspect > 1.2 ? 4.9 : 4.2) / (Math.tan(halfFov) * aspect);
    const fitHeight = 3.25 / Math.tan(halfFov);
    view.dist = Math.max(fitWidth, fitHeight) + 2;
    view.lookY = aspect > 1.2 ? 2.35 : 1.5;
    view.camRise = aspect > 1.2 ? 0.85 : 4.6; // portrait screens look down more, to show the rangoli
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(innerWidth, innerHeight);
    pixelScale.value = renderer.getPixelRatio() * innerHeight * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    frame();
  }
  addEventListener("resize", resize);

  let lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (e) => { view.dragging = true; lastX = e.clientX; lastY = e.clientY; });
  const endDrag = () => { view.dragging = false; view.targetPitch = 0; };
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
  addEventListener("pointermove", (e) => {
    if (view.dragging) {
      view.targetYaw = clamp(view.targetYaw - (e.clientX - lastX) * 0.004, -0.62, 0.62);
      view.targetPitch = clamp(view.targetPitch + (e.clientY - lastY) * 0.002, -0.08, 0.2);
      lastX = e.clientX; lastY = e.clientY;
    } else if (e.pointerType === "mouse" && !reducedMotion) {
      // Gentle parallax that follows the mouse
      view.targetYaw = ((e.clientX / innerWidth) - 0.5) * -0.16;
      view.targetPitch = ((e.clientY / innerHeight) - 0.5) * 0.04;
    }
  });

  /* ---------------- 13. Buttons ---------------- */

  let blessBoost = 0, lakshmi;
  let audioCtx = null;

  // A temple bell made with WebAudio: a few sine waves that fade slowly.
  function ringBell() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const now = audioCtx.currentTime;
      const master = audioCtx.createGain();
      master.gain.value = 0.16;
      master.connect(audioCtx.destination);
      [[523, 1, 3.4], [1047, 0.6, 2.6], [1579, 0.32, 1.9], [2343, 0.2, 1.2], [3148, 0.1, 0.8]].forEach((p) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = p[0];
        g.gain.setValueAtTime(p[1], now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + p[2]);
        o.connect(g).connect(master);
        o.start(now);
        o.stop(now + p[2] + 0.05);
      });
    } catch (err) { /* Sound is a bonus. The visuals still work without it. */ }
  }

  const blessBtn = document.getElementById("blessBtn");
  const shareBtn = document.getElementById("shareBtn");
  const toastEl = document.getElementById("toast");

  blessBtn.addEventListener("click", () => {
    blessBoost = 1;
    ringBell();
    for (let i = 0; i < 110; i++) {
      setTimeout(() => emitCoin(rand(-4, 4), rand(5.2, 6.5), rand(-0.3, 3), rand(-0.35, 0.35), rand(-0.8, 0), rand(-0.2, 0.2)), i * 24);
    }
    burst(-7, 8.5, -24, 170, 6);
    setTimeout(() => burst(7, 9.5, -24, 170, 6), 350);
    setTimeout(() => burst(0, 11.5, -26, 200, 7), 750);
  });

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  shareBtn.addEventListener("click", async () => {
    const text = "Happy Diwali & Happy Dhanteras! Wishing you light, joy and prosperity, from Naya Prayog.";
    const url = location.protocol.startsWith("http") ? location.href : "";
    try {
      if (navigator.share) {
        await navigator.share(url ? { title: "Happy Diwali & Dhanteras", text, url } : { title: "Happy Diwali & Dhanteras", text });
      } else {
        await navigator.clipboard.writeText(url ? text + " " + url : text);
        toast("Wish copied. Paste it to share!");
      }
    } catch (err) {
      if (err && err.name !== "AbortError") toast("Sharing isn't available in this browser");
    }
  });

  /* ---------------- 14. Build everything, then run ---------------- */

  let ganesha;

  const buildStart = performance.now();
  async function build() {
    frame();
    await nextFrame();
    const archPts = buildTemple();

    ganesha = buildGanesha();
    ganesha.position.set(-2.02, 0, 0);
    ganesha.rotation.y = 0.1;
    scene.add(ganesha);
    await nextFrame();

    lakshmi = buildLakshmi();
    lakshmi.position.set(2.02, 0, 0);
    lakshmi.rotation.y = -0.1;
    scene.add(lakshmi);
    await nextFrame();

    buildHalo(-2.02, 2.22, -0.92, 2.75, 0xffab3a);
    buildHalo(2.02, 2.42, -0.92, 2.75, 0xff8a58);

    // A kalash stands between the idols, on a small plinth of coins.
    buildKalash(0, 0, 0.3, 1.2);

    // Diyas: an arc around the rangoli, then a row running back along each side.
    const diyaList = [];
    const cx = 0, cz = 2.02, n = 17;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / n;
      const x = cx + Math.sin(a) * 1.58, z = cz + Math.cos(a) * 1.28;
      // Turn each spout outwards so the flames ring the pattern.
      diyaList.push({ x, z, s: 0.98, yaw: -Math.atan2(z - cz, x - cx), order: 0.08 + Math.abs(Math.sin(a / 2)) * 0.4 + (1 - Math.abs(Math.cos(a))) * 0.12 });
    }
    [-1, 1].forEach((s) => {
      for (let i = 0; i < 4; i++) {
        const z = 2.72 - i * 0.92;
        diyaList.push({ x: s * (3.3 + i * 0.08), z, s: 1.0, yaw: s < 0 ? 0 : Math.PI, order: 0.55 + i * 0.07 });
      }
    });
    // A larger centre diya that everything else seems to catch fire from
    diyaList.push({ x: cx, z: cz - 0.1, s: 1.7, yaw: -Math.PI / 2, order: 0 });
    placeDiyas(diyaList);

    buildSamai(-3.62, 0.95);
    buildSamai(3.62, 0.95);
    buildFlames();

    buildLights();
    buildTwinkles(archPts);
    buildBackdrop();
    buildEmbers();
    buildCoins();
    buildPetals();
    buildFireworks();
    resize();
    start();
  }

  const clock = new THREE.Clock();
  let time = 0, frames = 0, slowSince = 0, nextCoin = 0;

  function start() {
    document.getElementById("loader").classList.add("done");
    setTimeout(() => document.body.classList.add("revealed"), reducedMotion ? 100 : 1500);
    window.diwali = { scene, camera, view, buildMs: Math.round(performance.now() - buildStart), skipIntro() { time = 12; } }; // handy for exploring in the browser console
    requestAnimationFrame(tick);
  }

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    time += dt;
    const t = time;
    flameUniforms.uTime.value = t;

    /* Opening: dark, then the centre diya lights and the flame spreads outward. */
    const intro = reducedMotion ? 1 : ease(t / 5);
    const lit = flameLit.array;
    flameSpots.forEach((f, i) => {
      const v = ease((t - 0.5 - f.order * 3.1) / 0.75);
      for (let q = 0; q < 4; q++) lit[i * 4 + q] = reducedMotion ? 1 : v;
    });
    flameLit.needsUpdate = true;

    const rise = reducedMotion ? 1 : ease((t - 1.1) / 3.3);
    gradePass.uniforms.uExposure.value = 0.3 + 0.58 * rise;
    LIGHT.keyG.intensity = 13 * rise;
    LIGHT.keyL.intensity = 15 * rise;
    LIGHT.rimA.intensity = 1.5 * rise;
    LIGHT.rimB.intensity = 1.2 * rise;
    dynamic.halos.forEach((m) => { m.uniforms.uTime.value = t; m.uniforms.uPower.value = rise; });
    twinkleMat.uniforms.uTime.value = t;
    twinkleMat.uniforms.uPower.value = rise;
    emberState.mat.uniforms.uPower.value = rise;

    // Real point lights flicker in step with the flames
    dynamic.lights.forEach((L) => {
      const n = 0.86 + 0.09 * Math.sin(t * 7.3 + L.phase) + 0.05 * Math.sin(t * 13.1 + L.phase * 2.1) + 0.04 * Math.sin(t * 23 + L.phase);
      L.light.intensity = L.base * n * Math.max(rise, ease((t - 0.5) / 1));
    });

    // Slow, cinematic camera drift, with a pull-in during the opening
    if (!reducedMotion) {
      if (!view.dragging) {
        view.yaw += (view.targetYaw + Math.sin(t * 0.17) * 0.05 - view.yaw) * Math.min(dt * 2.2, 1);
      } else {
        view.yaw += (view.targetYaw - view.yaw) * Math.min(dt * 8, 1);
      }
    } else {
      view.yaw += (view.targetYaw - view.yaw) * Math.min(dt * 8, 1);
    }
    view.pitch += (view.targetPitch - view.pitch) * Math.min(dt * 4, 1);
    const d = view.dist + (1 - intro) * 3.2;
    const camY = view.lookY + view.camRise - (1 - intro) * 0.8 + view.pitch * d;
    camera.position.set(Math.sin(view.yaw) * d, camY, Math.cos(view.yaw) * d);
    camera.lookAt(0, view.lookY, 0);

    // Living idols: soft nodding, the flap of Ganesha's ears, a graceful sway from Lakshmi
    if (!reducedMotion) {
      const { head, ears } = ganesha.userData;
      head.rotation.z = Math.sin(t * 0.65) * 0.028;
      head.rotation.x = Math.sin(t * 0.5 + 1) * 0.016;
      ears[0].rotation.y = 0.05 + Math.sin(t * 1.8) * 0.13 * (0.6 + 0.4 * Math.sin(t * 0.5));
      ears[1].rotation.y = -0.05 - Math.sin(t * 1.8 + 0.3) * 0.13 * (0.6 + 0.4 * Math.sin(t * 0.5));
      const lh = lakshmi.userData.head;
      lh.rotation.z = Math.sin(t * 0.55 + 2) * 0.03;
      lh.rotation.y = Math.sin(t * 0.38) * 0.04;
      lh.rotation.x = 0.01 + Math.sin(t * 0.47) * 0.012;
      [-1, 1].forEach((s) => {
        const e = lh.userData["ear" + s];
        if (e) e.rotation.z = Math.sin(t * 2.1 + s) * 0.08;
      });
      dynamic.lanterns.forEach((L) => {
        L.pivot.rotation.z = Math.sin(t * 0.75 + L.phase) * 0.028;
        L.pivot.rotation.x = Math.sin(t * 0.53 + L.phase) * 0.018;
        L.pivot.rotation.y = t * 0.1;
      });
    }

    // Coins pour steadily from Lakshmi's giving hand
    nextCoin -= dt;
    if (nextCoin <= 0 && t > 3) {
      nextCoin = rand(0.12, 0.3);
      const hand = lakshmi.userData.coinHand.clone().applyEuler(lakshmi.rotation).add(lakshmi.position);
      emitCoin(hand.x + rand(-0.04, 0.04), hand.y, hand.z + rand(-0.03, 0.03), rand(-0.12, 0.12), rand(-0.05, 0.1), rand(0.05, 0.3));
    }

    blessBoost = Math.max(0, blessBoost - dt * 0.2);
    updateCoins(dt);
    updatePetals(t, dt, blessBoost);
    updateEmbers(t, dt);
    updateFireworks(dt);

    renderer.shadowMap.needsUpdate = frames % 5 === 0;
    composer.render(dt);

    // Lower the resolution on slower devices so the animation stays smooth.
    frames++;
    if (frames % 90 === 0 && t > 6) {
      if (dt > 1 / 28) {
        slowSince++;
        if (slowSince >= 2 && renderer.getPixelRatio() > 1) {
          renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() - 0.25));
          resize();
          slowSince = 0;
        }
      } else slowSince = 0;
    }
  }

  build().catch((err) => { console.error(err); fatal(); });
})();
