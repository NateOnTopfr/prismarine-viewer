// Blockbench (.bbmodel) loader → a THREE.Object3D. Blockbench is the universal authoring format for
// Minecraft custom content (ItemsAdder, ModelEngine, MythicMobs/MythicArmors), so rendering the
// SOURCE .bbmodel is the faithful, tractable way to show detailed custom armor/items — far simpler
// than decoding a packed objmc runtime atlas, and it is the real geometry the artist made.
//
// Supports per-face-UV cubes (box_uv:false) and box-UV cubes (box_uv:true), element rotations about
// their origin, the outliner bone hierarchy (group pivots/rotations), and the embedded texture
// (first texture's data: URL). Model units are 1/16 block; Blockbench Y is up (same as MC/three).
const THREE = require('three')
const { createCanvas, Image } = require('canvas')

// Blockbench cube face name → the THREE BoxGeometry material-group face index.
// BoxGeometry groups are ordered: 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z.
// MC/Blockbench: east=+X, west=-X, up=+Y, down=-Y, south=+Z, north=-Z.
const FACE_TO_BOX = { east: 0, west: 1, up: 2, down: 3, south: 4, north: 5 }

function texFromDataUrl (src) {
  try {
    const comma = src.indexOf(',')
    const buf = Buffer.from(src.slice(comma + 1), 'base64')
    const img = new Image(); img.src = buf
    const c = createCanvas(img.width || 16, img.height || 16)
    c.getContext('2d').drawImage(img, 0, 0)
    const tex = new THREE.Texture(c)
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter
    tex.flipY = false; tex.needsUpdate = true // MC UV origin is top-left → flipY off
    return tex
  } catch { return null }
}

// Set the 6 per-face UVs on a BoxGeometry (non-indexed after toNonIndexed) from Blockbench faces.
// three's BoxGeometry has 24 uv pairs (4 per face) in group order +X,-X,+Y,-Y,+Z,-Z; each face's
// 4 verts are ordered [topLeft, topRight, bottomLeft, bottomRight] in three's local face frame.
function applyCubeUV (geo, faces, texW, texH) {
  const uv = geo.attributes.uv
  // three per-face vertex order (for the 4 corners of each face) — indices into the 4-uv block:
  //   v0=(0,1) v1=(1,1) v2=(0,0) v3=(1,0)  i.e. TL,TR,BL,BR
  const order = ['north', 'east', 'south', 'west', 'up', 'down']
  // map from box-group index → face name
  const boxToFace = { 0: 'east', 1: 'west', 2: 'up', 3: 'down', 4: 'south', 5: 'north' }
  for (let g = 0; g < 6; g++) {
    const face = faces[boxToFace[g]]
    const base = g * 4
    if (!face || !face.uv) { // no face → collapse UVs (draw nothing meaningful)
      for (let k = 0; k < 4; k++) uv.setXY(base + k, 0, 0)
      continue
    }
    let [x1, y1, x2, y2] = face.uv
    // to 0..1, top-left origin (flipY already false)
    const u1 = x1 / texW; const v1 = y1 / texH; const u2 = x2 / texW; const v2 = y2 / texH
    // three face corners: TL,TR,BL,BR  → (u1,v1),(u2,v1),(u1,v2),(u2,v2)
    let c = [[u1, v1], [u2, v1], [u1, v2], [u2, v2]]
    // Blockbench face UV rotation (0/90/180/270) rotates the corner assignment
    const rot = ((face.rotation || 0) % 360 + 360) % 360
    for (let r = 0; r < rot; r += 90) c = [c[2], c[0], c[3], c[1]]
    for (let k = 0; k < 4; k++) uv.setXY(base + k, c[k][0], c[k][1])
  }
  uv.needsUpdate = true
}

// Box-UV mode (box_uv:true): a cube's 6 faces are one unwrapped cross at uv offset [ox,oy], sized by
// the cube dims (w,h,d). Synthesize the per-face rects from the standard Blockbench/MC layout, then
// reuse applyCubeUV. This is how vanilla-style entity models (and some ItemsAdder content) map.
function boxUVFaces (el, texW, texH) {
  const [x1, y1, z1] = el.from; const [x2, y2, z2] = el.to
  const w = Math.round(Math.abs(x2 - x1)); const h = Math.round(Math.abs(y2 - y1)); const d = Math.round(Math.abs(z2 - z1))
  const off = el.uv_offset || el.uv || [0, 0]
  const ox = off[0] || 0; const oy = off[1] || 0
  return {
    up: { uv: [ox + d, oy, ox + d + w, oy + d] },
    down: { uv: [ox + d + w, oy + d, ox + d + 2 * w, oy] },
    east: { uv: [ox, oy + d, ox + d, oy + d + h] },
    north: { uv: [ox + d, oy + d, ox + d + w, oy + d + h] },
    west: { uv: [ox + d + w, oy + d, ox + d + w + d, oy + d + h] },
    south: { uv: [ox + d + w + d, oy + d, ox + d + 2 * w + d, oy + d + h] }
  }
}

// A mesh element (type:"mesh"): free-form vertices + polygonal faces with per-vertex UVs. Triangulate
// (fan) each face into a BufferGeometry. Covers ItemsAdder/ModelEngine content that isn't just cubes.
function buildMeshElement (el, mat) {
  const verts = el.vertices || {}
  const faces = el.faces || {}
  const pos = []; const uvs = []
  for (const fid of Object.keys(faces)) {
    const f = faces[fid]
    const vids = f.vertices || []
    if (vids.length < 3) continue
    const fuv = f.uv || {}
    const P = (vid) => { const v = verts[vid]; return v ? [v[0] * S, v[1] * S, v[2] * S] : [0, 0, 0] }
    const UV = (vid) => { const u = fuv[vid]; return u ? [u[0] / (el._texW || 16), u[1] / (el._texH || 16)] : [0, 0] }
    for (let i = 1; i < vids.length - 1; i++) { // fan triangulation
      for (const vid of [vids[0], vids[i], vids[i + 1]]) { const p = P(vid); pos.push(p[0], p[1], p[2]); const t = UV(vid); uvs.push(t[0], t[1]) }
    }
  }
  if (!pos.length) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, mat)
}

const D2R = Math.PI / 180
const S = 1 / 16 // model units → blocks

function buildElement (el, mat, texW, texH) {
  if (el.type === 'mesh') { // free-form mesh geometry
    el._texW = texW; el._texH = texH
    const m = buildMeshElement(el, mat)
    if (m && el.rotation && (el.rotation[0] || el.rotation[1] || el.rotation[2]) && el.origin) {
      const pivot = new THREE.Group(); pivot.position.set(el.origin[0] * S, el.origin[1] * S, el.origin[2] * S)
      pivot.rotation.set((el.rotation[0] || 0) * D2R, (el.rotation[1] || 0) * D2R, (el.rotation[2] || 0) * D2R)
      m.position.sub(pivot.position); pivot.add(m); return pivot
    }
    return m
  }
  if (el.type && el.type !== 'cube') return null // locators/nulls have no geometry
  const [x1, y1, z1] = el.from
  const [x2, y2, z2] = el.to
  const inf = (el.inflate || 0)
  const w = Math.abs(x2 - x1) + 2 * inf
  const h = Math.abs(y2 - y1) + 2 * inf
  const d = Math.abs(z2 - z1) + 2 * inf
  // A zero-thickness cube would render nothing; give it a sliver so planes still show.
  const geo = new THREE.BoxGeometry(Math.max(w, 0.01) * S, Math.max(h, 0.01) * S, Math.max(d, 0.01) * S)
  if (el.box_uv) applyCubeUV(geo, boxUVFaces(el, texW, texH), texW, texH)
  else if (el.faces) applyCubeUV(geo, el.faces, texW, texH)
  const mesh = new THREE.Mesh(geo, mat)
  const cx = (x1 + x2) / 2; const cy = (y1 + y2) / 2; const cz = (z1 + z2) / 2
  mesh.position.set(cx * S, cy * S, cz * S)
  // Element rotation about its own origin (pivot), in degrees around X/Y/Z.
  if (el.rotation && (el.rotation[0] || el.rotation[1] || el.rotation[2])) {
    const o = el.origin || [cx, cy, cz]
    const pivot = new THREE.Group()
    pivot.position.set(o[0] * S, o[1] * S, o[2] * S)
    mesh.position.sub(pivot.position) // re-express mesh center relative to pivot
    pivot.rotation.set((el.rotation[0] || 0) * D2R, (el.rotation[1] || 0) * D2R, (el.rotation[2] || 0) * D2R)
    pivot.add(mesh)
    return pivot
  }
  return mesh
}

/**
 * Build a THREE.Object3D from a parsed .bbmodel JSON. `opts.only` (a lowercase substring) keeps only
 * outliner bones whose name matches — e.g. 'head' to extract just a helmet's head group. Returns the
 * group in block space (1 unit = 1 block); the caller positions/scales/attaches it.
 */
function buildBBModel (json, opts = {}) {
  const res = json.resolution || { width: 16, height: 16 }
  const texW = res.width || 16; const texH = res.height || 16
  const texEntry = (json.textures || [])[0]
  const tex = texEntry && texEntry.source ? texFromDataUrl(texEntry.source) : null
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })

  // Index elements by uuid so the outliner can group them; elements not in the outliner still render.
  const byId = {}
  for (const el of (json.elements || [])) byId[el.uuid] = el

  const root = new THREE.Object3D()
  const wanted = opts.only ? String(opts.only).toLowerCase() : null

  // Recursively realise an outliner node (a group with pivot/rotation, or an element uuid string).
  const placed = new Set()
  const realise = (node, parent, keep) => {
    if (typeof node === 'string') {
      const el = byId[node]; if (!el) return
      const m = buildElement(el, mat, texW, texH); if (m) { parent.add(m); placed.add(node) }
      return
    }
    const keepHere = keep || (wanted ? String(node.name || '').toLowerCase().includes(wanted) : true)
    const g = new THREE.Group()
    const o = node.origin || [0, 0, 0]
    g.position.set(o[0] * S, o[1] * S, o[2] * S)
    if (node.rotation) g.rotation.set((node.rotation[0] || 0) * D2R, (node.rotation[1] || 0) * D2R, (node.rotation[2] || 0) * D2R)
    // children are positioned in absolute model space, so counter-translate by the pivot
    const inner = new THREE.Group(); inner.position.set(-o[0] * S, -o[1] * S, -o[2] * S)
    g.add(inner)
    for (const child of (node.children || [])) realise(child, inner, keepHere)
    if (keepHere && (inner.children.length)) parent.add(g)
  }

  if (json.outliner && json.outliner.length) {
    for (const node of json.outliner) realise(node, root, wanted ? false : true)
    // Elements not referenced by the outliner (rare) — add them directly unless filtering.
    if (!wanted) for (const el of (json.elements || [])) if (!placed.has(el.uuid)) { const m = buildElement(el, mat, texW, texH); if (m) root.add(m) }
  } else {
    for (const el of (json.elements || [])) { const m = buildElement(el, mat, texW, texH); if (m) root.add(m) }
  }
  return root
}

module.exports = { buildBBModel }
