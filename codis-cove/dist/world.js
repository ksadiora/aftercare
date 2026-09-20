import * as THREE from "./vendor/three.module.js";

const PLACES = [
  {
    id: "bank",
    name: "CapitalTwo Bank",
    blurb: "Save coins. Learn banking with Nessie.",
    tag: "SAVE",
    icon: "◈",
    x: -5,
    z: -3.5,
    y: 5.1,
  },
  {
    id: "classroom",
    name: "Notion Classroom",
    blurb: "Plan your day. Learn to use Notion.",
    tag: "PLAN",
    icon: "▤",
    x: 4.8,
    z: -4.8,
    y: 5.2,
  },
  {
    id: "garden",
    name: "Kindness Garden",
    blurb: "Grow something. Share with a neighbor.",
    tag: "GROW",
    icon: "♧",
    x: 6,
    z: 4,
    y: 2.7,
  },
];
export function createWorld({
  container,
  onVisit,
  onNear,
  onAction,
  onMessage,
  getPaused,
  getReducedMotion,
}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c2e3e9");
  scene.fog = new THREE.Fog("#c2e3e9", 32, 100);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  container.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.08, 180);
  const materials = new Map();
  function mat(color) {
    if (!materials.has(color))
      materials.set(
        color,
        new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 }),
      );
    return materials.get(color);
  }
  function mesh(geometry, color, x = 0, y = 0, z = 0, parent = scene) {
    const m = new THREE.Mesh(geometry, mat(color));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function box(w, h, d, c, x, y, z, parent) {
    return mesh(new THREE.BoxGeometry(w, h, d), c, x, y, z, parent);
  }
  function ball(r, c, x, y, z, parent, detail = 0) {
    return mesh(new THREE.IcosahedronGeometry(r, detail), c, x, y, z, parent);
  }
  function cylinder(rt, rb, h, c, x, y, z, parent, n = 10) {
    return mesh(new THREE.CylinderGeometry(rt, rb, h, n), c, x, y, z, parent);
  }
  function group(x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    scene.add(g);
    return g;
  }
  const hemi = new THREE.HemisphereLight("#fff9dd", "#719f87", 2.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff0ce", 3.2);
  sun.position.set(-14, 28, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -24,
    right: 24,
    top: 24,
    bottom: -24,
    near: 1,
    far: 85,
  });
  sun.shadow.normalBias = 0.06;
  sun.shadow.bias = -0.0002;
  sun.shadow.radius = 4;
  scene.add(sun);
  const water = mesh(new THREE.PlaneGeometry(300, 300), "#82becb", 0, -1.0, 0);
  water.rotation.x = -Math.PI / 2;
  water.castShadow = false;
  // The island is the game board: tiered terrain, navigable paths, and collision landmarks.
  const island = group(0, -0.3, 0);
  const rock = cylinder(12.8, 10.4, 3.2, "#d2c8a0", 0, -1, 0, island, 13);
  rock.scale.z = 0.78;
  rock.rotation.y = 0.1;
  const shore = cylinder(13.3, 12.8, 0.6, "#f2dfa9", 0, 0.2, 0, island, 40);
  shore.scale.z = 0.79;
  const grass = cylinder(12.35, 12.7, 0.5, "#accb8c", 0, 0.68, 0, island, 36);
  grass.scale.z = 0.79;
  const lawn = cylinder(9.6, 11.7, 0.12, "#b6ce96", 0.1, 0.98, 0, island, 26);
  lawn.scale.z = 0.87;
  const topY = 0.79;
  function path(points, width = 0.8, color = "#eae2b9") {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p[0], topY, p[1])),
    );
    const ps = curve.getPoints(70),
      vertices = [],
      indices = [];
    for (let i = 0; i < ps.length; i++) {
      const tangent = curve.getTangent(i / (ps.length - 1));
      const nx = (-tangent.z * width) / 2,
        nz = (tangent.x * width) / 2;
      vertices.push(
        ps[i].x + nx,
        topY + 0.04,
        ps[i].z + nz,
        ps[i].x - nx,
        topY + 0.04,
        ps[i].z - nz,
      );
      if (i < ps.length - 1) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const ribbon = mesh(geometry, color);
    ribbon.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    ribbon.castShadow = false;
  }
  path(
    [
      [-3, 9],
      [-2, 6],
      [0, 3],
      [0, 0],
      [-3, -1],
      [-5, -0.7],
    ],
    1.6,
  );
  path(
    [
      [0, 2],
      [3, 1],
      [4.7, -1],
      [4.8, -2.6],
    ],
    1.3,
  );
  path(
    [
      [1, 2],
      [3, 3],
      [5, 5],
      [7, 5.5],
    ],
    1.2,
  );
  path(
    [
      [0, 1],
      [-2, 1],
      [-5, 2],
      [-8, 2.5],
    ],
    0.75,
  );
  const obstacles = [];
  function building({ x, z, w, d, h, wall, roof }) {
    const g = group(x, topY, z);
    box(w + 0.3, 0.25, d + 0.3, "#f3e8cc", 0, 0.1, 0, g);
    box(w, h, d, wall, 0, h / 2 + 0.2, 0, g);
    box(w + 0.18, 0.18, d + 0.18, "#f4e8cf", 0, 0.45, 0, g);
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 - 0.25, 0);
    shape.lineTo(0, 1.3);
    shape.lineTo(w / 2 + 0.25, 0);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: d + 0.5,
      bevelEnabled: false,
    });
    const r = mesh(geo, roof, 0, h + 0.18, -d / 2 - 0.25, g);
    r.castShadow = true;
    box(0.8, 1.45, 0.13, "#477b66", 0, 0.98, d / 2 + 0.08, g);
    box(0.07, 1.42, 0.18, "#f6e7c9", -0.49, 1, d / 2 + 0.1, g);
    box(0.07, 1.42, 0.18, "#f6e7c9", 0.49, 1, d / 2 + 0.1, g);
    box(1.07, 0.11, 0.18, "#f6e7c9", 0, 1.74, d / 2 + 0.1, g);
    ball(0.055, "#ebc15c", 0.27, 0.97, d / 2 + 0.17, g, 1);
    for (const sx of [-1, 1]) {
      box(0.86, 0.98, 0.12, "#f9eac5", sx * (w * 0.31), 1.65, d / 2 + 0.1, g);
      box(0.64, 0.75, 0.14, "#a5d5ce", sx * (w * 0.31), 1.65, d / 2 + 0.17, g);
      box(0.06, 0.75, 0.17, "#fff4d7", sx * (w * 0.31), 1.65, d / 2 + 0.2, g);
      box(0.66, 0.06, 0.17, "#fff4d7", sx * (w * 0.31), 1.65, d / 2 + 0.21, g);
      box(0.95, 0.12, 0.42, "#f7e9c2", sx * (w * 0.31), 1.11, d / 2 + 0.25, g);
    }
    box(0.12, 0.85, 0.75, "#eff0d1", w / 2 + 0.07, 1.6, 0, g);
    box(0.14, 0.63, 0.54, "#a0cbc8", w / 2 + 0.13, 1.6, 0, g);
    box(1.8, 0.18, 0.6, "#f4e4ba", 0, 0.05, d / 2 + 0.4, g);
    box(1.4, 0.12, 0.4, "#eee0b9", 0, -0.05, d / 2 + 0.85, g);
    obstacles.push({ x, z, w: w / 2 + 0.24, d: d / 2 + 0.24 });
    return g;
  }
  const bank = building({
    x: -5,
    z: -3.5,
    w: 3.75,
    d: 2.65,
    h: 2.4,
    wall: "#f0bc91",
    roof: "#d28c71",
  });
  const badge = cylinder(0.42, 0.42, 0.09, "#f2d277", 0, 2.85, 1.39, bank, 24);
  badge.rotation.x = Math.PI / 2;
  box(0.1, 0.47, 0.12, "#aa9261", 0, 2.85, 1.47, bank);
  box(0.35, 0.06, 0.12, "#aa9261", 0, 2.85, 1.47, bank);
  box(0.46, 0.85, 0.55, "#e8c6a0", 1, 3.42, -0.5, bank);
  box(0.62, 0.17, 0.69, "#e9d4b3", 1, 3.91, -0.5, bank);
  const school = building({
    x: 4.8,
    z: -4.8,
    w: 4.3,
    d: 3,
    h: 2.5,
    wall: "#d8c7e2",
    roof: "#a4a0c5",
  });
  const clock = cylinder(0.37, 0.37, 0.12, "#fff2d6", 0, 3, 1.64, school, 24);
  clock.rotation.x = Math.PI / 2;
  box(0.06, 0.21, 0.14, "#696a83", 0, 3.07, 1.72, school);
  box(0.18, 0.05, 0.14, "#696a83", 0.065, 2.97, 1.73, school);
  for (let i = 0; i < 5; i++) {
    const flag = box(
      0.22,
      0.3,
      0.02,
      ["#e9b07b", "#c7d991", "#edd57e", "#b7c8d4", "#d8b7bf"][i],
      -1.2 + i * 0.6,
      2.33,
      1.58,
      school,
    );
    flag.rotation.z = (i - 2) * 0.06;
  }
  // Community garden with growth states tied to quest progress.
  const garden = group(6, topY, 3.4);
  const sprouts = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 3; c++) {
      const x = (c - 1) * 0.93,
        z = (r - 0.5) * 1.3;
      box(0.8, 0.25, 1.05, "#b88966", x, 0.12, z, garden);
      box(0.65, 0.29, 0.88, "#79664c", x, 0.14, z, garden);
      for (let k = 0; k < 2; k++) {
        const s = group(0, 0, 0);
        scene.remove(s);
        garden.add(s);
        s.position.set(x, 0.3, z + (k - 0.5) * 0.35);
        cylinder(0.04, 0.045, 0.35, "#739756", 0, 0.13, 0, s, 6);
        const leaf1 = ball(0.17, "#8da861", -0.1, 0.32, 0, s);
        leaf1.scale.set(1, 0.5, 0.65);
        const leaf2 = ball(0.2, "#a6be6f", 0.1, 0.41, 0, s);
        leaf2.scale.set(1, 0.5, 0.65);
        sprouts.push(s);
      }
    }
  function fence(x, z, length, axis = "x") {
    const g = group(x, topY, z);
    for (let i = 0; i <= length; i += 0.6)
      box(
        0.12,
        0.73,
        0.12,
        "#f0e5c6",
        axis === "x" ? i : 0,
        0.37,
        axis === "z" ? i : 0,
        g,
      );
    for (const y of [0.27, 0.58])
      box(
        axis === "x" ? length + 0.1 : 0.09,
        0.1,
        axis === "z" ? length + 0.1 : 0.09,
        "#e9ddba",
        axis === "x" ? length / 2 : 0,
        y,
        axis === "z" ? length / 2 : 0,
        g,
      );
    return g;
  }
  fence(4.4, 1.6, 3.2);
  fence(7.7, 1.6, 3.6, "z");
  fence(4.4, 1.6, 1, "z");
  const tool = group(4.15, topY, 3.2);
  cylinder(0.27, 0.32, 0.45, "#dcad75", 0, 0.3, 0, tool);
  const spout = box(0.15, 0.15, 0.6, "#dcad75", 0.25, 0.4, 0.15, tool);
  spout.rotation.z = -0.4;
  // Rounded low-poly trees create navigable borders without hiding the destinations.
  let treeCount = 0;
  function tree(x, z, size = 1, tint = "#9db874", pine = false) {
    const g = group(x, topY, z);
    cylinder(0.1, 0.17, 1.45 * size, "#a89468", 0, 0.72 * size, 0, g, 7);
    if (pine) {
      for (let i = 0; i < 3; i++)
        cylinder(
          0,
          (1 - i * 0.18) * size,
          1.25 * size,
          tint,
          0,
          (1.55 + i * 0.58) * size,
          0,
          g,
          7,
        );
    } else {
      const a = ball(1.1 * size, tint, 0, 2 * size, 0, g, 1);
      a.scale.set(0.9, 1.1, 0.88);
      ball(0.7 * size, tint, -0.42 * size, 1.72 * size, 0.2, g, 0);
    }
    treeCount++;
    return g;
  }
  const trees = [
    [-9, -1, 1.2, "#a6b977"],
    [-8, -5, 1.1, "#a5bd7a"],
    [-7, -7, 1, "#b4c77f"],
    [-3, -7, 1.05, "#a6bc82"],
    [0.1, -7.3, 1.25, "#9db784"],
    [8, -4.8, 0.95, "#b3bf81"],
    [9, -1, 0.9, "#b6cb89"],
    [-9, 3, 0.92, "#a4bd77"],
    [-6, 6, 1.05, "#a0b47b"],
    [9, 3, 0.75, "#b2c785"],
    [2, 7.3, 0.75, "#c6c990"],
  ];
  trees.forEach((t, i) => tree(...t, i % 4 === 0));
  function shrub(x, z, s = 1, c = "#a1b96e") {
    ball(0.45 * s, c, x, topY + 0.27 * s, z, undefined, 1);
    ball(0.34 * s, c, x + 0.3 * s, topY + 0.2 * s, z + 0.15);
  }
  [
    [-7, -1],
    [-3, -5.8],
    [2.2, -4.6],
    [8.1, -2.6],
    [-8, 5],
    [5, 7],
    [-4, 7.5],
    [8, 6.3],
  ].forEach((p) => shrub(...p, 1.1));
  // Dock, shoreline pebbles, flowers, benches and a tiny mail stop.
  for (let i = 0; i < 8; i++)
    box(1.8, 0.15, 0.35, "#c9b089", -2, topY - 0.13, 8 + i * 0.4);
  for (const x of [-2.8, -1.2])
    for (const z of [8.1, 10.6])
      cylinder(0.11, 0.13, 1.3, "#b19671", x, 0.27, z, undefined, 7);
  function bench(x, z, rot = 0) {
    const g = group(x, topY, z);
    g.rotation.y = rot;
    for (const xx of [-0.5, 0.5])
      box(0.14, 0.6, 0.63, "#887e60", xx, 0.3, 0, g);
    for (const zz of [-0.22, 0, 0.22])
      box(1.4, 0.1, 0.16, "#d5b580", 0, 0.62, zz, g);
    box(1.4, 0.4, 0.1, "#d5b580", 0, 1.04, -0.32, g);
    return g;
  }
  bench(-6.6, 1.7, -0.35);
  bench(1.9, -2.2, 0.2);
  const mailbox = group(-3.2, topY, -1.7);
  box(0.12, 0.9, 0.12, "#a78f66", 0, 0.45, 0, mailbox);
  box(0.44, 0.37, 0.52, "#789e86", 0, 1, 0, mailbox);
  box(0.27, 0.045, 0.05, "#3b6754", 0, 1.01, 0.28, mailbox);
  box(0.05, 0.45, 0.05, "#d69b67", 0.28, 1.05, 0, mailbox);
  function flower(x, z, color) {
    cylinder(0.025, 0.028, 0.3, "#82975b", x, topY + 0.1, z, undefined, 5);
    ball(0.12, color, x, topY + 0.3, z, undefined, 0);
    ball(0.055, "#e4bd62", x, topY + 0.39, z, undefined, 0);
  }
  for (let i = 0; i < 30; i++) {
    const angle = i * 2.399;
    const r = 7.4 + (i % 4) * 0.63;
    flower(
      Math.cos(angle) * r,
      Math.sin(angle) * r * 0.77,
      ["#fff4c8", "#f0cb96", "#dab8bc"][i % 3],
    );
  }
  for (let i = 0; i < 12; i++) {
    let a = i * 2.4;
    const r = 12.7;
    const b = ball(
      0.28 + (i % 3) * 0.08,
      "#d9d6b5",
      Math.cos(a) * r,
      -0.2,
      Math.sin(a) * r * 0.8,
      undefined,
      0,
    );
    b.scale.y = 0.6;
  }
  // A camp pennant and sign mark the arrival point.
  cylinder(0.055, 0.06, 2.3, "#ab9771", -3.2, 1.9, 6.5, undefined, 7);
  const flag = mesh(
    new THREE.PlaneGeometry(0.9, 0.48),
    "#e9b370",
    -2.73,
    2.65,
    6.5,
  );
  flag.material = new THREE.MeshStandardMaterial({
    color: "#e9b370",
    side: THREE.DoubleSide,
  });
  box(0.75, 0.45, 0.1, "#e3cd97", -4.15, 1.55, 5.55);
  cylinder(0.07, 0.08, 0.8, "#a7966b", -4.15, 1.11, 5.55);
  // A few flat sea rocks and ripples give the island room to breathe.
  for (const [x, z, r] of [
    [15, 5, 1.3],
    [-15, -4, 1],
    [-8, 13, 0.65],
    [8, 12, 0.75],
    [14, -8, 0.85],
  ]) {
    const b = ball(r, "#b2c6ab", x, -0.65, z);
    b.scale.y = 0.4;
  }
  const ripples = [];
  for (let i = 0; i < 18; i++) {
    const x = Math.sin(i * 7.23) * 23,
      z = Math.cos(i * 3.8) * 17;
    if ((x * x) / 190 + (z * z) / 115 < 1) continue;
    const r = mesh(
      new THREE.PlaneGeometry(1.5 + (i % 3), 0.045),
      "#d2e6d2",
      x,
      -0.975,
      z,
    );
    r.rotation.x = -Math.PI / 2;
    r.castShadow = false;
    r.receiveShadow = false;
    ripples.push(r);
  }
  // A controllable explorer. Limbs animate from distance travelled, independent of frame rate.
  const player = group(-1.8, topY + 0.02, 5.1);
  const body = group(0, 0, 0);
  scene.remove(body);
  player.add(body);
  const torso = box(0.46, 0.55, 0.3, "#e9ad68", 0, 0.78, 0, body);
  torso.geometry = new THREE.BoxGeometry(0.46, 0.55, 0.34);
  const head = ball(0.3, "#efc89c", 0, 1.3, 0, body, 2);
  head.scale.set(0.86, 1, 0.9);
  const hair = ball(0.29, "#594e3f", 0, 1.42, -0.035, body, 1);
  hair.scale.set(0.92, 0.7, 0.94);
  cylinder(0.3, 0.3, 0.12, "#648b74", 0, 1.51, 0, body, 12);
  box(0.38, 0.05, 0.2, "#648b74", 0, 1.46, 0.21, body);
  for (const x of [-0.1, 0.1]) ball(0.022, "#514d3b", x, 1.3, 0.245, body, 1);
  box(0.3, 0.4, 0.17, "#c98b66", 0, 0.83, -0.24, body);
  box(0.06, 0.45, 0.035, "#d8bc81", -0.16, 0.86, 0.19, body);
  box(0.06, 0.45, 0.035, "#d8bc81", 0.16, 0.86, 0.19, body);
  const limbs = [];
  for (const x of [-0.16, 0.16]) {
    const g = new THREE.Group();
    g.position.set(x, 0.54, 0);
    body.add(g);
    box(0.17, 0.38, 0.19, "#557b76", 0, -0.2, 0, g);
    box(0.2, 0.13, 0.3, "#fcf0cb", 0, -0.41, 0.04, g);
    limbs.push(g);
  }
  const arms = [];
  for (const x of [-0.31, 0.31]) {
    const g = new THREE.Group();
    g.position.set(x, 1, 0);
    body.add(g);
    box(0.16, 0.33, 0.19, "#edb473", 0, -0.12, 0, g);
    ball(0.08, "#efc89c", 0, -0.33, 0, g, 1);
    arms.push(g);
  }
  const playerRing = mesh(
    new THREE.RingGeometry(0.43, 0.5, 40),
    "#fff4bc",
    0,
    0.035,
    0,
    player,
  );
  playerRing.rotation.x = -Math.PI / 2;
  playerRing.castShadow = false;
  playerRing.receiveShadow = false;
  const butterflies = [];
  for (let i = 0; i < 3; i++) {
    const g = group(3 + i * 1.8, 2.2, 2 + i);
    const wing = mesh(
      new THREE.PlaneGeometry(0.15, 0.17),
      "#f4d29a",
      0,
      0,
      0,
      g,
    );
    wing.material = new THREE.MeshBasicMaterial({
      color: "#f2c177",
      side: THREE.DoubleSide,
    });
    butterflies.push(g);
  }
  // World interactions live on objects, not remote menu buttons.
  const interactions = [
    {
      id: "bank-ledger",
      name: "Nessie savings ledger",
      label: "Read savings records",
      x: -3.35,
      z: -0.5,
      y: 1.3,
      range: 1.1,
    },
    {
      id: "classroom-board",
      name: "Notion classroom board",
      label: "Read classroom assignments",
      x: 8.7,
      z: 0.6,
      y: 1.5,
      range: 1.2,
    },
    {
      id: "bank",
      name: "CapitalTwo Bank",
      label: "Save 20 coins",
      x: -5,
      z: -1.25,
      y: 1.2,
      range: 1.55,
    },
    {
      id: "helmet",
      name: "Safety stand",
      label: "Choose the helmet",
      x: -7.1,
      z: -0.7,
      y: 1.15,
      range: 1.25,
    },
    {
      id: "stickers",
      name: "Sticker stand",
      label: "Look at stickers",
      x: -8.9,
      z: -0.7,
      y: 1.05,
      range: 1.15,
    },
    {
      id: "plan-snack",
      name: "Afternoon plan · 1",
      label: "Have a snack",
      x: 2.1,
      z: -1.2,
      y: 0.9,
      range: 1.1,
    },
    {
      id: "plan-homework",
      name: "Afternoon plan · 2",
      label: "Finish homework",
      x: 3.8,
      z: -1.2,
      y: 0.9,
      range: 1.1,
    },
    {
      id: "plan-pack",
      name: "Afternoon plan · 3",
      label: "Pack your bag",
      x: 5.5,
      z: -1.2,
      y: 0.9,
      range: 1.1,
    },
    {
      id: "plan-play",
      name: "Afternoon plan · 4",
      label: "Time to play!",
      x: 7.2,
      z: -1.2,
      y: 0.9,
      range: 1.1,
    },
    {
      id: "garden",
      name: "Community garden",
      label: "Plant a seed",
      x: 6,
      z: 5.1,
      y: 0.6,
      range: 1.45,
    },
    {
      id: "watering-can",
      name: "Garden tools",
      label: "Pick up watering can",
      x: 4.15,
      z: 3.2,
      y: 0.75,
      range: 1.15,
    },
    {
      id: "share",
      name: "Bea · your neighbor",
      label: "Talk to Bea",
      x: 3,
      z: 5.6,
      y: 1.85,
      range: 1.4,
    },
    {
      id: "codi",
      name: "Codi · island guide",
      label: "Talk to Codi",
      x: -1.2,
      z: 3.5,
      y: 1.9,
      range: 1.45,
    },
  ];
  // Walk-up service boards use the same nearby interaction system as quests.
  const ledgerStand = group(-3.35, topY, -0.7);
  box(0.15, 1.05, 0.15, "#a58e62", 0, 0.525, 0, ledgerStand);
  box(0.85, 0.55, 0.15, "#f0d379", 0, 1.1, 0, ledgerStand);
  for (let i = 0; i < 3; i++)
    box(0.52, 0.035, 0.02, "#677d68", 0, 1.23 - i * 0.12, 0.09, ledgerStand);
  const classBoard = group(8.7, topY, 0.4);
  for (const x of [-0.45, 0.45])
    box(0.12, 1.55, 0.12, "#978666", x, 0.775, 0, classBoard);
  box(1.2, 0.9, 0.16, "#677d78", 0, 1.22, 0, classBoard);
  for (const x of [-0.29, 0.29]) {
    box(0.43, 0.6, 0.025, "#fcf5de", x, 1.23, 0.095, classBoard);
    for (let i = 0; i < 3; i++)
      box(0.28, 0.03, 0.015, "#afbac1", x, 1.4 - i * 0.13, 0.12, classBoard);
  }
  const bankTerminal = group(-5, topY, -1.48);
  box(0.72, 1.3, 0.46, "#669c8c", 0, 0.65, 0, bankTerminal);
  box(0.82, 0.1, 0.56, "#e3edcd", 0, 1.33, 0, bankTerminal);
  box(0.51, 0.42, 0.02, "#284e4c", 0, 0.94, 0.245, bankTerminal);
  box(0.35, 0.05, 0.025, "#b5e5c3", 0, 0.96, 0.265, bankTerminal);
  box(0.15, 0.05, 0.025, "#b5e5c3", 0, 0.86, 0.265, bankTerminal);
  box(0.4, 0.055, 0.03, "#345c54", 0, 0.42, 0.25, bankTerminal);
  for (const x of [-7.1, -8.9]) {
    box(1.2, 0.11, 0.8, "#d6b18b", x, topY + 0.65, -0.7);
    for (const dx of [-0.44, 0.44])
      box(0.1, 0.65, 0.5, "#beaa81", x + dx, topY + 0.32, -0.7);
  }
  const helmet = mesh(
    new THREE.SphereGeometry(0.27, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    "#e0b573",
    -7.1,
    topY + 0.76,
    -0.7,
  );
  helmet.rotation.x = 0.1;
  const helmetStrap = mesh(
    new THREE.TorusGeometry(0.18, 0.025, 5, 12, Math.PI),
    "#6f8b78",
    -7.1,
    topY + 0.77,
    -0.66,
  );
  helmetStrap.rotation.z = Math.PI;
  for (let i = 0; i < 3; i++) {
    const sticker = box(
      0.3,
      0.025,
      0.3,
      ["#d7b6d8", "#a7cecd", "#f1d787"][i],
      -9.2 + i * 0.3,
      topY + 0.73,
      -0.7,
    );
    sticker.rotation.y = i * 0.4;
  }
  const stationPads = [];
  for (let i = 0; i < 4; i++) {
    const x = 2.1 + i * 1.7;
    const pad = cylinder(
      0.53,
      0.59,
      0.17,
      ["#eac48d", "#c7b7dd", "#9fcabb", "#ecd88f"][i],
      x,
      topY + 0.08,
      -1.2,
      undefined,
      16,
    );
    stationPads.push(pad);
    cylinder(0.04, 0.05, 0.75, "#a7a37c", x, topY + 0.55, -1.2, undefined, 6);
  }
  ball(0.19, "#e6a482", 2.1, topY + 1, -1.2, undefined, 1);
  box(0.03, 0.14, 0.03, "#839b66", 2.1, topY + 1.19, -1.2);
  const book = box(0.48, 0.11, 0.35, "#829bc0", 3.8, topY + 1, -1.2);
  book.rotation.z = -0.1;
  box(0.39, 0.06, 0.3, "#fff1d5", 3.8, topY + 1.07, -1.2);
  box(0.36, 0.43, 0.23, "#bd947c", 5.5, topY + 1, -1.2);
  box(0.26, 0.1, 0.05, "#e9d0a4", 5.5, topY + 0.99, -1.06);
  const kite = box(0.34, 0.34, 0.04, "#e8ce7d", 7.2, topY + 1.15, -1.2);
  kite.rotation.z = Math.PI / 4;
  // Codi is a character in the world, with the same cream-and-mint palette as the portrait.
  const codiNPC = group(-1.2, topY, 3.5);
  box(0.5, 0.55, 0.36, "#86b7a0", 0, 0.72, 0, codiNPC);
  box(0.64, 0.5, 0.43, "#f0e6c8", 0, 1.28, 0, codiNPC);
  box(0.49, 0.32, 0.045, "#294c48", 0, 1.28, 0.236, codiNPC);
  for (const x of [-0.135, 0.135])
    box(0.095, 0.045, 0.015, "#b5efb8", x, 1.32, 0.264, codiNPC);
  cylinder(0.035, 0.035, 0.2, "#80987b", 0, 1.64, 0, codiNPC);
  ball(0.09, "#eab177", 0, 1.8, 0, codiNPC, 1);
  for (const x of [-0.16, 0.16]) {
    box(0.16, 0.26, 0.21, "#7da594", x, 0.3, 0, codiNPC);
    box(0.22, 0.14, 0.3, "#f1e7d1", x, 0.1, 0.05, codiNPC);
  }
  for (const x of [-0.35, 0.35])
    box(0.14, 0.4, 0.17, "#eadebf", x, 0.74, 0, codiNPC);
  const codiWave = codiNPC.children.at(-1);
  codiWave.rotation.z = -0.45;
  const bea = group(3, topY, 5.6);
  bea.rotation.y = -0.9;
  box(0.48, 0.56, 0.32, "#bdabc9", 0, 0.77, 0, bea);
  cylinder(0.22, 0.2, 0.39, "#d8aa82", 0, 1.26, 0, bea, 12);
  ball(0.24, "#69523f", 0, 1.45, -0.02, bea, 1);
  cylinder(0.43, 0.43, 0.055, "#decc97", 0, 1.47, 0, bea, 12);
  for (const x of [-0.15, 0.15]) {
    box(0.19, 0.48, 0.23, "#718b81", x, 0.27, 0, bea);
    box(0.21, 0.11, 0.31, "#f2e8d0", x, 0.08, 0.045, bea);
  }
  for (const x of [-0.31, 0.31])
    box(0.14, 0.45, 0.17, "#bdabc9", x, 0.75, 0, bea);
  // Jumpable trail platforms and one-time pickups.
  const platforms = [
    { x: -6, z: 4.2, w: 0.6, d: 0.6, h: 0.3 },
    { x: -7.45, z: 3.95, w: 0.59, d: 0.59, h: 0.65 },
    { x: -8.9, z: 4.45, w: 0.58, d: 0.58, h: 1.0 },
  ];
  const stars = [];
  platforms.forEach((p, i) => {
    cylinder(
      0.69,
      0.77,
      p.h,
      "#d8c19e",
      p.x,
      topY + p.h / 2,
      p.z,
      undefined,
      8,
    );
    cylinder(
      0.69,
      0.7,
      0.09,
      "#c4dca0",
      p.x,
      topY + p.h + 0.02,
      p.z,
      undefined,
      8,
    );
    const coin = cylinder(
      0.2,
      0.2,
      0.065,
      "#efca65",
      p.x,
      topY + p.h + 0.65,
      p.z,
      undefined,
      12,
    );
    coin.rotation.x = Math.PI / 2;
    stars.push(coin);
  });
  // Distant scenery gives a horizon at character height.
  for (const [x, z, r] of [
    [-32, -35, 8],
    [26, -48, 11],
    [46, 15, 10],
    [-40, 20, 8],
  ]) {
    const hill = ball(r, "#b0cdb5", x, -4, z, undefined, 0);
    hill.scale.y = 0.65;
  }
  for (let i = 0; i < 7; i++) {
    const cloud = group(-37 + i * 13, 13 + (i % 3) * 3, -40 - (i % 2) * 18);
    for (let j = 0; j < 3; j++) {
      const puff = ball(
        2.2 + j * 0.4,
        "#f8f5e7",
        j * 2.2,
        Math.sin(j) * 0.5,
        0,
        cloud,
        1,
      );
      puff.scale.y = 0.52;
      puff.castShadow = false;
    }
  }
  // Character input and physics stay independent of display frame rate.
  const events = new AbortController();
  const options = { signal: events.signal };
  const keys = new Set();
  let nearest = null,
    trackedTarget = "bank",
    currentState = null;
  let width = 1,
    height = 1,
    lastTime = 0,
    frame = 0,
    walkCycle = 0,
    verticalSpeed = 0,
    grounded = true;
  let velocity = new THREE.Vector2(),
    yaw = 0.06,
    pitch = 0.33,
    distance = 6.6,
    drag = null,
    wasPaused = false;
  let currentActionUntil = 0,
    sprint = false;
  const follow = new THREE.Vector3(),
    desired = new THREE.Vector3(),
    direction = new THREE.Vector3(),
    probe = new THREE.Vector3();
  const cameraRay = new THREE.Ray();
  const tempBox = new THREE.Box3();
  const labels = document.getElementById("landmark-labels");
  labels.replaceChildren();
  const signposts = [
    { id: "bank-sign", name: "Nessie savings", blurb: "See your practice bank account.", icon: "◈", x: -3.35, z: -0.7, y: 1.8, range: 6.5 },
    { id: "classroom-sign", name: "Notion assignments", blurb: "Open your classroom task board.", icon: "▤", x: 8.7, z: 0.4, y: 2.4, range: 6.5 },
  ];
  const mapLabels = [...PLACES, ...signposts].map((p) => {
    const el = document.createElement("div");
    el.className = `landmark landmark-place ${p.id}`;
    const blurb = document.createElement("p");
    blurb.className = "landmark-blurb";
    blurb.textContent = p.blurb;
    const name = document.createElement("strong");
    name.className = "landmark-name";
    const icon = document.createElement("span");
    icon.textContent = p.icon;
    icon.setAttribute("aria-hidden", "true");
    name.append(icon, document.createTextNode(p.name));
    el.append(blurb, name);
    labels.appendChild(el);
    return { ...p, el };
  });
  const npcLabel = document.createElement("div");
  npcLabel.className = "landmark";
  npcLabel.textContent = "Codi";
  npcLabel.setAttribute("aria-hidden", "true");
  labels.appendChild(npcLabel);
  mapLabels.push({ x: -1.2, z: 3.5, y: 2.1, el: npcLabel });
  const marker = document.createElement("div");
  marker.className = "quest-marker";
  marker.innerHTML = '<span class="marker-gem">◆</span><small>QUEST</small>';
  labels.appendChild(marker);
  // Cache label dimensions so edge checks include the whole sign without
  // measuring layout on every animation frame. Ignore hidden zero-size boxes.
  const labelBounds = new WeakMap();
  const hudElements = [...document.querySelectorAll(".brand, .header-tools, .quest-panel, .player-stats, .objective-bearing, .main-nav, .touch-controls, .jump-btn, .camera-buttons, .map-button")];
  let hudDirty = true, hudBounds = [], placedLabels = [];
  const labelObserver = new ResizeObserver((entries) => {
    hudDirty = true;
    for (const entry of entries) {
      const box = entry.borderBoxSize?.[0];
      if (box?.inlineSize > 0 && box?.blockSize > 0)
        labelBounds.set(entry.target, { width: box.inlineSize, height: box.blockSize });
    }
  });
  for (const { el } of mapLabels) labelObserver.observe(el);
  labelObserver.observe(marker);
  for (const el of hudElements) labelObserver.observe(el);
  // A visible equipped tool makes the gardening activity physical.
  const heldCan = new THREE.Group();
  body.add(heldCan);
  heldCan.position.set(0.46, 0.68, 0.08);
  cylinder(0.13, 0.15, 0.24, "#8db6ad", 0, 0, 0, heldCan, 10);
  const heldSpout = box(0.08, 0.08, 0.3, "#8db6ad", 0.14, 0.03, 0.11, heldCan);
  heldSpout.rotation.y = -0.5;
  heldCan.visible = false;
  const basket = new THREE.Group();
  body.add(basket);
  basket.position.set(0.42, 0.63, 0.12);
  box(0.35, 0.26, 0.29, "#c7a17a", 0, 0, 0, basket);
  for (let i = 0; i < 3; i++)
    ball(
      0.09,
      ["#97b36d", "#e1a975", "#b6c787"][i],
      -0.1 + i * 0.1,
      0.17,
      0,
      basket,
    );
  basket.visible = false;
  player.position.set(0, topY + 0.02, 6.8);
  player.rotation.y = Math.PI;
  function isIsland(x, z) {
    return (
      (x * x) / (12 * 12) + (z * z) / (9.15 * 9.15) < 1 ||
      (x > -2.75 && x < -1.25 && z > 7.5 && z < 10.7)
    );
  }
  const solids = obstacles.map((b) => ({ ...b, top: topY + 4.2 }));
  trees.forEach((t) =>
    solids.push({ x: t[0], z: t[1], w: 0.22, d: 0.22, top: topY + 2.7 }),
  );
  const cameraSolids = [
    ...solids,
    ...trees.map((t) => ({
      x: t[0],
      z: t[1],
      w: 1.05 * t[2],
      d: 1.05 * t[2],
      bottom: topY + 1.15 * t[2],
      top: topY + 3.1 * t[2],
    })),
  ];
  const ledges = platforms.map((p) => ({ ...p, top: topY + p.h + 0.065 }));
  function fits(x, z, feet) {
    return (
      !solids.some(
        (b) =>
          Math.abs(x - b.x) < b.w + 0.23 &&
          Math.abs(z - b.z) < b.d + 0.23 &&
          feet < b.top - 0.08,
      ) &&
      !ledges.some(
        (b) =>
          Math.abs(x - b.x) < b.w + 0.18 &&
          Math.abs(z - b.z) < b.d + 0.18 &&
          feet < b.top - 0.18,
      )
    );
  }
  function groundAt(x, z, feet) {
    let h = isIsland(x, z) ? topY + 0.02 : -20;
    for (const p of ledges)
      if (
        Math.abs(x - p.x) < p.w + 0.1 &&
        Math.abs(z - p.z) < p.d + 0.1 &&
        feet >= p.top - 0.2
      )
        h = Math.max(h, p.top);
    return h;
  }
  function clearInput() {
    keys.clear();
    velocity.set(0, 0);
    drag = null;
    sprint = false;
  }
  function jump() {
    if (getPaused() || !grounded) return;
    verticalSpeed = 5.65;
    grounded = false;
  }
  function move(dx, dz) {
    const px = player.position.x,
      pz = player.position.z;
    if (fits(px + dx, pz, player.position.y)) player.position.x += dx;
    if (fits(player.position.x, pz + dz, player.position.y))
      player.position.z += dz;
  }
  function keyDirection() {
    const f =
      (keys.has("w") || keys.has("arrowup") ? 1 : 0) -
      (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const s =
      (keys.has("d") || keys.has("arrowright") ? 1 : 0) -
      (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    const len = Math.hypot(f, s) || 1;
    return {
      x: (-Math.sin(yaw) * f + Math.cos(yaw) * s) / len,
      z: (-Math.cos(yaw) * f - Math.sin(yaw) * s) / len,
    };
  }
  function useNearest() {
    if (getPaused()) return;
    findNearest();
    if (!nearest) return;
    if (nearest.id === "codi") {
      clearInput();
      onVisit("codi");
    } else {
      currentActionUntil = performance.now() + 550;
      onAction(nearest.id);
    }
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        getPaused() ||
        ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
      )
        return;
      const key = e.key.toLowerCase();
      if (
        [
          "w",
          "a",
          "s",
          "d",
          "arrowup",
          "arrowdown",
          "arrowleft",
          "arrowright",
          " ",
          "shift",
          "e",
          "q",
          "r",
        ].includes(key)
      )
        e.preventDefault();
      if (key === "e") {
        if (!e.repeat) useNearest();
        return;
      }
      if (key === " ") {
        if (!e.repeat) jump();
        return;
      }
      if (key === "q") {
        yaw += 0.09;
        return;
      }
      if (key === "r") {
        yaw -= 0.09;
        return;
      }
      if (
        [
          "w",
          "a",
          "s",
          "d",
          "arrowup",
          "arrowdown",
          "arrowleft",
          "arrowright",
          "shift",
        ].includes(key)
      ) {
        keys.add(key);
        if (!e.repeat && key !== "shift") {
          const d = keyDirection();
          move(d.x * 0.09, d.z * 0.09);
        }
      }
    },
    options,
  );
  window.addEventListener(
    "keyup",
    (e) => keys.delete(e.key.toLowerCase()),
    options,
  );
  window.addEventListener("blur", clearInput, options);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) clearInput();
    },
    options,
  );
  container.addEventListener("contextmenu", (e) => e.preventDefault(), options);
  container.addEventListener(
    "pointerdown",
    (e) => {
      if (getPaused() || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      container.setPointerCapture(e.pointerId);
      container.focus({ preventScroll: true });
    },
    options,
  );
  container.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || drag.id !== e.pointerId || getPaused()) return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      yaw -= dx * 0.006;
      pitch = THREE.MathUtils.clamp(pitch + dy * 0.004, 0.08, 1.04);
      drag.x = e.clientX;
      drag.y = e.clientY;
    },
    options,
  );
  const stopDrag = (e) => {
    if (drag?.id === e.pointerId) drag = null;
  };
  container.addEventListener("pointerup", stopDrag, options);
  container.addEventListener("pointercancel", stopDrag, options);
  container.addEventListener("lostpointercapture", stopDrag, options);
  container.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!getPaused())
        distance = THREE.MathUtils.clamp(distance + e.deltaY * 0.008, 3.3, 9);
    },
    { ...options, passive: false },
  );
  const controlKeys = { up: "w", left: "a", down: "s", right: "d" };
  document.querySelectorAll("[data-move]").forEach((b) => {
    const k = controlKeys[b.dataset.move];
    const stop = () => keys.delete(k);
    b.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        if (getPaused()) return;
        b.setPointerCapture(e.pointerId);
        keys.add(k);
        const d = keyDirection();
        move(d.x * 0.09, d.z * 0.09);
      },
      options,
    );
    b.addEventListener("pointerup", stop, options);
    b.addEventListener("pointercancel", stop, options);
    b.addEventListener("lostpointercapture", stop, options);
  });
  document.getElementById("jump-btn").addEventListener(
    "pointerdown",
    (e) => {
      e.preventDefault();
      jump();
    },
    options,
  );
  document
    .getElementById("camera-left")
    .addEventListener("click", () => (yaw += 0.35), options);
  document
    .getElementById("camera-right")
    .addEventListener("click", () => (yaw -= 0.35), options);
  function resize() {
    hudDirty = true;
    width = container.clientWidth;
    height = container.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.fov = width < 700 ? 66 : 58;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  function labelAt(el, x, y, z) {
    probe.set(x, y, z).project(camera);
    const px = (probe.x * 0.5 + 0.5) * width;
    let py = (-probe.y * 0.5 + 0.5) * height;
    const bounds = labelBounds.get(el) || { width: 0, height: 0 };
    const isPlace = el.classList.contains("landmark-place");
    if (isPlace) {
      // Keep readable signs below overlapping HUD controls and other signs.
      // Their horizontal position still follows the landmark in the world.
      for (const r of [...hudBounds, ...placedLabels].sort((a, b) => a.top - b.top)) {
        if (px + bounds.width / 2 > r.left - 8 && px - bounds.width / 2 < r.right + 8 &&
            py > r.top - 8 && py - bounds.height < r.bottom + 8)
          py = r.bottom + bounds.height + 8;
      }
    }
    const visible =
      probe.z > -1 &&
      probe.z < 1 &&
      px > bounds.width / 2 + 12 &&
      px < width - bounds.width / 2 - 12 &&
      py > Math.max(65, bounds.height + 12) &&
      py < height - 80;
    el.hidden = !visible;
    if (visible) {
      el.style.left = `${px}px`;
      el.style.top = `${py}px`;
      if (isPlace) placedLabels.push({ left: px - bounds.width / 2, right: px + bounds.width / 2, top: py - bounds.height, bottom: py });
    }
    return visible;
  }
  function actionLabel(p) {
    if (p.id === "garden")
      return [
        "Plant a seed",
        "Water the seedlings",
        "Harvest vegetables",
        "Harvest collected",
      ][currentState?.gardenStep || 0];
    if (p.id === "share" && currentState?.gardenStep === 3)
      return "Share your harvest";
    if (p.id === "bank" && currentState?.bankDeposited)
      return "Check your savings";
    return p.label;
  }
  function findNearest() {
    let best = null,
      bestDistance = Infinity;
    for (const p of interactions) {
      const d = Math.hypot(p.x - player.position.x, p.z - player.position.z);
      if (
        d < p.range &&
        d < bestDistance &&
        Math.abs(player.position.y - topY) < 1
      ) {
        best = { ...p, label: actionLabel(p) };
        bestDistance = d;
      }
    }
    if (best?.id !== nearest?.id || best?.label !== nearest?.label) {
      nearest = best;
      onNear(best);
    } else nearest = best;
  }
  function positionCamera(dt, snap = false) {
    follow.set(player.position.x, player.position.y + 1.15, player.position.z);
    function safeDistanceAt(angle, elevation) {
      direction
        .set(
          Math.sin(angle) * Math.cos(elevation),
          Math.sin(elevation),
          Math.cos(angle) * Math.cos(elevation),
        )
        .normalize();
      cameraRay.set(follow, direction);
      let safe = distance;
      for (const b of cameraSolids) {
        tempBox.min.set(b.x - b.w - 0.1, b.bottom ?? topY, b.z - b.d - 0.1);
        tempBox.max.set(b.x + b.w + 0.1, b.top, b.z + b.d + 0.1);
        const hit = cameraRay.intersectBox(tempBox, probe);
        if (hit)
          safe = Math.min(safe, Math.max(0.7, follow.distanceTo(hit) - 0.27));
      }
      return safe;
    }
    let safeDistance = safeDistanceAt(yaw, pitch),
      avoided = false;
    // If a tree or wall would force the camera into the avatar, find a clear side view.
    // Keep the chosen yaw so forward movement still follows the actual camera.
    if (safeDistance < 2.8) {
      const originalYaw = yaw;
      let candidate = null;
      for (const offset of [0.5, -0.5, 1, -1, 1.5, -1.5, 2.1, -2.1, Math.PI]) {
        const angle = originalYaw + offset,
          safe = safeDistanceAt(angle, pitch);
        if (safe >= Math.min(distance, 3.2)) {
          candidate = { angle, safe };
          break;
        }
      }
      if (candidate) {
        yaw = candidate.angle;
        safeDistance = candidate.safe;
        avoided = true;
      }
    }
    direction
      .set(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      )
      .normalize();
    desired.copy(follow).addScaledVector(direction, safeDistance);
    desired.y = Math.max(desired.y, topY + 0.3);
    const blend =
      snap || avoided || getReducedMotion() || safeDistance < distance - 0.1
        ? 1
        : 1 - Math.exp(-12 * dt);
    camera.position.lerp(desired, blend);
    camera.lookAt(follow);
    container.dataset.cameraDistance = safeDistance.toFixed(2);
  }
  function resetPosition() {
    player.position.set(0, topY + 0.02, 6.8);
    player.rotation.y = Math.PI;
    verticalSpeed = 0;
    grounded = true;
    yaw = 0.06;
    pitch = 0.33;
    clearInput();
    positionCamera(0.016, true);
  }
  positionCamera(0.016, true);
  function render(t) {
    frame = requestAnimationFrame(render);
    const dt = Math.min((t - lastTime) / 1000, 0.033) || 0.016;
    lastTime = t;
    const paused = getPaused();
    if (paused && !wasPaused) clearInput();
    wasPaused = paused;
    if (!paused) {
      const d = keyDirection();
      sprint = keys.has("shift");
      const speed = sprint ? 4.2 : 2.65;
      const response = 1 - Math.exp(-18 * dt);
      velocity.lerp(new THREE.Vector2(d.x * speed, d.z * speed), response);
      move(velocity.x * dt, velocity.y * dt);
      const before = player.position.y;
      verticalSpeed -= 14.5 * dt;
      player.position.y += verticalSpeed * dt;
      const floor = groundAt(player.position.x, player.position.z, before);
      if (player.position.y <= floor && verticalSpeed <= 0) {
        player.position.y = floor;
        verticalSpeed = 0;
        grounded = true;
      } else grounded = false;
      if (player.position.y < -3) {
        resetPosition();
        onMessage?.("A soft landing back at the dock. Let’s try that again.");
      }
      const moving = velocity.length() > 0.12;
      if (moving) {
        const angle = Math.atan2(velocity.x, velocity.y);
        player.rotation.y +=
          Math.atan2(
            Math.sin(angle - player.rotation.y),
            Math.cos(angle - player.rotation.y),
          ) * Math.min(1, dt * 15);
        walkCycle += dt * (sprint ? 13 : 9);
      }
      const motion = !getReducedMotion();
      limbs.forEach(
        (leg, i) =>
          (leg.rotation.x =
            motion && moving && grounded
              ? Math.sin(walkCycle + i * Math.PI) * 0.55
              : grounded
                ? 0
                : -0.25),
      );
      arms.forEach(
        (arm, i) =>
          (arm.rotation.x =
            motion && moving && grounded
              ? -Math.sin(walkCycle + i * Math.PI) * 0.5
              : grounded
                ? 0
                : -0.65),
      );
      if (t < currentActionUntil && motion) arms[1].rotation.x = -0.85;
      body.position.y =
        motion && moving && grounded ? Math.sin(walkCycle * 2) * 0.045 : 0;
      findNearest();
      stars.forEach((star, i) => {
        if (!star.visible) return;
        const p = platforms[i];
        if (
          Math.hypot(player.position.x - p.x, player.position.z - p.z) < 0.58 &&
          Math.abs(player.position.y - (topY + p.h)) < 0.5
        )
          onAction(`star-${i}`);
      });
    }
    positionCamera(dt);
    if (!getReducedMotion() && !paused) {
      stars.forEach((star, i) => {
        star.rotation.z = t * 0.0015;
        star.position.y =
          topY + platforms[i].h + 0.63 + Math.sin(t * 0.002 + i) * 0.06;
      });
      codiNPC.position.y = topY + Math.sin(t * 0.0018) * 0.025;
      codiWave.rotation.z = -0.45 + Math.sin(t * 0.002) * 0.1;
      butterflies.forEach((b, i) => {
        b.position.y = 2 + Math.sin(t * 0.0017 + i) * 0.35;
        b.position.x = 5 + Math.sin(t * 0.0004 + i * 3) * 2;
        b.rotation.y = t * 0.002 + i;
        b.children[0].rotation.y = Math.sin(t * 0.03) * 0.8;
      });
      flag.rotation.y = Math.sin(t * 0.001) * 0.12;
    }
    if (hudDirty) {
      const origin = container.getBoundingClientRect();
      hudBounds = hudElements.map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top }));
      hudDirty = false;
    }
    placedLabels = [];
    for (const p of mapLabels) {
      if (p.range && Math.hypot(p.x - player.position.x, p.z - player.position.z) > p.range)
        p.el.hidden = true;
      else labelAt(p.el, p.x, p.y + topY, p.z);
    }
    const target =
      interactions.find((p) => p.id === trackedTarget) || interactions.at(-1);
    labelAt(marker, target.x, topY + target.y + 0.65, target.z);
    const dist = Math.hypot(
      target.x - player.position.x,
      target.z - player.position.z,
    );
    document.getElementById("bearing-title").textContent = target.name;
    document.getElementById("bearing-distance").textContent =
      `${Math.round(dist)} m`;
    const relative =
      Math.atan2(
        target.x - player.position.x,
        -(target.z - player.position.z),
      ) + yaw;
    document.getElementById("bearing-arrow").style.transform =
      `rotate(${relative}rad)`;
    container.dataset.playerX = player.position.x.toFixed(2);
    container.dataset.playerY = player.position.y.toFixed(2);
    container.dataset.playerZ = player.position.z.toFixed(2);
    container.dataset.cameraYaw = yaw.toFixed(2);
    container.dataset.grounded = String(grounded);
    container.dataset.nearby = nearest?.id || "";
    container.dataset.cameraMode = "third-person";
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(render);
  document.getElementById("world-loading").classList.add("done");
  return {
    visitNearest: useNearest,
    setObjective(id) {
      trackedTarget = id;
    },
    updateProgress(state) {
      currentState = state;
      sprouts.forEach((s) =>
        s.scale.setScalar(
          state.gardenStep === 0 ? 0.08 : state.gardenStep === 1 ? 0.45 : 1.35,
        ),
      );
      tool.visible = !state.hasWateringCan;
      heldCan.visible = state.hasWateringCan && state.gardenStep < 3;
      basket.visible =
        state.gardenStep === 3 && !state.completed.includes("garden");
      stars.forEach(
        (star, i) => (star.visible = !state.collectibles.includes(`star-${i}`)),
      );
      stationPads.forEach((pad, i) => {
        pad.material = mat(
          i < state.planStep
            ? "#a9d89c"
            : ["#eac48d", "#c7b7dd", "#9fcabb", "#ecd88f"][i],
        );
      });
    },
    resetPosition,
    getPosition() {
      return {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
      };
    },
    destroy() {
      cancelAnimationFrame(frame);
      events.abort();
      observer.disconnect();
      labelObserver.disconnect();
      scene.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      labels.replaceChildren();
    },
  };
}
