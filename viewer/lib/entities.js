const THREE = require('three')
const TWEEN = require('@tweenjs/tween.js')
const fs = require('fs')
const path = require('path')

const Entity = require('./entity/Entity')
const { dispose3 } = require('./dispose')

const { createCanvas, Image } = require('canvas')

// --- id/texture resolution for display + item entities (block_display, item_display,
// dropped items, item frames). Resolves numeric ids to names with minecraft-data at the
// RENDER version (ids are version-specific), and loads textures from minecraft-assets
// (nearest available; item/block textures are stable across a major). Cached; best-effort. ---
const _mcd = {}
function mcData (version) {
  if (_mcd[version] !== undefined) return _mcd[version]
  try { _mcd[version] = require('minecraft-data')(version) } catch { _mcd[version] = null }
  return _mcd[version]
}
const _assets = {}
function assetsDir (version) {
  if (_assets[version] !== undefined) return _assets[version]
  for (const v of [version, '1.21.1', '1.20.1', '1.19.4']) {
    try { _assets[version] = require('minecraft-assets')(v).directory; return _assets[version] } catch { /* try next */ }
  }
  _assets[version] = null
  return null
}
const _texCache = {}
function loadTextureSync (file) {
  if (_texCache[file] !== undefined) return _texCache[file]
  try {
    const img = new Image()
    img.src = fs.readFileSync(file) // node-canvas: Buffer src is synchronous
    const c = createCanvas(img.width || 16, img.height || 16)
    c.getContext('2d').drawImage(img, 0, 0)
    const tex = new THREE.Texture(c)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.needsUpdate = true
    _texCache[file] = tex
  } catch { _texCache[file] = null }
  return _texCache[file]
}
function firstExisting (dir, subs, name) {
  if (!dir || !name) return null
  for (const s of subs) { const f = path.join(dir, s, name + '.png'); if (fs.existsSync(f)) return f }
  return null
}
function itemTexture (version, itemId) {
  const d = mcData(version); if (!d) return null
  const it = d.items && d.items[itemId]
  if (!it) return null
  const f = firstExisting(assetsDir(version), ['items', 'item'], it.name)
  return f ? loadTextureSync(f) : null
}
function blockTexture (version, stateId) {
  const d = mcData(version); if (!d) return null
  const b = d.blocksByStateId && d.blocksByStateId[stateId]
  if (!b) return null
  const dir = assetsDir(version)
  // texture file usually matches the block name; try a couple of common variants.
  for (const n of [b.name, b.name + '_top', b.name.replace(/s$/, '')]) {
    const f = firstExisting(dir, ['blocks', 'block'], n)
    if (f) return loadTextureSync(f)
  }
  return null
}

// Most 1.17+ mob geometry was added to entities.json by scripts/gen-missing-entities.mjs
// (warden, allay, frog, camel, sniffer, breeze, armadillo, axolotl, goat, tadpole,
// creaking — real Bedrock geometry + Java textures). ENTITY_ALIASES still covers mobs
// that reuse an existing model (a trader llama IS a llama) rather than shipping their
// own bones. Anything still without a model falls through to the placeholder box below.
const ENTITY_ALIASES = {
  trader_llama: 'llama',
  glow_squid: 'squid',
  illusioner: 'pillager'
}

// A billboarded text label (player username OR custom name / hologram text). Reused so
// holograms (armor stands / named entities) actually show their text, not just a box.
function makeTextSprite (text, height) {
  const clean = String(text).replace(/§./g, '').replace(/^"([\s\S]*)"$/, '$1') // strip §-codes + wrapping quotes
  if (!clean.trim()) return null
  const pad = 16
  const probe = createCanvas(8, 8).getContext('2d')
  probe.font = '48pt Arial'
  const w = Math.min(1200, Math.ceil(probe.measureText(clean).width) + pad * 2)
  const canvas = createCanvas(w, 80)
  const ctx = canvas.getContext('2d')
  ctx.font = '48pt Arial'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // outline for legibility against any background
  ctx.lineWidth = 8
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(clean, w / 2, 44)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(clean, w / 2, 44)
  const tex = new THREE.Texture(canvas)
  tex.needsUpdate = true
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  sprite.scale.set((w / 80) * 0.5, 0.5, 1) // keep aspect; ~0.5 block tall
  sprite.position.y += (height || 1.8) + 0.5
  return sprite
}

function getEntityMesh (entity, scene, version) {
  let mesh

  // Item entities (item_display, dropped item, item/glow_item_frame) → billboarded item texture.
  if (entity.item != null) {
    const tex = itemTexture(version, entity.item)
    if (tex) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.4 }))
      sprite.scale.set(0.7, 0.7, 0.7)
      sprite.position.y += (entity.name === 'item' ? 0.25 : (entity.height || 0.5) * 0.5) + 0.1
      mesh = new THREE.Object3D()
      mesh.add(sprite)
    }
  }

  // block_display → the actual block as a (scaled) textured cube, anchored at its corner.
  if (!mesh && entity.blockStateId != null) {
    const tex = blockTexture(version, entity.blockStateId)
    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(0.5, 0.5, 0.5)
    const mat = tex ? new THREE.MeshLambertMaterial({ map: tex })
      : new THREE.MeshLambertMaterial({ color: nameColor(String(entity.blockStateId)) })
    mesh = new THREE.Mesh(geo, mat)
    const s = entity.scale || {}
    mesh.scale.set(s.x || 1, s.y || 1, s.z || 1)
  }

  // text_display → just the floating text (no box).
  if (!mesh && entity.name === 'text_display') mesh = new THREE.Object3D()

  if (!mesh && entity.name) {
    try {
      const e = new Entity('1.16.4', ENTITY_ALIASES[entity.name] || entity.name, scene)
      mesh = e.mesh
    } catch (err) {
      console.log(err)
    }
  }

  if (!mesh) {
    // No model/content for this type — a placeholder box sized to the hitbox, tinted a
    // stable muted colour hashed from the name: a distinguishable stand-in, not magenta.
    const w = entity.width || 0.6
    const h = entity.height || 1.8
    const geometry = new THREE.BoxGeometry(w, Math.max(0.1, h), w)
    geometry.translate(0, h / 2, 0)
    const material = new THREE.MeshLambertMaterial({ color: nameColor(entity.name || 'entity') })
    mesh = new THREE.Mesh(geometry, material)
  }

  // Label: player username, or custom name / hologram / text_display text.
  const label = entity.username !== undefined ? entity.username : entity.customName
  if (label) {
    const sprite = makeTextSprite(label, entity.name === 'text_display' ? 0 : entity.height)
    if (sprite) mesh.add(sprite)
  }
  return mesh
}

// Stable muted colour from an entity name (HSL → RGB, mid saturation/lightness).
function nameColor (name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffff
  const hue = (hash % 360) / 360
  const s = 0.45
  const l = 0.55
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const r = Math.round(hue2rgb(p, q, hue + 1 / 3) * 255)
  const g = Math.round(hue2rgb(p, q, hue) * 255)
  const b = Math.round(hue2rgb(p, q, hue - 1 / 3) * 255)
  return (r << 16) | (g << 8) | b
}

class Entities {
  constructor (scene) {
    this.scene = scene
    this.entities = {}
    this.version = undefined
  }

  setVersion (version) {
    this.version = version
  }

  clear () {
    for (const mesh of Object.values(this.entities)) {
      this.scene.remove(mesh)
      dispose3(mesh)
    }
    this.entities = {}
  }

  update (entity) {
    if (!this.entities[entity.id]) {
      let mesh
      try {
        mesh = getEntityMesh(entity, this.scene, this.version)
      } catch (err) {
        // Unknown/unsupported entity type (no geometry in entities.json and no alias)
        // — skip it rather than crash the whole render.
        return
      }
      if (!mesh) return
      this.entities[entity.id] = mesh
      this.scene.add(mesh)
    }

    const e = this.entities[entity.id]

    if (entity.delete) {
      this.scene.remove(e)
      dispose3(e)
      delete this.entities[entity.id]
    }

    if (entity.pos) {
      new TWEEN.Tween(e.position).to({ x: entity.pos.x, y: entity.pos.y, z: entity.pos.z }, 50).start()
    }
    if (entity.yaw) {
      const da = (entity.yaw - e.rotation.y) % (Math.PI * 2)
      const dy = 2 * da % (Math.PI * 2) - da
      new TWEEN.Tween(e.rotation).to({ y: e.rotation.y + dy }, 50).start()
    }
  }
}

module.exports = { Entities }
