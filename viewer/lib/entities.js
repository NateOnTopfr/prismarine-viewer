const THREE = require('three')
const TWEEN = require('@tweenjs/tween.js')
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const Entity = require('./entity/Entity')
const { dispose3 } = require('./dispose')

const { createCanvas, Image } = require('canvas')
const { buildCustomItemMesh } = require('./customModel')

// Apply a Display-entity transformation to a mesh: P' = translation * leftRot * scale * rightRot.
// Drives transformed item/block displays and (per-bone) ModelEngine custom mobs.
function applyDisplayTransform (obj, t) {
  if (!t) return
  const q = (o) => new THREE.Quaternion(o.x, o.y, o.z, o.w)
  const M = new THREE.Matrix4()
  if (t.translation) M.multiply(new THREE.Matrix4().makeTranslation(t.translation.x, t.translation.y, t.translation.z))
  if (t.left) M.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q(t.left)))
  if (t.scale) M.multiply(new THREE.Matrix4().makeScale(t.scale.x, t.scale.y, t.scale.z))
  if (t.right) M.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q(t.right)))
  obj.applyMatrix4(M)
}

// Load a resource-pack texture (absolute path) as a THREE texture for custom item models.
// flipY off so the model's UVs (MC v=0 = top) map correctly; cached.
const _packTexCache = {}
function loadPackTexture (file) {
  if (_packTexCache[file] !== undefined) return _packTexCache[file]
  try {
    const img = new Image(); img.src = fs.readFileSync(file)
    const c = createCanvas(img.width || 16, img.height || 16)
    c.getContext('2d').drawImage(img, 0, 0)
    const tex = new THREE.Texture(c)
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter
    tex.flipY = false; tex.needsUpdate = true
    _packTexCache[file] = tex
  } catch { _packTexCache[file] = null }
  return _packTexCache[file]
}

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
  for (const v of [version, '1.21.8', '1.21.1', '1.20.2', '1.19.1']) {
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
// Like loadTextureSync but NOT cached — a fresh THREE.Texture per call. Cached texture objects
// reused across meshes upload unreliably in the headless GL context (heads rendered black/white);
// a fresh texture (as banners do) is stable. Use for per-instance skins. flipY off for box-UV.
function loadTextureFresh (file) {
  try {
    const img = new Image(); img.src = fs.readFileSync(file)
    // Skins are 64 wide; legacy skins are 64x32. Pad to a square 64x64 canvas (head/hat live in
    // the top half of both) so the head geometry's 64x64 UVs map to the correct rows.
    const w = img.width || 64
    const size = Math.max(w, img.height || 64)
    const c = createCanvas(size, size)
    c.getContext('2d').drawImage(img, 0, 0)
    const tex = new THREE.Texture(c)
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter
    tex.flipY = false; tex.needsUpdate = true
    return tex
  } catch { return null }
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
  const ad = assetsDir(version)
  const base = ad ? path.join(ad, 'entity') : path.join(_publicDir, 'textures', '1.16.4', 'entity')
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

// --- Player-head skins: resolve a head's profile to a real skin PNG (disk-cached). Works
// for an online server (skin embedded in profile.properties.textures) AND offline/name-only
// (Mojang API name->uuid->skin). Falls back to the steve placeholder if unreachable. ---
const _skinCache = {}
function uuidHex (id) {
  if (typeof id === 'string') return id.replace(/-/g, '')
  if (Array.isArray(id) && id.length === 4) return id.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('')
  return null
}
async function _texturesProp (obj) {
  const tp = ((obj && obj.properties) || []).find((p) => p.name === 'textures')
  return tp && tp.value
}
async function resolveSkinFile (profile) {
  try {
    if (!profile || typeof fetch !== 'function') return null
    // 1) Skin embedded in the profile — online servers + custom-skin (head-database) heads.
    let b64 = null
    const props = profile.properties
    if (props) { const t = Array.isArray(props) ? props.find((p) => p.name === 'textures') : props.textures; b64 = t && (t.value || t) }
    let cacheKey = null
    // 2) Resolve by NAME (gets the real premium skin) — the offline server hands us an offline
    //    UUID that the session server won't know, so name is more reliable than profile.id here.
    if (!b64 && profile.name) {
      cacheKey = 'name:' + profile.name
      if (_skinCache[cacheKey] !== undefined) return _skinCache[cacheKey]
      try {
        const r = await fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(profile.name))
        if (r.ok) {
          const uuid = (await r.json()).id
          const r2 = await fetch('https://sessionserver.mojang.com/session/minecraft/profile/' + uuid)
          if (r2.ok) b64 = await _texturesProp(await r2.json())
        }
      } catch { /* network best-effort */ }
    }
    // 3) Fall back to the profile UUID (premium/online servers that omit embedded textures).
    if (!b64) {
      const uuid = uuidHex(profile.id)
      if (uuid) {
        cacheKey = cacheKey || ('uuid:' + uuid)
        if (_skinCache[cacheKey] !== undefined) return _skinCache[cacheKey]
        try { const r = await fetch('https://sessionserver.mojang.com/session/minecraft/profile/' + uuid); if (r.ok) b64 = await _texturesProp(await r.json()) } catch { /* best-effort */ }
      }
    }
    if (!b64) { if (cacheKey) _skinCache[cacheKey] = null; return null }
    const meta = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const url = meta.textures && meta.textures.SKIN && meta.textures.SKIN.url
    if (!url) { if (cacheKey) _skinCache[cacheKey] = null; return null }
    const fileKey = 'file:' + url.split('/').pop()
    if (_skinCache[fileKey] !== undefined) { if (cacheKey) _skinCache[cacheKey] = _skinCache[fileKey]; return _skinCache[fileKey] }
    const resp = await fetch(url)
    if (!resp.ok) { if (cacheKey) _skinCache[cacheKey] = null; return null }
    const buf = Buffer.from(await resp.arrayBuffer())
    const dir = path.join(_publicDir, 'textures', 'skins-cache')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, url.split('/').pop() + '.png')
    fs.writeFileSync(file, buf)
    _skinCache[fileKey] = file
    if (cacheKey) _skinCache[cacheKey] = file
    return file
  } catch { return null }
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

// Stable signature of an entity's equipment loadout — rebuild the mesh when it changes (gear that
// arrives just after spawn, or a swap). '' when the payload carries no `equip` (e.g. move updates).
function equipSigOf (entity) {
  const eq = entity.equip
  if (!eq) return ''
  return ['hand', 'offhand', 'head', 'chest', 'legs', 'feet']
    .map((s) => { const i = eq[s]; return i ? `${i.name}#${i.cmd == null ? '' : i.cmd}#${i.itemModel || ''}#${i.assetId || ''}` : '' })
    .join('|')
}

// Resolve a custom item model spec by material NAME + CMD (or item_model component) — the equipment
// counterpart of the item-entity lookup (which starts from a numeric item id). Returns a spec or null.
function customSpecByNameCmd (customItems, name, cmd, itemModel) {
  if (!customItems || !name) return null
  let spec = null
  if (cmd != null) {
    const M = String(name).replace(/^minecraft:/, '').toUpperCase()
    spec = customItems.byKey[`${M}:${cmd}`] || customItems.byKey[`${M}:${Math.round(cmd)}`]
  }
  if (!spec && itemModel && customItems.byModel) spec = customItems.byModel[itemModel]
  return spec
}

// Body anchors for worn/held equipment. Positions are ABSOLUTE blocks for a reference humanoid
// (height 1.95, e.g. a zombie/player) and scaled by the actual entity height, so gear lands on the
// right body part across mob sizes. `fit` is the target size (largest axis, blocks). `headRot` is a
// gentle default pose; hands also carry a forward tilt so a held model reads as held. Tuned for the
// humanoid case (the overwhelmingly common custom-gear wearer) with a reasonable fallback for others.
const REF_H = 1.95
const EQUIP_ANCHORS = {
  // head.y is computed per-mob at runtime (h - 0.22) so a helmet sits snugly on the skull.
  head: { x: 0, y: null, z: 0, fit: 0.58, ctx: 'head', rot: [0, 0, 0] },
  hand: { x: 0.34, y: 1.18, z: 0.22, fit: 0.6, ctx: 'thirdperson_righthand', rot: [-15, 0, 10] },
  offhand: { x: -0.34, y: 1.18, z: 0.22, fit: 0.6, ctx: 'thirdperson_lefthand', rot: [-15, 0, -10] },
  chest: { x: 0, y: 1.15, z: 0.02, fit: 0.72, ctx: null, rot: [0, 0, 0] },
  legs: { x: 0, y: 0.72, z: 0, fit: 0.66, ctx: null, rot: [0, 0, 0] },
  feet: { x: 0, y: 0.20, z: 0, fit: 0.58, ctx: null, rot: [0, 0, 0] }
}

// Attach custom (ItemsAdder/Mythic/CMD) held items + worn armor to a mob/player mesh. Each equipped
// slot with a resolvable custom model is built, size-fitted to that body part, given a legible pose,
// and anchored on the body. Purely additive & best-effort: slots without a custom model (plain
// vanilla gear) are skipped here (drawn by the base model). For head/hands we honour the pack's
// authored display YAW (turning), keeping our own tilt so the pose stays sane in the entity's frame.
function attachEquipment (mesh, entity, version, customItems, customArmor) {
  const eq = entity.equip
  if (!eq || !mesh || (!customItems && !customArmor)) return
  const h = entity.height || 1.8
  const w = entity.width || 0.6
  const s = h / REF_H // scale anchor positions to this mob's height
  // The top of the rendered model is the crown of the head — a robust head anchor across mob types
  // (and their differing model heights vs hitbox). Fall back to the hitbox height if the box is empty.
  let topY = h
  try { const mb = new THREE.Box3().setFromObject(mesh); if (isFinite(mb.max.y) && mb.max.y > 0.1) topY = mb.max.y } catch { /* keep h */ }
  const headY = topY - 0.24 // head centre ≈ a quarter-block below the crown
  for (const slot of Object.keys(EQUIP_ANCHORS)) {
    const info = eq[slot]
    if (!info) continue
    try {
      // Worn armor first: equipment-layer armor (MythicArmors / custom sets / vanilla) renders as the
      // humanoid armor MODEL, not the item's inventory model. Applies to chest/legs/feet always, and
      // to head unless a 3D helmet item-model resolves (some helmets are 3D models, not armor layers).
      if (customArmor && info.assetId && slot !== 'hand' && slot !== 'offhand') {
        const armor = customArmor[info.assetId]
        const tex = armor && (slot === 'legs' ? (armor.humanoid_leggings || armor.humanoid) : (armor.humanoid || armor.humanoid_leggings))
        const helmet3d = slot === 'head' && customItems && customSpecByNameCmd(customItems, info.name, info.cmd, info.itemModel)
        if (tex && !helmet3d) {
          const layer = buildArmorLayer(slot, tex)
          if (layer) { layer.scale.setScalar(s); mesh.add(layer); continue }
        }
      }

      // Otherwise: a custom item MODEL (held weapon, 3D helmet, cosmetic) attached at the body anchor.
      const spec = customItems && customSpecByNameCmd(customItems, info.name, info.cmd, info.itemModel)
      if (!spec) continue
      let g
      try { g = buildCustomItemMesh(spec, loadPackTexture) } catch { continue }
      if (!g) continue
      const a = EQUIP_ANCHORS[slot]
      // Nested frames so centring, scaling, posing and anchoring don't interfere:
      //   holder (anchor position + pose rotation + fit scale) → inner (centre the model) → g (raw)
      // Doing the centre-offset on `g` while also scaling it would leave the offset unscaled and shift
      // the model off its anchor — hence the separate inner node.
      const box = new THREE.Box3().setFromObject(g)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const inner = new THREE.Object3D()
      inner.position.copy(center).multiplyScalar(-1)
      inner.add(g)
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const holder = new THREE.Object3D()
      holder.add(inner)
      holder.scale.setScalar((a.fit / maxDim) * s)
      // Pose: our per-slot tilt, plus the pack's authored YAW (Y rotation) for this display context so
      // an asymmetric model faces the way it was authored. We deliberately don't take the authored
      // X/Z rotation — it targets Minecraft's hand-bone frame, not ours, and reads wrong when grafted.
      const disp = spec.display && a.ctx && spec.display[a.ctx]
      const yaw = (disp && disp.rotation && disp.rotation[1]) || 0
      holder.rotation.set(a.rot[0] * Math.PI / 180, (a.rot[1] + yaw) * Math.PI / 180, a.rot[2] * Math.PI / 180)
      if (process.env.NOVA_EQUIP_DEBUG) console.error(`[equip] slot=${slot} name=${info.name} cmd=${info.cmd} fit=${(a.fit / maxDim).toFixed(3)} yaw=${yaw}`)
      // x offset widens with the mob's body (hands reach out); y/z scale with height. The head anchor
      // is derived from the actual height so a helmet sits on the skull regardless of mob size.
      const ax = (slot === 'hand' || slot === 'offhand') ? a.x * (w / 0.6) : a.x
      const ay = slot === 'head' ? headY : a.y * s
      holder.position.set(ax, ay, a.z * s)
      mesh.add(holder)
    } catch { /* one bad slot must not drop the rest */ }
  }
}

// --- worn armor (1.21.2+ equipment layers + vanilla armor): render the humanoid armor MODEL, not
// the item's inventory model. The armor texture is a Java 64x32 humanoid atlas; each body part maps
// to a fixed UV region. UVs normalize to 64x32 (not the file's real size) so HD / non-standard
// (e.g. MythicArmors) textures scale proportionally onto the model exactly as vanilla does. ---

// Java humanoid box-UV: face rects (px) for a box (w,h,d) at texture offset (u,v), normalized to the
// atlas size (TW,TH). Confirmed against the vanilla head/body layout. Order matches THREE
// BoxGeometry groups: +x,-x,+y,-y,+z,-z. v is flipped (textures load flipY=false).
function armorBoxUV (geo, w, h, d, u, v, TW, TH) {
  const uv = geo.attributes.uv
  // Textures load flipY=false, so v maps directly to the image row (top-down) — no 1-v flip (same
  // convention as customModel.js, which renders correctly).
  const rect = (fi, u1, v1, u2, v2) => {
    uv.setXY(fi * 4 + 0, u1 / TW, v1 / TH); uv.setXY(fi * 4 + 1, u2 / TW, v1 / TH)
    uv.setXY(fi * 4 + 2, u1 / TW, v2 / TH); uv.setXY(fi * 4 + 3, u2 / TW, v2 / TH)
  }
  rect(0, u + d + w, v + d, u + 2 * d + w, v + d + h) // +x = left
  rect(1, u, v + d, u + d, v + d + h)                 // -x = right
  rect(2, u + d, v, u + d + w, v + d)                 // +y = top
  rect(3, u + d + w, v, u + d + 2 * w, v + d)         // -y = bottom
  rect(4, u + d, v + d, u + d + w, v + d + h)         // +z = front
  rect(5, u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h) // -z = back
  uv.needsUpdate = true
}

// Humanoid parts in px (center [x,y,z], size [w,h,d]); origin at the feet, y up. `uv` is the LEGACY
// 64x32 armor-atlas offset (left limbs reuse right); `uv64` is the MODERN 64x64 offset (separate
// left limbs). We pick per texture aspect so both vanilla-style and modern equipment atlases map.
const ARMOR_PARTS = {
  head: { c: [0, 28, 0], s: [8, 8, 8], uv: [0, 0], uv64: [0, 0] },
  body: { c: [0, 18, 0], s: [8, 12, 4], uv: [16, 16], uv64: [16, 16] },
  rarm: { c: [-6, 18, 0], s: [4, 12, 4], uv: [40, 16], uv64: [40, 16] },
  larm: { c: [6, 18, 0], s: [4, 12, 4], uv: [40, 16], uv64: [32, 48] },
  rleg: { c: [-2, 6, 0], s: [4, 12, 4], uv: [0, 16], uv64: [0, 16] },
  lleg: { c: [2, 6, 0], s: [4, 12, 4], uv: [0, 16], uv64: [16, 48] }
}
// Which parts each slot covers, and the inflation (px, each side) — vanilla armor "expand" values.
const ARMOR_SLOT = {
  head: { parts: ['head'], expand: 1.0 },
  chest: { parts: ['body', 'rarm', 'larm'], expand: 1.0 },
  legs: { parts: ['body', 'rleg', 'lleg'], expand: 0.5 },
  feet: { parts: ['rleg', 'lleg'], expand: 1.0 }
}

// Build the worn-armor model for one slot, textured with a single armor-layer PNG. Returns an
// Object3D in block units (origin at the feet) or null. `texturePath` is an absolute PNG path.
// The atlas layout (legacy 64x32 vs modern 64x64) is chosen from the texture's actual aspect.
function buildArmorLayer (slot, texturePath) {
  const conf = ARMOR_SLOT[slot]
  if (!conf) return null
  const tex = loadPackTexture(texturePath)
  const iw = (tex && tex.image && tex.image.width) || 64
  const ih = (tex && tex.image && tex.image.height) || 32
  const modern = ih >= iw * 0.75 // ~square => 64x64 modern layout (separate limbs); else 64x32 legacy
  const TW = 64; const TH = modern ? 64 : 32
  const mat = new THREE.MeshLambertMaterial({ map: tex || null, transparent: true, alphaTest: 0.05, color: tex ? 0xffffff : 0xb0b0b0 })
  const group = new THREE.Object3D()
  const e = conf.expand
  for (const name of conf.parts) {
    const p = ARMOR_PARTS[name]
    const [w, h, d] = p.s
    const off = modern ? p.uv64 : p.uv
    const geo = new THREE.BoxGeometry((w + 2 * e) / 16, (h + 2 * e) / 16, (d + 2 * e) / 16)
    armorBoxUV(geo, w, h, d, off[0], off[1], TW, TH)
    const m = new THREE.Mesh(geo, mat)
    m.position.set(p.c[0] / 16, p.c[1] / 16, p.c[2] / 16)
    group.add(m)
  }
  return group
}

function getEntityMesh (entity, scene, version, customItems, customArmor) {
  let mesh

  // Item entities (item_display, dropped item, item/glow_item_frame).
  if (entity.item != null) {
    // Custom resource-pack model (ItemsAdder/CustomModelData) — render the REAL 3D model, not a
    // flat billboard. Resolve by (base material, CMD) or by the item_model component.
    let spec = null
    if (customItems) {
      if (entity.cmd != null) {
        const d = mcData(version)
        const it = d && d.items && d.items[entity.item]
        if (it) spec = customItems.byKey[`${it.name.toUpperCase()}:${entity.cmd}`] || customItems.byKey[`${it.name.toUpperCase()}:${Math.round(entity.cmd)}`]
      }
      if (!spec && entity.itemModel && customItems.byModel) spec = customItems.byModel[entity.itemModel]
    }
    if (spec) {
      try {
        const g = buildCustomItemMesh(spec, loadPackTexture)
        if (g) {
          if (entity.transform) {
            // Transformed display (e.g. a ModelEngine bone): apply the display transformation so
            // bones assemble into the mob. Model stays in its authored 0..1 block space.
            applyDisplayTransform(g, entity.transform)
          } else {
            const box = new THREE.Box3().setFromObject(g)
            const c = box.getCenter(new THREE.Vector3())
            g.position.sub(c) // plain item display → centre the model on the entity position
          }
          mesh = new THREE.Object3D(); mesh.add(g)
        }
      } catch { /* fall through to billboard */ }
    }
    // Fallback: billboarded item texture (vanilla item, or custom model unavailable).
    if (!mesh) {
      const tex = itemTexture(version, entity.item)
      if (tex) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.4 }))
        sprite.scale.set(0.7, 0.7, 0.7)
        sprite.position.y += (entity.name === 'item' ? 0.25 : (entity.height || 0.5) * 0.5) + 0.1
        mesh = new THREE.Object3D()
        mesh.add(sprite)
      }
    }
  }

  // block_display → the actual block as a textured cube, anchored at its corner, with the full
  // display transformation applied (translation/scale/rotation) when present.
  if (!mesh && entity.blockStateId != null) {
    const tex = blockTexture(version, entity.blockStateId)
    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(0.5, 0.5, 0.5)
    const mat = tex ? new THREE.MeshLambertMaterial({ map: tex })
      : new THREE.MeshLambertMaterial({ color: nameColor(String(entity.blockStateId)) })
    const cube = new THREE.Mesh(geo, mat)
    if (entity.transform) {
      applyDisplayTransform(cube, entity.transform)
      mesh = new THREE.Object3D(); mesh.add(cube)
    } else {
      const s = entity.scale || {}
      cube.scale.set(s.x || 1, s.y || 1, s.z || 1)
      mesh = cube
    }
  }

  // text_display → just the floating text (no box).
  if (!mesh && entity.name === 'text_display') mesh = new THREE.Object3D()

  if (!mesh && entity.name) {
    try {
      const e = new Entity(version || '1.21.8', ENTITY_ALIASES[entity.name] || entity.name, scene)
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

  // Held items + worn armor with a custom model (ItemsAdder/Mythic/CMD) — attach to the body.
  if (entity.equip) {
    try { attachEquipment(mesh, entity, version, customItems, customArmor) } catch { /* equipment overlay is best-effort */ }
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
    this.customItems = null // { byKey, byModel } of resolved custom item models (set by the render)
    this.customBlocks = null // { [baseBlock]: [{when, model}] } of resolved custom BLOCK models
    this.customArmor = null // { [assetId]: {humanoid?, humanoid_leggings?} } worn-armor layer textures
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
  async addBlockEntityModels (bot, center, radius) {
    if (!bot || !bot.findBlocks || !center) return
    const version = this.version || '1.21.8' // the running server version — assets track it
    const chests = new Set(['chest', 'trapped_chest', 'ender_chest'])
    const upright = new Set(['conduit', 'bell'])
    // Mob skulls → the mob's head cube. (player_head needs a skin fetch; dragon_head is a
    // multi-part model — both left as boxes for now.)
    const SKULL = {
      skeleton_skull: 'skeleton_skull', skeleton_wall_skull: 'skeleton_skull',
      wither_skeleton_skull: 'wither_skeleton_skull', wither_skeleton_wall_skull: 'wither_skeleton_skull',
      zombie_head: 'zombie_head', zombie_wall_head: 'zombie_head',
      creeper_head: 'creeper_head', creeper_wall_head: 'creeper_head',
      piglin_head: 'piglin_head', piglin_wall_head: 'piglin_head',
      player_head: 'player_head', player_wall_head: 'player_head',
      dragon_head: 'dragon_head', dragon_wall_head: 'dragon_head'
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
    // Pre-pass: resolve player-head skins (async/network) to disk BEFORE building any mesh, so
    // the mesh-building loop below is fully synchronous — awaiting a fetch interleaved between
    // GL mesh operations destabilises the headless GL context (textures render black/white).
    const skinFiles = {}
    for (const pos of positions) {
      let block
      try { block = bot.blockAt(pos) } catch { continue }
      if (!block || SKULL[block.name] !== 'player_head') continue
      let profile
      try { profile = block.blockEntity && block.blockEntity.profile } catch {}
      let file = profile ? await resolveSkinFile(profile) : null
      if (!file) { const d = assetsDir(version); if (d) file = path.join(d, 'entity', 'player', 'wide', 'steve.png') }
      skinFiles[`${pos.x},${pos.y},${pos.z}`] = file
    }
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
        const dir = assetsDir(version)
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
      try { mesh = new Entity(version, type, this.scene).mesh } catch { continue }
      if (!mesh) continue
      mesh.position.set(pos.x + 0.5, pos.y, pos.z + 0.5)
      if (isBanner) {
        // Composite base cloth + NBT pattern layers, then swap it onto the flag material.
        const baseColor = block.name.replace('_wall_banner', '').replace('_banner', '')
        let patterns = []
        try { patterns = (block.blockEntity && block.blockEntity.patterns) || [] } catch {}
        const tex = bannerTexture(version, baseColor, patterns)
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
        // Player heads: apply the owner's real skin (pre-resolved to disk above), or steve for
        // an owner-less head. Loaded synchronously here (no network) to keep GL ops contiguous.
        if (type === 'player_head') {
          const file = skinFiles[`${pos.x},${pos.y},${pos.z}`]
          const tex = file && loadTextureFresh(file)
          if (tex) mesh.traverse((o) => { if (o.material) { o.material.map = tex; o.material.needsUpdate = true } })
        }
        // The ender-dragon head is a big multi-part model — scale it down to block size and
        // lift so it sits centred in the block.
        if (type === 'dragon_head') { mesh.scale.set(0.5, 0.5, 0.5); mesh.position.set(pos.x + 0.5, pos.y + 0.1, pos.z + 0.5) }
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

  // ItemsAdder custom BLOCKS: they're vanilla base blocks (note_block/mushroom/…) with remapped
  // states → custom models. Overlay the real model at each such block (matched by its state
  // props), like the block-entity pass. `this.customBlocks` = { base: [{when, model}] } from the
  // pack's blockstates. Slightly oversized so it covers (not z-fights with) the vanilla base block.
  addCustomBlockModels (bot, center, radius) {
    if (!bot || !bot.findBlocks || !center || !this.customBlocks) return
    const bases = Object.keys(this.customBlocks)
    if (!bases.length) return
    const baseSet = new Set(bases)
    let positions = []
    try {
      positions = bot.findBlocks({
        point: new Vec3(center[0], center[1], center[2]),
        matching: (b) => b && b.name && baseSet.has(b.name),
        maxDistance: Math.min(radius || 40, 64),
        count: 500
      })
    } catch (e) { return }
    for (const pos of positions) {
      const key = `cb:${pos.x},${pos.y},${pos.z}`
      if (this.entities[key]) continue
      let block
      try { block = bot.blockAt(pos) } catch { continue }
      if (!block) continue
      let props = {}
      try { props = (block.getProperties && block.getProperties()) || {} } catch {}
      const variants = this.customBlocks[block.name]
      const match = variants && variants.find((v) => Object.entries(v.when).every(([k, val]) => String(props[k]) === String(val)))
      if (!match) continue
      let g
      try { g = buildCustomItemMesh(match.model, loadPackTexture) } catch { continue }
      if (!g) continue
      // Block models are authored 0..16 (block space), corner-anchored at the block position;
      // grow ~2% about the block centre so the custom faces sit just outside the vanilla base
      // block (which the mesher still draws) instead of z-fighting it.
      g.position.set(pos.x - 0.01, pos.y - 0.01, pos.z - 0.01)
      g.scale.setScalar(1.02)
      this.entities[key] = g
      this.scene.add(g)
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
    // Item entities can arrive first as a bare spawn, then get their item/CMD via a later
    // metadata event — rebuild the mesh if that signature changes so the custom model replaces
    // the initial billboard (and vice-versa). Mobs/players work the same for equipment: the
    // entity_equipment packet (held item + armor, with CMD) usually lands just after spawn.
    const cached = this.entities[entity.id]
    if (cached && cached.userData) {
      let stale = false
      if (entity.item != null) {
        const sig = `${entity.item}:${entity.cmd == null ? '' : entity.cmd}:${entity.itemModel || ''}`
        if (cached.userData._itemSig !== undefined && cached.userData._itemSig !== sig) stale = true
      }
      // equipSig is only carried on full entity payloads, so a bare move update (no `equip`) yields
      // '' and never forces a needless rebuild; a newly-arrived/changed loadout does.
      const esig = equipSigOf(entity)
      if (esig && cached.userData._equipSig !== undefined && cached.userData._equipSig !== esig) stale = true
      if (stale) { this.scene.remove(cached); dispose3(cached); delete this.entities[entity.id] }
    }
    if (!this.entities[entity.id]) {
      let mesh
      try {
        mesh = getEntityMesh(entity, this.scene, this.version, this.customItems, this.customArmor)
      } catch (err) {
        // Unknown/unsupported entity type (no geometry in entities.json and no alias)
        // — skip it rather than crash the whole render.
        return
      }
      if (!mesh) return
      if (entity.item != null) mesh.userData._itemSig = `${entity.item}:${entity.cmd == null ? '' : entity.cmd}:${entity.itemModel || ''}`
      mesh.userData._equipSig = equipSigOf(entity)
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

module.exports = { Entities, buildArmorLayer }
