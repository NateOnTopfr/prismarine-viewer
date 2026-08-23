const THREE = require('three')
const TWEEN = require('@tweenjs/tween.js')
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

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

// --- Banner heraldry: composite the base cloth + each NBT pattern layer (tinted by its
// dye colour) onto one canvas, exactly like the vanilla BannerRenderer, so a banner shows
// its real pattern instead of a plain box. Data comes from block.blockEntity.patterns. ---
const DYE = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da,
  yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21
}
const _publicDir = path.resolve(__dirname, '../../public')
function _bannerLayer (ctx, file, colorHex) {
  try {
    const img = new Image(); img.src = fs.readFileSync(file)
    const w = img.width || 64, h = img.height || 64
    const tmp = createCanvas(w, h); const tctx = tmp.getContext('2d')
    tctx.drawImage(img, 0, 0)
    const data = tctx.getImageData(0, 0, w, h)
    const r = ((colorHex >> 16) & 255) / 255, g = ((colorHex >> 8) & 255) / 255, b = (colorHex & 255) / 255
    const px = data.data
    for (let i = 0; i < px.length; i += 4) { px[i] *= r; px[i + 1] *= g; px[i + 2] *= b }
    tctx.putImageData(data, 0, 0)
    ctx.drawImage(tmp, 0, 0)
  } catch { /* missing pattern texture — skip that layer */ }
}
function bannerTexture (version, baseColor, patterns) {
  const canvas = createCanvas(64, 64); const ctx = canvas.getContext('2d')
  const base = path.join(_publicDir, 'textures', version, 'entity')
  _bannerLayer(ctx, path.join(base, 'banner_base.png'), DYE[baseColor] !== undefined ? DYE[baseColor] : 0xffffff)
  for (const p of (patterns || [])) {
    const nm = String(p.pattern || '').replace(/^minecraft:/, '')
    if (!nm) continue
    const col = DYE[p.color] !== undefined ? DYE[p.color] : 0xffffff
    _bannerLayer(ctx, path.join(base, 'banner', nm + '.png'), col)
  }
  const tex = new THREE.Texture(canvas)
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter
  tex.flipY = false; tex.needsUpdate = true
  return tex
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

// A billboarded text label (player username / hologram / custom name / SIGN text). Handles
// multiple lines (split on \n) so signs show all four lines. Reused everywhere text floats.
function makeTextSprite (text, height) {
  const clean = String(text).replace(/§./g, '').replace(/^"([\s\S]*)"$/, '$1') // strip §-codes + wrapping quotes
  const lines = clean.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l.trim() || (i < a.length - 1))
  const nonEmpty = lines.filter((l) => l.trim())
  if (!nonEmpty.length) return null
  const fpt = 48; const lineH = 66; const pad = 16
  const probe = createCanvas(8, 8).getContext('2d')
  probe.font = `${fpt}pt Arial`
  const w = Math.min(1400, Math.max(...nonEmpty.map((l) => Math.ceil(probe.measureText(l).width))) + pad * 2)
  const h = lineH * nonEmpty.length + pad
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.font = `${fpt}pt Arial`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 8
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.fillStyle = '#ffffff'
  nonEmpty.forEach((line, i) => {
    const y = pad / 2 + lineH * (i + 0.5)
    ctx.strokeText(line, w / 2, y)
    ctx.fillText(line, w / 2, y)
  })
  const tex = new THREE.Texture(canvas)
  tex.needsUpdate = true
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  const sh = 0.28 * nonEmpty.length // ~0.28 block per line
  sprite.scale.set((w / h) * sh, sh, 1)
  sprite.position.y += (height || 1.8) + 0.5
  return sprite
}

// Extract sign text (all non-empty lines, joined by \n) from a mineflayer block.
function signTextOf (block) {
  if (!block) return null
  if (typeof block.signText === 'string' && block.signText.trim()) return block.signText.replace(/\n+$/, '')
  const be = block.blockEntity
  if (!be) return null
  const unwrap = (v) => (v && v.value !== undefined && typeof v.value !== 'string' ? v.value : v)
  const ft = unwrap(be.front_text) || unwrap(be && be.value && be.value.front_text)
  let msgs = ft && (ft.messages !== undefined ? unwrap(ft.messages) : undefined)
  if (msgs && msgs.value) msgs = msgs.value // nbt list wrapper
  const arr = Array.isArray(msgs) ? msgs : (Array.isArray(be.Text1 ? [be.Text1, be.Text2, be.Text3, be.Text4] : null) ? [be.Text1, be.Text2, be.Text3, be.Text4] : null)
  if (!Array.isArray(arr)) return null
  const flat = (m) => {
    let s = typeof m === 'string' ? m : (m && (m.value !== undefined ? m.value : m.text))
    if (typeof s !== 'string') return ''
    const t = s.trim()
    if (t.startsWith('{') || (t.startsWith('"') && t.endsWith('"'))) { try { const j = JSON.parse(t); return typeof j === 'string' ? j : (j.text || '') } catch { return s } }
    return s
  }
  const lines = arr.map(flat).map((s) => String(s).replace(/§./g, '').trimEnd())
  return lines.some((l) => l.trim()) ? lines.join('\n') : null
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

  // Find signs near `center` and float their text as billboarded labels — so shop/menu/
  // wayfinding signs are readable in a render. Uses bot.findBlocks (efficient) not a scan.
  addSignLabels (bot, center, radius) {
    if (!bot || !bot.findBlocks || !center) return
    let positions = []
    try {
      positions = bot.findBlocks({
        point: new Vec3(center[0], center[1], center[2]),
        matching: (b) => b && b.name && b.name.endsWith('sign'),
        maxDistance: Math.min(radius || 40, 64),
        count: 200
      })
    } catch (e) { return }
    for (const pos of positions) {
      const key = `sign:${pos.x},${pos.y},${pos.z}`
      if (this.entities[key]) continue
      let block
      try { block = bot.blockAt(pos) } catch { continue }
      const text = signTextOf(block)
      if (!text) continue
      const sprite = makeTextSprite(text, 0)
      if (!sprite) continue
      sprite.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
      this.entities[key] = sprite
      this.scene.add(sprite)
    }
  }

  // Block-entities that have a real (non-cube) model + entity texture — chests, etc. The world
  // mesher only draws them as a plain box, so here we overlay the true bedrock-geometry model
  // (base + lid + lock, textured with the entity texture) at each such block, oriented by facing.
  addBlockEntityModels (bot, center, radius) {
    if (!bot || !bot.findBlocks || !center) return
    const chests = new Set(['chest', 'trapped_chest', 'ender_chest'])
    const upright = new Set(['conduit', 'bell'])
    // Mob skulls → the mob's head cube. (player_head needs a skin fetch; dragon_head is a
    // multi-part model — both left as boxes for now.)
    const SKULL = {
      skeleton_skull: 'skeleton_skull', skeleton_wall_skull: 'skeleton_skull',
      wither_skeleton_skull: 'wither_skeleton_skull', wither_skeleton_wall_skull: 'wither_skeleton_skull',
      zombie_head: 'zombie_head', zombie_wall_head: 'zombie_head',
      creeper_head: 'creeper_head', creeper_wall_head: 'creeper_head',
      piglin_head: 'piglin_head', piglin_wall_head: 'piglin_head'
    }
    const isModeled = (n) => n && (chests.has(n) || upright.has(n) || SKULL[n] ||
      n === 'decorated_pot' || n.endsWith('shulker_box') || n.endsWith('_bed') || n.endsWith('banner'))
    let positions = []
    try {
      positions = bot.findBlocks({
        point: new Vec3(center[0], center[1], center[2]),
        matching: (b) => b && b.name && isModeled(b.name),
        maxDistance: Math.min(radius || 40, 64),
        count: 200
      })
    } catch (e) { return }
    // Model front (the lock) is on the -Z / north face; rotate so it faces the block's `facing`.
    const facingRot = { north: 0, south: Math.PI, west: Math.PI / 2, east: -Math.PI / 2 }
    for (const pos of positions) {
      const key = `be:${pos.x},${pos.y},${pos.z}`
      if (this.entities[key]) continue
      let block
      try { block = bot.blockAt(pos) } catch { continue }
      if (!block) continue
      let props = {}
      try { props = (block.getProperties && block.getProperties()) || {} } catch {}
      // Decorated pot: a manual mesh (body + neck) — its faces need a full per-face texture
      // (side.png / sherds), which the box-UV Entity system can't express. Sherds (per-face
      // pottery patterns from block.blockEntity.sherds) override the side texture per face.
      if (block.name === 'decorated_pot') {
        const dir = assetsDir('1.21.1')
        const load = (rel) => dir ? loadTextureSync(path.join(dir, 'entity', 'decorated_pot', rel)) : null
        const sideTex = load('decorated_pot_side.png')
        const baseTex = load('decorated_pot_base.png')
        let sherds = []
        try { sherds = (block.blockEntity && block.blockEntity.sherds) || [] } catch {}
        const s = Array.isArray(sherds) ? sherds : []
        // A sherd item id → its face texture; "brick" (or empty) = the plain side.
        const sherdTex = (id) => {
          const n = String(id || '').replace(/^minecraft:/, '')
          if (!n || n === 'brick') return sideTex
          return load(n.replace(/_pottery_sherd$/, '_pottery_pattern') + '.png') || sideTex
        }
        const grp = new THREE.Object3D()
        const faceMat = (tex) => new THREE.MeshLambertMaterial({ map: tex || null, color: tex ? 0xffffff : 0xa0522d, transparent: true, alphaTest: 0.1 })
        // sherds NBT order is [back, left, right, front]. BoxGeometry material order is
        // [+x east, -x west, +y top, -y bottom, +z south/front, -z north/back].
        const bodyMats = [
          faceMat(sherdTex(s[2])), // +x / right
          faceMat(sherdTex(s[1])), // -x / left
          faceMat(baseTex), // top
          faceMat(baseTex), // bottom
          faceMat(sherdTex(s[3])), // +z / front
          faceMat(sherdTex(s[0])) // -z / back
        ]
        const body = new THREE.Mesh(new THREE.BoxGeometry(13 / 16, 14 / 16, 13 / 16), bodyMats)
        body.position.set(0, 8 / 16, 0)
        grp.add(body)
        const neck = new THREE.Mesh(new THREE.BoxGeometry(10 / 16, 3 / 16, 10 / 16), faceMat(baseTex))
        neck.position.set(0, 15.3 / 16, 0)
        grp.add(neck)
        grp.position.set(pos.x + 0.5, pos.y, pos.z + 0.5)
        grp.rotation.y = facingRot[props.facing] !== undefined ? facingRot[props.facing] : 0
        this.entities[key] = grp
        this.scene.add(grp)
        continue
      }
      const isBanner = block.name.endsWith('banner')
      const isSkull = !!SKULL[block.name]
      const isWallSkull = isSkull && block.name.includes('wall')
      // Beds are two blocks; each half has its own geometry (pillow vs foot), keyed by `part`.
      // Banners share one geometry; the per-instance heraldry goes on as a composited texture.
      const type = block.name.endsWith('_bed') ? `${block.name}_${props.part || 'foot'}`
        : isBanner ? 'banner' : isSkull ? SKULL[block.name] : block.name
      let mesh
      try { mesh = new Entity('1.16.4', type, this.scene).mesh } catch { continue }
      if (!mesh) continue
      mesh.position.set(pos.x + 0.5, pos.y, pos.z + 0.5)
      if (isBanner) {
        // Composite base cloth + NBT pattern layers, then swap it onto the flag material.
        const baseColor = block.name.replace('_wall_banner', '').replace('_banner', '')
        let patterns = []
        try { patterns = (block.blockEntity && block.blockEntity.patterns) || [] } catch {}
        const tex = bannerTexture('1.16.4', baseColor, patterns)
        mesh.traverse((o) => { if (o.material) { o.material.map = tex; o.material.needsUpdate = true } })
        mesh.scale.set(2 / 3, 2 / 3, 2 / 3) // vanilla banner model is rendered at 2/3 scale
        if (block.name.endsWith('_wall_banner')) {
          mesh.position.set(pos.x + 0.5, pos.y + 0.28, pos.z + 0.5)
          mesh.rotation.y = facingRot[props.facing] !== undefined ? facingRot[props.facing] : 0
        } else {
          const rot = parseInt(props.rotation || '0', 10) || 0
          mesh.rotation.y = -rot * (Math.PI * 2 / 16)
        }
      } else if (isSkull) {
        if (isWallSkull) {
          // Mounted on a wall face, centred vertically, offset toward the wall.
          const f = props.facing
          const off = { north: [0, 0.25, 0.25], south: [0, 0.25, -0.25], west: [0.25, 0.25, 0], east: [-0.25, 0.25, 0] }[f] || [0, 0.25, 0]
          mesh.position.set(pos.x + 0.5 + off[0], pos.y + off[1], pos.z + 0.5 + off[2])
          mesh.rotation.y = facingRot[f] !== undefined ? facingRot[f] : 0
        } else {
          // Floor skull: sits on the block, rotated by its 0..15 rotation state.
          const rot = parseInt(props.rotation || '0', 10) || 0
          mesh.rotation.y = -rot * (Math.PI * 2 / 16)
        }
      } else if (chests.has(block.name) || block.name.endsWith('_bed')) {
        // Chests + beds carry a horizontal `facing` → rotate the model to match. Shulker boxes'
        // `facing` is which way the lid opens (often up); conduits/bells render upright.
        mesh.rotation.y = facingRot[props.facing] !== undefined ? facingRot[props.facing] : 0
      }
      this.entities[key] = mesh
      this.scene.add(mesh)
    }
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
