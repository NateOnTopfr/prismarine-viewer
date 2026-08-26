const Chunks = require('prismarine-chunk')
const mcData = require('minecraft-data')

function columnKey (x, z) {
  return `${x},${z}`
}

function posInChunk (pos) {
  pos = pos.floored()
  pos.x &= 15
  pos.z &= 15
  return pos
}

function isCube (shapes) {
  if (!shapes || shapes.length !== 1) return false
  const shape = shapes[0]
  return shape[0] === 0 && shape[1] === 0 && shape[2] === 0 && shape[3] === 1 && shape[4] === 1 && shape[5] === 1
}

class World {
  constructor (version) {
    this.Chunk = Chunks(version)
    this.columns = {}
    this.blockCache = {}
    const d = mcData(version)
    this.biomeCache = d.biomes
    // Per-block-name luminance (emitLight) so the mesher can render light-source blocks self-lit
    // ("glow"): glowstone/sea_lantern=15, torch=14, magma=3, etc. Positional light (block.light)
    // is overwritten per-render, so the block's OWN emission must come from the registry.
    this.emitLight = {}
    for (const n in d.blocksByName) {
      const e = d.blocksByName[n].emitLight
      if (e) this.emitLight[n] = e
    }
  }

  addColumn (x, z, json) {
    const chunk = this.Chunk.fromJson(json)
    this.columns[columnKey(x, z)] = chunk
    return chunk
  }

  removeColumn (x, z) {
    delete this.columns[columnKey(x, z)]
  }

  // Region-bounded rendering (render_region / bot-less): when a build is reconstructed as an isolated
  // cuboid, the surrounding chunks are loaded AIR, so the mesher (which only culls faces vs a solid or
  // vs a genuinely-unloaded null neighbour) DRAWS the region's whole outer shell — the underside + side
  // walls + water side-faces at the cut, so terrain reads as a floating slab with water "overflowing"
  // off the edges. Setting bounds makes getBlock return null OUTSIDE the region, so those boundary
  // faces cull exactly like an unloaded neighbour. Unset (live-bot renders) = no change.
  setRegionBounds (b) {
    // b = {minX,minY,minZ,maxX,maxY,maxZ} (inclusive block coords) or null to clear.
    this.regionBounds = b || null
  }

  // Bot-less renders (render_region) reconstruct a world with NO biome data, so getBlock falls back to
  // plains and water/grass/foliage always render the plains tint. Setting a default biome id (fetched
  // from the real region) makes those tints correct. Null (live-bot renders) = use the real per-column
  // biome as before.
  setDefaultBiome (id) {
    this.defaultBiome = (id === undefined || id === null) ? null : id
  }

  getColumn (x, z) {
    return this.columns[columnKey(x, z)]
  }

  setBlockStateId (pos, stateId) {
    const key = columnKey(Math.floor(pos.x / 16) * 16, Math.floor(pos.z / 16) * 16)

    const column = this.columns[key]
    // null column means chunk not loaded
    if (!column) return false

    column.setBlockStateId(posInChunk(pos.floored()), stateId)

    return true
  }

  getBlock (pos) {
    // Outside the render region (if bounded) → treat as unloaded so the mesher culls the cut faces.
    const rb = this.regionBounds
    if (rb) {
      const fx = Math.floor(pos.x)
      const fy = Math.floor(pos.y)
      const fz = Math.floor(pos.z)
      if (fx < rb.minX || fx > rb.maxX || fy < rb.minY || fy > rb.maxY || fz < rb.minZ || fz > rb.maxZ) return null
    }

    const key = columnKey(Math.floor(pos.x / 16) * 16, Math.floor(pos.z / 16) * 16)

    const column = this.columns[key]
    // null column means chunk not loaded
    if (!column) return null

    const loc = pos.floored()
    const locInChunk = posInChunk(loc)
    const stateId = column.getBlockStateId(locInChunk)

    if (!this.blockCache[stateId]) {
      const b = column.getBlock(locInChunk)
      b.isCube = isCube(b.shapes)
      this.blockCache[stateId] = b
    }

    const block = this.blockCache[stateId]
    block.position = loc
    // Light is per-POSITION, not per-stateId — refresh it on the shared cached block so the
    // mesher's light bake reads the right value (without this every air neighbour returned the
    // first-seen air block's stale skyLight, baking whole chunks dark).
    block.skyLight = column.getSkyLight(locInChunk)
    block.light = column.getBlockLight(locInChunk)
    const biomeId = this.defaultBiome != null ? this.defaultBiome : column.getBiome(locInChunk)
    block.biome = this.biomeCache[biomeId] || this.biomeCache[1]
    return block
  }
}

module.exports = { World }
