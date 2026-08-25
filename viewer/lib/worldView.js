const { spiral, ViewRect, chunkPos } = require('./simpleUtils')
const { Vec3 } = require('vec3')
const EventEmitter = require('events')

// Flatten a chat component (string | {text,extra} | nbt-ish | array) to plain text, so
// custom names / holograms render as their actual text. Best-effort and defensive —
// entity metadata shapes vary by version.
function flattenText (c) {
  if (c == null) return undefined
  if (typeof c === 'string') {
    // A metadata string is often itself a JSON chat component (text_display) — unwrap it.
    const t = c.trim()
    if (t.startsWith('{') || (t.startsWith('"') && t.endsWith('"'))) {
      try { return flattenText(JSON.parse(t)) } catch { /* plain string */ }
    }
    return c
  }
  if (Array.isArray(c)) return c.map(flattenText).filter(Boolean).join('') || undefined
  // mineflayer wraps typed metadata as {type,value}; unwrap common shapes.
  if (typeof c.value === 'string' && (c.type === 'string' || c.text === undefined)) {
    const inner = flattenText(c.value)
    if (inner) return inner
  }
  let s = ''
  if (typeof c.text === 'string') s = c.text
  else if (c.text && typeof c.text.value === 'string') s = c.text.value
  else if (typeof c.value === 'string') s = c.value
  else if (c.value && typeof c.value.value === 'string') s = c.value.value
  else if (c.value && typeof c.value.text === 'string') s = c.value.text
  const extra = c.extra && (c.extra.value ? c.extra.value.value || c.extra.value : c.extra)
  if (Array.isArray(extra)) s += extra.map(flattenText).filter(Boolean).join('')
  return s || undefined
}

// A displayable name for an entity: its username (players) or its custom name
// (metadata index 2 — armor-stand holograms, named mobs, etc.).
function displayNameOf (e) {
  if (e.username !== undefined) return undefined // players already handled via username
  const cn = e.metadata && e.metadata[2]
  return flattenText(cn)
}

function numOf (v) {
  if (v == null) return undefined
  if (typeof v === 'number') return v
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : undefined }
  if (typeof v.value === 'number') return v.value
  return undefined
}

// Numeric item id from a Slot-shaped metadata value ({itemId,itemCount} / nested).
function itemIdOf (v) {
  if (v == null) return undefined
  if (typeof v.itemId === 'number') return v.itemCount === 0 ? undefined : v.itemId
  if (v.value) return itemIdOf(v.value)
  return undefined
}

// CustomModelData (+ item_model) from a Slot's data components — the key to rendering an item
// entity's real custom (ItemsAdder/CMD) appearance. Returns { cmd?, itemModel? }.
function itemModelInfoOf (v) {
  if (v == null) return {}
  if (v.value && !v.components) return itemModelInfoOf(v.value)
  const out = {}
  const comps = v.components || (v.value && v.value.components)
  if (Array.isArray(comps)) {
    for (const c of comps) {
      if (c && c.type === 'custom_model_data') {
        const fl = c.data && c.data.floats
        if (Array.isArray(fl) && fl.length) out.cmd = fl[0]
        else if (typeof c.data === 'number') out.cmd = c.data // legacy int form
      } else if (c && c.type === 'item_model') {
        out.itemModel = typeof c.data === 'string' ? c.data : (c.data && c.data.value)
      }
    }
  }
  return out
}

// Extract the {x,y,z} of a display-entity scale vector metadata (index 12), if present.
function scaleOf (v) {
  if (v && typeof v.x === 'number') return { x: v.x, y: v.y, z: v.z }
  if (v && v.value) return scaleOf(v.value)
  return undefined
}
function vec3Of (v) {
  if (v && typeof v.x === 'number') return { x: v.x, y: v.y, z: v.z }
  if (v && v.value) return vec3Of(v.value)
  return undefined
}
function quatOf (v) {
  if (v && typeof v.x === 'number' && typeof v.w === 'number') return { x: v.x, y: v.y, z: v.z, w: v.w }
  if (v && v.value) return quatOf(v.value)
  return undefined
}
// The Display-entity transformation (metadata 11=translation, 12=scale, 13=left rot, 14=right
// rot). ModelEngine drives these per-bone item_display to assemble a custom mob; applying it is
// what makes MEG mobs + any transformed display render correctly. Returns undefined if identity.
function transformOf (m) {
  const translation = vec3Of(m[11]); const scale = vec3Of(m[12])
  const left = quatOf(m[13]); const right = quatOf(m[14])
  if (!translation && !scale && !left && !right) return undefined
  return { translation, scale, left, right }
}

// One equipment slot → the identity a renderer needs: { name, cmd?, itemModel?, assetId? }, or null.
function slotInfo (name, cmd, itemModel, assetId) {
  if (!name) return null
  const out = { name: String(name).replace(/^minecraft:/, '') }
  if (cmd != null) out.cmd = cmd
  if (itemModel) out.itemModel = itemModel
  if (assetId) out.assetId = assetId
  return out
}

// The equippable asset id from a passive prismarine-item's components (1.21.2+), or undefined.
function equippableAssetOf (it) {
  const comps = it && (it.components || (it.value && it.value.components))
  if (Array.isArray(comps)) {
    for (const c of comps) {
      if (c && c.type === 'equippable') {
        const d = c.data
        const m = d && (d.model || d.assetId || d.asset_id)
        if (m) return typeof m === 'string' ? m : (m.value || undefined)
      }
    }
  }
  return undefined
}

// A mob/player's held items + worn armor, normalized to { hand, offhand, head, chest, legs, feet }.
// Two sources: authoritative NovaLink (e._novaEquip — server-side, always carries CMD/item_model/
// assetId), else mineflayer's passive entity.equipment array (populated from entity_equipment).
function equipOf (e) {
  const nv = e._novaEquip
  const arr = e.equipment
  if (!nv && !Array.isArray(arr)) return null
  // PER-SLOT MERGE of both sources: prefer NovaLink (authoritative — always carries CMD/item_model/
  // assetId), else mineflayer's passive slot. This closes packet-timing / NBT gaps where one source
  // has a slot the other momentarily doesn't, instead of an all-or-nothing OR. Returning the loadout
  // even when every slot is empty lets a gear-REMOVAL still change the equipSig and rebuild the mesh.
  const g = (s) => (s ? slotInfo(s.item, s.cmd, s.itemModel, s.assetId) : null)
  // prismarine-entity equipment array order: [mainhand, offhand, boots, leggings, chestplate, helmet].
  const p = (it) => { if (!it) return null; const info = itemModelInfoOf(it); return slotInfo(it.name, info.cmd, info.itemModel, equippableAssetOf(it)) }
  const pass = Array.isArray(arr) ? { hand: p(arr[0]), offhand: p(arr[1]), feet: p(arr[2]), legs: p(arr[3]), chest: p(arr[4]), head: p(arr[5]) } : {}
  const nvE = nv ? { hand: g(nv.hand), offhand: g(nv.off_hand), head: g(nv.head), chest: g(nv.chest), legs: g(nv.legs), feet: g(nv.feet) } : {}
  const pick = (slot) => nvE[slot] || pass[slot] || null
  return { hand: pick('hand'), offhand: pick('offhand'), head: pick('head'), chest: pick('chest'), legs: pick('legs'), feet: pick('feet') }
}

// Item-frame facing, derived from the entity position's ±1/32-block offset on one axis (the frame
// sits 0.03125 proud of the block face it hangs on). Version-independent geometry — mineflayer
// doesn't surface the Facing/Hanging direction directly. Returns 'up'|'down'|'north'|'south'|
// 'east'|'west' (defaults 'south'). frac ~0.031 = positive face, ~0.969 = negative face.
function frameFacingOf (pos) {
  if (!pos) return 'south'
  const OFF = 1 / 32
  const nearFace = (v) => { const f = ((v % 1) + 1) % 1; return f < OFF * 2 ? 1 : (f > 1 - OFF * 2 ? -1 : 0) }
  const fx = nearFace(pos.x), fy = nearFace(pos.y), fz = nearFace(pos.z)
  if (fy > 0) return 'up'; if (fy < 0) return 'down'
  if (fz > 0) return 'south'; if (fz < 0) return 'north'
  if (fx > 0) return 'east'; if (fx < 0) return 'west'
  return 'south'
}

function entityPayload (e) {
  const p = {
    id: e.id, name: e.name, pos: e.position, width: e.width, height: e.height,
    username: e.username, customName: displayNameOf(e)
  }
  const m = e.metadata || []
  let slot
  switch (e.name) {
    case 'text_display': p.customName = flattenText(m[23]) || p.customName; break
    case 'item_display': p.item = itemIdOf(m[23]); slot = m[23]; p.transform = transformOf(m); break
    case 'block_display': p.blockStateId = numOf(m[23]); p.scale = scaleOf(m[12]); p.transform = transformOf(m); break
    case 'item': p.item = itemIdOf(m[8]); slot = m[8]; break
    case 'item_frame': case 'glow_item_frame':
      p.item = itemIdOf(m[9]); slot = m[9]
      p.frame = e.name; p.glow = e.name === 'glow_item_frame'
      p.frameRotation = (numOf(m[10]) || 0) & 7 // 0..7, ×45°
      p.frameFacing = frameFacingOf(e.position)
      break
  }
  if (slot != null) { const info = itemModelInfoOf(slot); if (info.cmd != null) p.cmd = info.cmd; if (info.itemModel) p.itemModel = info.itemModel }
  // Held items + worn armor (mobs/players) — rendered as custom models attached to the body.
  const equip = equipOf(e)
  if (equip) p.equip = equip
  return p
}

class WorldView extends EventEmitter {
  constructor (world, viewDistance, position = new Vec3(0, 0, 0), emitter = null) {
    super()
    this.world = world
    this.viewDistance = viewDistance
    this.loadedChunks = {}
    this.lastPos = new Vec3(0, 0, 0).update(position)
    this.emitter = emitter || this

    this.listeners = {}
    this.emitter.on('mouseClick', async (click) => {
      const ori = new Vec3(click.origin.x, click.origin.y, click.origin.z)
      const dir = new Vec3(click.direction.x, click.direction.y, click.direction.z)
      const block = this.world.raycast(ori, dir, 256)
      if (!block) return
      this.emit('blockClicked', block, block.face, click.button)
    })
  }

  listenToBot (bot) {
    const worldView = this
    // These fire on the LIVE bot's event emitter, and each synchronously builds/updates a mesh
    // (getEntityMesh) that can throw — e.g. an unknown entity, or a GL call after the context was
    // torn down. A throw here would propagate as an UNCAUGHT error on the bot and can drop the
    // connection, so every handler is wrapped: a render-side failure must never crash the bot.
    const safe = (fn) => function (...args) {
      try { fn.apply(this, args) } catch (e) { /* render is best-effort; never break the bot */ }
    }
    this.listeners[bot.username] = {
      // 'move': botPosition,
      entitySpawn: safe(function (e) {
        if (e === bot.entity) return
        worldView.emitter.emit('entity', entityPayload(e))
      }),
      entityUpdate: safe(function (e) {
        // metadata (custom name / display content) usually arrives just AFTER spawn —
        // re-emit so holograms & named entities actually get their text.
        if (e === bot.entity) return
        worldView.emitter.emit('entity', entityPayload(e))
      }),
      entityEquip: safe(function (e) {
        // mineflayer emits this on a separate event when an entity_equipment packet lands (often just
        // after spawn). Re-emit the full payload so held-item / armor changes rebuild the mesh.
        if (e === bot.entity) return
        worldView.emitter.emit('entity', entityPayload(e))
      }),
      entityMoved: safe(function (e) {
        worldView.emitter.emit('entity', { id: e.id, pos: e.position, pitch: e.pitch, yaw: e.yaw })
      }),
      entityGone: safe(function (e) {
        worldView.emitter.emit('entity', { id: e.id, delete: true })
      }),
      chunkColumnLoad: safe(function (pos) {
        worldView.loadChunk(pos)
      }),
      blockUpdate: safe(function (oldBlock, newBlock) {
        const stateId = newBlock.stateId ? newBlock.stateId : ((newBlock.type << 4) | newBlock.metadata)
        worldView.emitter.emit('blockUpdate', { pos: oldBlock.position, stateId })
      })
    }

    for (const [evt, listener] of Object.entries(this.listeners[bot.username])) {
      bot.on(evt, listener)
    }

    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (e && e !== bot.entity) {
        this.emitter.emit('entity', entityPayload(e))
      }
    }
  }

  removeListenersFromBot (bot) {
    for (const [evt, listener] of Object.entries(this.listeners[bot.username])) {
      bot.removeListener(evt, listener)
    }
    delete this.listeners[bot.username]
  }

  async init (pos) {
    const [botX, botZ] = chunkPos(pos)

    const positions = []
    spiral(this.viewDistance * 2, this.viewDistance * 2, (x, z) => {
      const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
      positions.push(p)
    })

    this.lastPos.update(pos)
    await this._loadChunks(positions)
  }

  async _loadChunks (positions, sliceSize = 5, waitTime = 0) {
    for (let i = 0; i < positions.length; i += sliceSize) {
      await new Promise((resolve) => setTimeout(resolve, waitTime))
      await Promise.all(positions.slice(i, i + sliceSize).map(p => this.loadChunk(p)))
    }
  }

  async loadChunk (pos) {
    const [botX, botZ] = chunkPos(this.lastPos)
    const dx = Math.abs(botX - Math.floor(pos.x / 16))
    const dz = Math.abs(botZ - Math.floor(pos.z / 16))
    if (dx < this.viewDistance && dz < this.viewDistance) {
      const column = await this.world.getColumnAt(pos)
      if (column) {
        this._applyLight(column) // compute skylight/blocklight ourselves (server omits it for placed blocks)
        const chunk = column.toJson()
        this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk })
        this.loadedChunks[`${pos.x},${pos.z}`] = true
      }
    }
  }

  // Recompute lighting for one column, in place, before it's serialised to the mesher. The server
  // does NOT send skyLight to a spectating bot for blocks placed via setblock/fill, so without
  // this our builds render pitch black. Derived from block geometry (reliable): straight-down
  // skylight (open sky = 15, attenuated through cover) + a block-light flood-fill from emitters
  // within the column. Bounded to `this.lightBand` (a Y range around the shot) to stay cheap;
  // needs `this.mcData` (blocksByStateId → filterLight/emitLight). No-op if either is unset.
  //
  // HYBRID (2026-08-24): the server's OWN light — where it sent any — has proper multi-directional
  // propagation (light bleeds around overhangs / into openings) that our per-column straight-down
  // pass can't match. So we take max(serverLight, computed): natural/loaded terrain keeps the
  // server's richer light, while command-placed builds (server sent 0) get our computed fallback.
  // `this.lightMode` = 'hybrid' (default) | 'computed' (ignore server) | 'server' (skip compute).
  _applyLight (col) {
    const md = this.mcData
    const band = this.lightBand
    if (!md || !md.blocksByStateId || !band || typeof col.setSkyLight !== 'function') return
    const mode = this.lightMode || 'hybrid'
    if (mode === 'server') return // trust the server's light entirely (natural terrain, no builds)
    const useServer = mode !== 'computed' // hybrid: blend the server's real light in via max()
    const yBot = band[0], yTop = band[1]
    const Hy = yTop - yBot + 1
    if (Hy <= 0) return
    const cache = this._lightInfoCache || (this._lightInfoCache = {})
    const info = (sid) => {
      let v = cache[sid]
      if (v === undefined) {
        const b = md.blocksByStateId[sid]
        v = { f: b ? (b.filterLight == null ? 15 : b.filterLight) : 15, e: b ? (b.emitLight || 0) : 0 }
        cache[sid] = v
      }
      return v
    }
    const WD = 256
    const idx = (x, y, z) => ((y - yBot) * 16 + z) * 16 + x
    const filter = new Uint8Array(16 * Hy * 16)
    const blk = new Uint8Array(16 * Hy * 16)
    const p = new Vec3(0, 0, 0)
    let emitters = []
    // Skylight per (x,z) column + record filter grid + emitters.
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        let level = 15
        for (let y = yTop; y >= yBot; y--) {
          p.set(x, y, z)
          let sid = 0
          try { sid = col.getBlockStateId(p) } catch { sid = 0 }
          const inf = sid ? info(sid) : null
          const f = inf ? inf.f : 0
          const i = idx(x, y, z)
          filter[i] = f
          level = level - f; if (level < 0) level = 0
          // Hybrid: PREFER the server's skylight wherever it sent any (it has real multidirectional
          // propagation — soft shadows around overhangs — that our straight-down pass can't match),
          // and use our computed value only where the server sent 0 (command-placed blocks). This
          // preserves natural shadows rather than flattening them with a max().
          let out = level
          if (useServer) { let sv = 0; try { sv = col.getSkyLight(p) } catch { sv = 0 }; if (sv > 0) out = sv }
          try { col.setSkyLight(p, out) } catch { /* skip */ }
          if (inf && inf.e > 0) { blk[i] = inf.e; emitters.push(i) }
        }
      }
    }
    // Block-light flood-fill within the column from its emitters.
    while (emitters.length) {
      const next = []
      for (const i of emitters) {
        const lvl = blk[i]
        if (lvl <= 1) continue
        const y = (i / WD) | 0
        const rem = i - y * WD
        const z = (rem / 16) | 0
        const x = rem - z * 16
        const spread = (ni) => { if (filter[ni] >= 15) return; const nl = lvl - 1 - filter[ni]; if (nl > blk[ni]) { blk[ni] = nl; next.push(ni) } }
        if (x > 0) spread(i - 1)
        if (x < 15) spread(i + 1)
        if (z > 0) spread(i - 16)
        if (z < 15) spread(i + 16)
        if (y > 0) spread(i - WD)
        if (y < Hy - 1) spread(i + WD)
      }
      emitters = next
    }
    for (let i = 0; i < blk.length; i++) {
      if (blk[i] > 0) {
        const y = (i / WD) | 0
        const rem = i - y * WD
        const z = (rem / 16) | 0
        const x = rem - z * 16
        p.set(x, y + yBot, z)
        // Hybrid: block-light uses max — the brightest source wins so command-placed torches (our
        // computed BFS) always glow, and a spot the server baked brighter (cross-column propagation
        // our per-column BFS misses) isn't darkened. Positions we don't touch keep the server's.
        let out = blk[i]
        if (useServer) { let sv = 0; try { sv = col.getBlockLight(p) } catch { sv = 0 }; if (sv > out) out = sv }
        try { col.setBlockLight(p, out) } catch { /* skip */ }
      }
    }
  }

  unloadChunk (pos) {
    this.emitter.emit('unloadChunk', { x: pos.x, z: pos.z })
    delete this.loadedChunks[`${pos.x},${pos.z}`]
  }

  async updatePosition (pos, force = false) {
    const [lastX, lastZ] = chunkPos(this.lastPos)
    const [botX, botZ] = chunkPos(pos)
    if (lastX !== botX || lastZ !== botZ || force) {
      const newView = new ViewRect(botX, botZ, this.viewDistance)
      for (const coords of Object.keys(this.loadedChunks)) {
        const x = parseInt(coords.split(',')[0])
        const z = parseInt(coords.split(',')[1])
        const p = new Vec3(x, 0, z)
        if (!newView.contains(Math.floor(x / 16), Math.floor(z / 16))) {
          this.unloadChunk(p)
        }
      }
      const positions = []
      spiral(this.viewDistance * 2, this.viewDistance * 2, (x, z) => {
        const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
        if (!this.loadedChunks[`${p.x},${p.z}`]) {
          positions.push(p)
        }
      })
      this.lastPos.update(pos)
      await this._loadChunks(positions)
    } else {
      this.lastPos.update(pos)
    }
  }
}

module.exports = { WorldView }
