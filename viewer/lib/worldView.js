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

// Extract the {x,y,z} of a display-entity scale vector metadata (index 12), if present.
function scaleOf (v) {
  if (v && typeof v.x === 'number') return { x: v.x, y: v.y, z: v.z }
  if (v && v.value) return scaleOf(v.value)
  return undefined
}

function entityPayload (e) {
  const p = {
    id: e.id, name: e.name, pos: e.position, width: e.width, height: e.height,
    username: e.username, customName: displayNameOf(e)
  }
  const m = e.metadata || []
  switch (e.name) {
    case 'text_display': p.customName = flattenText(m[23]) || p.customName; break
    case 'item_display': p.item = itemIdOf(m[23]); break
    case 'block_display': p.blockStateId = numOf(m[23]); p.scale = scaleOf(m[12]); break
    case 'item': p.item = itemIdOf(m[8]); break
    case 'item_frame': case 'glow_item_frame': p.item = itemIdOf(m[9]); break
  }
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
    this.listeners[bot.username] = {
      // 'move': botPosition,
      entitySpawn: function (e) {
        if (e === bot.entity) return
        worldView.emitter.emit('entity', entityPayload(e))
      },
      entityUpdate: function (e) {
        // metadata (custom name / display content) usually arrives just AFTER spawn —
        // re-emit so holograms & named entities actually get their text.
        if (e === bot.entity) return
        worldView.emitter.emit('entity', entityPayload(e))
      },
      entityMoved: function (e) {
        worldView.emitter.emit('entity', { id: e.id, pos: e.position, pitch: e.pitch, yaw: e.yaw })
      },
      entityGone: function (e) {
        worldView.emitter.emit('entity', { id: e.id, delete: true })
      },
      chunkColumnLoad: function (pos) {
        worldView.loadChunk(pos)
      },
      blockUpdate: function (oldBlock, newBlock) {
        const stateId = newBlock.stateId ? newBlock.stateId : ((newBlock.type << 4) | newBlock.metadata)
        worldView.emitter.emit('blockUpdate', { pos: oldBlock.position, stateId })
      }
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
        const chunk = column.toJson()
        this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk })
        this.loadedChunks[`${pos.x},${pos.z}`] = true
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
