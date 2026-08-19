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

function getEntityMesh (entity, scene) {
  if (entity.name) {
    try {
      const e = new Entity('1.16.4', ENTITY_ALIASES[entity.name] || entity.name, scene)

      if (entity.username !== undefined) {
        const canvas = createCanvas(500, 100)

        const ctx = canvas.getContext('2d')
        ctx.font = '50pt Arial'
        ctx.fillStyle = '#000000'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'

        const txt = entity.username
        ctx.fillText(txt, 100, 0)

        const tex = new THREE.Texture(canvas)
        tex.needsUpdate = true
        const spriteMat = new THREE.SpriteMaterial({ map: tex })
        const sprite = new THREE.Sprite(spriteMat)
        sprite.position.y += entity.height + 0.6

        e.mesh.add(sprite)
      }
      return e.mesh
    } catch (err) {
      console.log(err)
    }
  }

  // No model for this entity type (e.g. a 1.17+ mob absent from the bundled 1.16
  // entity data). Render a placeholder box sized to the entity's hitbox, tinted a
  // stable muted colour hashed from the name — so it's a sensible, distinguishable
  // stand-in for gameplay-test screenshots, not a garish magenta cube.
  const w = entity.width || 0.6
  const h = entity.height || 1.8
  const geometry = new THREE.BoxGeometry(w, h, w)
  geometry.translate(0, h / 2, 0)
  const material = new THREE.MeshLambertMaterial({ color: nameColor(entity.name || 'entity') })
  return new THREE.Mesh(geometry, material)
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
