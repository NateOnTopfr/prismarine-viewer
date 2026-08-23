const THREE = require('three')
const TWEEN = require('@tweenjs/tween.js')

const Entity = require('./entity/Entity')
const { dispose3 } = require('./dispose')

const { createCanvas } = require('canvas')

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

function getEntityMesh (entity, scene) {
  let mesh
  if (entity.name) {
    try {
      const e = new Entity('1.16.4', ENTITY_ALIASES[entity.name] || entity.name, scene)
      mesh = e.mesh
    } catch (err) {
      console.log(err)
    }
  }

  if (!mesh) {
    // No model for this entity type (a display entity, or a mob still absent from the
    // bundled data). Render a placeholder box sized to the entity's hitbox, tinted a
    // stable muted colour hashed from the name — a distinguishable stand-in, not a
    // garish magenta cube.
    const w = entity.width || 0.6
    const h = entity.height || 1.8
    const geometry = new THREE.BoxGeometry(w, Math.max(0.1, h), w)
    geometry.translate(0, h / 2, 0)
    const material = new THREE.MeshLambertMaterial({ color: nameColor(entity.name || 'entity') })
    mesh = new THREE.Mesh(geometry, material)
  }

  // Label: player username, or custom name / hologram text (metadata-derived).
  const label = entity.username !== undefined ? entity.username : entity.customName
  if (label) {
    const sprite = makeTextSprite(label, entity.height)
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
        mesh = getEntityMesh(entity, this.scene)
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
