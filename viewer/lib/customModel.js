/* global THREE */
// Build a THREE mesh from a resource-pack custom ITEM model (ItemsAdder / CustomModelData) —
// standard Minecraft element models with custom textures. Used to render an item entity's real
// custom appearance (weapons, cosmetics, ores, …) instead of the flat vanilla billboard.
//
// `model` is the shape produced by NovaMCP's resourcepack.ts loadItemModel():
//   { elements:[{from,to,rotation?,faces:{dir:{uv,texture}}}], resolvedTextures:{slot: absPngPath},
//     textureSize:[w,h] }
// `loadTex(absPngPath)` must return a THREE.Texture (or null). Kept injectable so the caller
// picks the loader (pngjs→DataTexture in node, etc.).

const THREE_ = (typeof THREE !== 'undefined') ? THREE : require('three')

// BoxGeometry material/group order: +x,-x,+y,-y,+z,-z
const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north']

function buildCustomItemMesh (model, loadTex) {
  if (!model || !Array.isArray(model.elements)) return null
  const group = new THREE_.Object3D()
  const tw = (model.textureSize && model.textureSize[0]) || 16
  const th = (model.textureSize && model.textureSize[1]) || 16
  const matCache = {}
  const matFor = (path) => {
    const key = path || '_'
    if (matCache[key]) return matCache[key]
    const tex = path ? loadTex(path) : null
    const m = new THREE_.MeshLambertMaterial({ map: tex || null, transparent: true, alphaTest: 0.25, color: tex ? 0xffffff : 0xb0b0b0, side: THREE_.DoubleSide })
    matCache[key] = m
    return m
  }
  for (const el of model.elements) {
    if (!el.from || !el.to) continue
    const f = el.from, t = el.to
    const sx = Math.max(0.0015, (t[0] - f[0]) / 16)
    const sy = Math.max(0.0015, (t[1] - f[1]) / 16)
    const sz = Math.max(0.0015, (t[2] - f[2]) / 16)
    const geo = new THREE_.BoxGeometry(sx, sy, sz)
    const uv = geo.attributes.uv
    const mats = []
    FACE_ORDER.forEach((dir, fi) => {
      const face = el.faces && el.faces[dir]
      let path = null
      if (face) {
        const slot = String(face.texture || '').replace('#', '')
        path = model.resolvedTextures[slot] || Object.values(model.resolvedTextures)[0] || null
        if (face.uv) {
          const [u1, v1, u2, v2] = face.uv
          uv.setXY(fi * 4 + 0, u1 / tw, v1 / th); uv.setXY(fi * 4 + 1, u2 / tw, v1 / th)
          uv.setXY(fi * 4 + 2, u1 / tw, v2 / th); uv.setXY(fi * 4 + 3, u2 / tw, v2 / th)
        }
      }
      mats.push(matFor(path))
    })
    uv.needsUpdate = true
    const mesh = new THREE_.Mesh(geo, mats)
    const cx = (f[0] + t[0]) / 2 / 16, cy = (f[1] + t[1]) / 2 / 16, cz = (f[2] + t[2]) / 2 / 16
    if (el.rotation && el.rotation.angle) {
      const o = el.rotation.origin || [8, 8, 8]
      const pivot = new THREE_.Object3D()
      pivot.position.set(o[0] / 16, o[1] / 16, o[2] / 16)
      mesh.position.set(cx - o[0] / 16, cy - o[1] / 16, cz - o[2] / 16)
      pivot.rotation[el.rotation.axis || 'y'] = (el.rotation.angle * Math.PI) / 180
      pivot.add(mesh)
      group.add(pivot)
    } else {
      mesh.position.set(cx, cy, cz)
      group.add(mesh)
    }
  }
  // Item models are authored in a 0..16 (block) space; the group sits in that frame. Callers
  // recentre/scale as needed for the entity.
  return group
}

module.exports = { buildCustomItemMesh }
