import * as THREE from 'three';

// Glass grows outward: fish, floor projection and saved decor coordinates keep
// exactly the same interior. The open top is not an invisible sixth panel.
export const GLASS_THICKNESS = 0.045;
export const SUBSTRATE_DEPTH = 0.1;

function studioReflection() {
  // Local, deterministic softboxes; no downloaded environment or render service.
  const width = 256, height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width, v = y / height;
      const softbox = Math.exp(-Math.pow((u - 0.24) / 0.035, 4))
        * Math.exp(-Math.pow((v - 0.42) / 0.28, 8));
      const window = Math.exp(-Math.pow((u - 0.72) / 0.08, 8))
        * Math.exp(-Math.pow((v - 0.36) / 0.2, 8));
      const base = 55 + 65 * (1 - v);
      const light = Math.min(255, base + softbox * 150 + window * 110);
      const i = (y * width + x) * 4;
      data[i] = Math.round(light * 0.97);
      data[i + 1] = Math.round(light);
      data[i + 2] = Math.round(light * 0.98);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function createGlassTank(tank, { quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'glass-tank';
  const t = GLASS_THICKNESS, soil = SUBSTRATE_DEPTH;
  const w = tank.width, d = tank.depth, h = tank.height;
  const reflection = quality === 'high' ? studioReflection() : null;
  const pane = quality === 'high'
    ? new THREE.MeshPhysicalMaterial({
      color: '#e5f7ed', roughness: 0.07, metalness: 0,
      transparent: true, opacity: 0.055, ior: 1.5,
      clearcoat: 1, clearcoatRoughness: 0.05,
      // Keep the contents crisp: no extra offscreen transmission pass and no
      // second tone mapping of the fish through the front pane.
      envMap: reflection, envMapIntensity: 0.8,
      depthWrite: false, fog: false
    })
    : new THREE.MeshBasicMaterial({
      color: '#b9e0d4', transparent: true, opacity: 0.045,
      depthWrite: false
    });
  // Cut faces catch more light than broad faces. Real box geometry provides
  // visible thickness at the rim and corners, even in the inexpensive mode.
  const cut = new THREE.MeshStandardMaterial({
    color: '#81b3a2', roughness: 0.2, metalness: 0.08,
    transparent: true, opacity: 0.48, depthWrite: false,
    envMap: reflection, envMapIntensity: 0.7
  });
  const seam = new THREE.MeshBasicMaterial({
    color: '#6f9e8d', transparent: true, opacity: 0.3, depthWrite: false
  });
  const glint = new THREE.MeshBasicMaterial({
    color: '#f5fff9', transparent: true, opacity: 0.63, depthWrite: false
  });
  const panels = [];
  function box(name, size, position, material, order = 6) {
    const geometry = new THREE.BoxGeometry(...size);
    if (Array.isArray(material)) {
      const faces = geometry.groups.map(face => ({ ...face }));
      geometry.clearGroups();
      for (const face of faces) {
        const previous = geometry.groups.at(-1);
        if (previous && material[previous.materialIndex] === material[face.materialIndex]) {
          previous.count += face.count;
        } else geometry.addGroup(face.start, face.count, face.materialIndex);
      }
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.renderOrder = order;
    group.add(mesh);
    return mesh;
  }
  for (const [name, z] of [['front', d / 2 + t / 2], ['back', -d / 2 - t / 2]]) {
    panels.push(box(name, [w + 2 * t, h + soil, t], [0, (h - soil) / 2, z],
      [cut, cut, cut, cut, pane, pane]));
  }
  for (const [name, x] of [['left', -w / 2 - t / 2], ['right', w / 2 + t / 2]]) {
    panels.push(box(name, [t, h + soil, d], [x, (h - soil) / 2, 0],
      [pane, pane, cut, cut, cut, cut]));
  }
  panels.push(box('bottom', [w + 2 * t, t, d + 2 * t], [0, -soil - t / 2, 0],
    [cut, cut, pane, pane, cut, cut]));

  // Narrow silicone joins, polished rim highlights and the exposed substrate
  // make the tank readable without a heavy metal frame or an opaque front.
  for (const x of [-w / 2, w / 2]) {
    for (const z of [-d / 2, d / 2]) {
      box('silicone-join', [0.012, h + soil, 0.012], [x, (h - soil) / 2, z], seam, 7);
    }
    box('rim-highlight', [0.006, 0.006, d], [x + Math.sign(x) * t * 0.7, h + 0.002, 0], glint, 8);
  }
  for (const z of [-d / 2, d / 2]) {
    box('rim-highlight', [w + t, 0.006, 0.006], [0, h + 0.002, z + Math.sign(z) * t * 0.7], glint, 8);
    box('waterline', [w, 0.006, 0.005], [0, tank.waterY, z - Math.sign(z) * 0.005], glint, 5);
  }
  box('substrate', [w, soil, d], [0, -soil / 2, 0],
    new THREE.MeshStandardMaterial({ color: '#baac8d', roughness: 0.98 }), 0);
  box('base-pad', [w + 2 * t + 0.025, 0.035, d + 2 * t + 0.025],
    [0, -soil - t - 0.0175, 0], new THREE.MeshStandardMaterial({ color: '#d6d8cc', roughness: 0.8 }), 0);

  function setNight(night) {
    cut.color.set('#81b3a2').lerp(new THREE.Color('#376473'), night);
    seam.color.set('#6f9e8d').lerp(new THREE.Color('#31515e'), night);
    glint.color.set('#f5fff9').lerp(new THREE.Color('#9dc8df'), night);
    glint.opacity = 0.63 - night * 0.25;
    if (reflection) pane.envMapIntensity = 0.8 - night * 0.55;
    else pane.color.set('#b9e0d4').lerp(new THREE.Color('#4a798a'), night);
    cut.envMapIntensity = 0.7 - night * 0.45;
  }
  return { group, panels, setNight };
}
