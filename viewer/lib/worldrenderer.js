/* global Worker */
const THREE = require('three')
const Vec3 = require('vec3').Vec3
const { loadTexture, loadJSON } = globalThis.isElectron ? require('./utils.electron.js') : require('./utils')
const { EventEmitter } = require('events')
const { dispose3 } = require('./dispose')

function mod (x, n) {
  return ((x % n) + n) % n
}

// Build a mipmap chain for a packed 16px-tile ATLAS by downsampling EACH tile independently, so no mip level
// ever averages across tile boundaries (which is what tints distant stone_bricks orange, etc). Alpha-weighted
// box filter (premultiplied) so cutout textures — leaves/glass — don't get dark fringes. Returns levels 1..N
// as { data:Uint8Array, width, height } (level 0 is the untouched base). tilePx is the source tile size (16);
// stops when a tile would shrink below 1px.
// Per-tile mean OPAQUE colour (alpha-weighted). Used to fill fully-transparent mip/atlas pixels with the
// tile's own colour instead of black — otherwise NearestMipmapLinear blends a green level with a
// black-transparent coarser level → DARK-GREEN cutout fragments (grass/leaves/flowers reading black at
// distance; user note #4). Alpha stays 0, so the alphaTest cutout still discards them.
function computeTileMeans (base, W, H, tilePx) {
  const tilesX = W / tilePx, tilesY = H / tilePx
  const means = new Array(tilesX * tilesY)
  let gr = 0, gg = 0, gb = 0, ga = 0
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let y = 0; y < tilePx; y++) {
        for (let x = 0; x < tilePx; x++) {
          const si = ((ty * tilePx + y) * W + (tx * tilePx + x)) * 4
          const al = base[si + 3]
          if (al > 0) { r += base[si] * al; g += base[si + 1] * al; b += base[si + 2] * al; a += al }
        }
      }
      means[ty * tilesX + tx] = a > 0 ? [Math.round(r / a), Math.round(g / a), Math.round(b / a)] : null
      gr += r; gg += g; gb += b; ga += a
    }
  }
  const global = ga > 0 ? [Math.round(gr / ga), Math.round(gg / ga), Math.round(gb / ga)] : [128, 128, 128]
  return { means, global, tilesX }
}

// Copy the atlas, replacing each tile's fully-transparent pixels' RGB with that tile's mean opaque colour
// (alpha untouched). This "alpha bleed"/dilation stops black bleeding into cutout textures when the base
// level cross-fades with a coarser mip. (Semi-transparent pixels already carry colour, so leave them.)
function bleedTransparentTiles (base, W, H, tilePx, tm) {
  const out = base.slice()
  const tilesX = W / tilePx, tilesY = H / tilePx
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const m = tm.means[ty * tilesX + tx]
      if (!m) continue // fully transparent tile — nothing to bleed
      for (let y = 0; y < tilePx; y++) {
        for (let x = 0; x < tilePx; x++) {
          const si = ((ty * tilePx + y) * W + (tx * tilePx + x)) * 4
          if (out[si + 3] < 8) { out[si] = m[0]; out[si + 1] = m[1]; out[si + 2] = m[2] }
        }
      }
    }
  }
  return out
}

function buildTileMips (base, W, H, tilePx, levels, tm) {
  const tilesX = W / tilePx, tilesY = H / tilePx
  const gm = tm ? tm.global : [0, 0, 0]
  const out = []
  for (let L = 1; L <= levels; L++) {
    const dTile = tilePx >> L
    if (dTile < 1) break
    const ratio = tilePx / dTile // src px per dst px, per axis
    const dW = tilesX * dTile, dH = tilesY * dTile
    const data = new Uint8Array(dW * dH * 4)
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const sTX = tx * tilePx, sTY = ty * tilePx
        const dTX = tx * dTile, dTY = ty * dTile
        for (let dy = 0; dy < dTile; dy++) {
          for (let dx = 0; dx < dTile; dx++) {
            let ar = 0, ag = 0, ab = 0, aa = 0
            for (let sy = 0; sy < ratio; sy++) {
              for (let sx = 0; sx < ratio; sx++) {
                const si = ((sTY + dy * ratio + sy) * W + (sTX + dx * ratio + sx)) * 4
                const a = base[si + 3]
                ar += base[si] * a; ag += base[si + 1] * a; ab += base[si + 2] * a; aa += a
              }
            }
            const di = ((dTY + dy) * dW + (dTX + dx)) * 4
            if (aa > 0) { data[di] = ar / aa; data[di + 1] = ag / aa; data[di + 2] = ab / aa }
            else { const m = (tm && tm.means[ty * tilesX + tx]) || gm; data[di] = m[0]; data[di + 1] = m[1]; data[di + 2] = m[2] } // fill transparent with tile colour, not black
            data[di + 3] = Math.round(aa / (ratio * ratio))
          }
        }
      }
    }
    out.push({ data, width: dW, height: dH })
  }
  // Continue the chain DOWN TO 1x1 so it's COMPLETE (an incomplete chain renders BLACK, and headless-gl is
  // WebGL1 so we CAN'T clamp with TEXTURE_MAX_LEVEL — verified INVALID_ENUM). Below the per-tile limit a tile is
  // <1px so these levels unavoidably mix atlas-neighbour tiles; a 2x2 alpha-weighted box average keeps that
  // blend SMOOTH + desaturated (a uniform haze-like tint) rather than the spiky wrong-colour picks a nearest
  // grab produced. Only reached where a whole block is already sub-pixel / at extreme grazing. A fully bleed-
  // free distance needs a WebGL2 texture-array backend or an atlas with gutters (deferred). See
  // [[hifi-renderer-stair-gap]].
  let prev = out.length ? out[out.length - 1] : { data: base, width: W, height: H }
  while (prev.width > 1 || prev.height > 1) {
    const nW = Math.max(1, prev.width >> 1), nH = Math.max(1, prev.height >> 1)
    const data = new Uint8Array(nW * nH * 4)
    for (let y = 0; y < nH; y++) {
      for (let x = 0; x < nW; x++) {
        let ar = 0, ag = 0, ab = 0, aa = 0
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const px = Math.min(prev.width - 1, x * 2 + sx), py = Math.min(prev.height - 1, y * 2 + sy)
            const si = (py * prev.width + px) * 4
            const a = prev.data[si + 3]
            ar += prev.data[si] * a; ag += prev.data[si + 1] * a; ab += prev.data[si + 2] * a; aa += a
          }
        }
        const di = (y * nW + x) * 4
        if (aa > 0) { data[di] = ar / aa; data[di + 1] = ag / aa; data[di + 2] = ab / aa } else { data[di] = gm[0]; data[di + 1] = gm[1]; data[di + 2] = gm[2] } // sub-tile levels: global mean, not black
        data[di + 3] = Math.round(aa / 4)
      }
    }
    const lvl = { data, width: nW, height: nH }
    out.push(lvl); prev = lvl
  }
  return out
}

class WorldRenderer {
  constructor (scene, numWorkers = 4) {
    this.sectionMeshs = {}
    this.sectionMeshsT = {} // translucent (glass/ice) meshes, drawn in a blended pass
    this.active = false
    this.version = undefined
    this.scene = scene
    this.loadedChunks = {}
    this.sectionsOutstanding = new Set()
    this.renderUpdateEmitter = new EventEmitter()
    this.blockStatesData = undefined
    this.texturesDataUrl = undefined

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1 })
    // Translucent pass for glass/ice/etc.: real alpha blending with depthWrite off,
    // drawn after the solid pass (high renderOrder) so it tints what's behind it
    // instead of the flat cutout the solid material does.
    this.tMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false })

    this.workers = []
    for (let i = 0; i < numWorkers; i++) {
      // Node environement needs an absolute path, but browser needs the url of the file
      let src = __dirname
      if (typeof window !== 'undefined') src = 'worker.js'
      else src += '/worker.js'

      const worker = new Worker(src)
      worker.onmessage = ({ data }) => {
        if (data.type === 'geometry') {
          for (const store of [this.sectionMeshs, this.sectionMeshsT]) {
            const old = store[data.key]
            if (old) { this.scene.remove(old); dispose3(old); delete store[data.key] }
          }

          const chunkCoords = data.key.split(',')
          if (!this.loadedChunks[chunkCoords[0] + ',' + chunkCoords[2]]) return

          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(data.geometry.positions, 3))
          geometry.setAttribute('normal', new THREE.BufferAttribute(data.geometry.normals, 3))
          geometry.setAttribute('color', new THREE.BufferAttribute(data.geometry.colors, 3))
          geometry.setAttribute('uv', new THREE.BufferAttribute(data.geometry.uvs, 2))
          geometry.setIndex(data.geometry.indices)

          const mesh = new THREE.Mesh(geometry, this.material)
          mesh.position.set(data.geometry.sx, data.geometry.sy, data.geometry.sz)
          this.sectionMeshs[data.key] = mesh
          this.scene.add(mesh)

          // Second mesh for the translucent (glass/ice) faces, drawn after the solid pass.
          const t = data.geometry.translucent
          if (t && t.positions.length > 0) {
            const tg = new THREE.BufferGeometry()
            tg.setAttribute('position', new THREE.BufferAttribute(t.positions, 3))
            tg.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3))
            tg.setAttribute('color', new THREE.BufferAttribute(t.colors, 3))
            tg.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2))
            tg.setIndex(t.indices)
            const tmesh = new THREE.Mesh(tg, this.tMaterial)
            tmesh.position.set(data.geometry.sx, data.geometry.sy, data.geometry.sz)
            tmesh.renderOrder = 1000
            this.sectionMeshsT[data.key] = tmesh
            this.scene.add(tmesh)
          }
        } else if (data.type === 'sectionFinished') {
          this.sectionsOutstanding.delete(data.key)
          this.renderUpdateEmitter.emit('update')
        }
      }
      if (worker.on) worker.on('message', (data) => { worker.onmessage({ data }) })
      // A worker_threads Worker with no 'error' listener rethrows on the main thread and takes the
      // whole (MCP) process down. Log instead so a mesher bug degrades one render, not the server.
      if (worker.on) {
        worker.on('error', (err) => {
          try { console.error('[prismarine-viewer worker error]', (err && err.stack) || err) } catch (e) { /* ignore */ }
        })
      }
      this.workers.push(worker)
    }
  }

  resetWorld () {
    this.active = false
    for (const store of [this.sectionMeshs, this.sectionMeshsT]) {
      for (const mesh of Object.values(store)) this.scene.remove(mesh)
    }
    this.sectionMeshs = {}
    this.sectionMeshsT = {}
    for (const worker of this.workers) {
      worker.postMessage({ type: 'reset' })
    }
  }

  setVersion (version) {
    this.version = version
    this.resetWorld()
    this.active = true
    for (const worker of this.workers) {
      worker.postMessage({ type: 'version', version })
    }

    this.updateTexturesData()
  }

  // Clip meshing to a region box (bot-less render_region): the mesher treats anything outside as an
  // unloaded neighbour and culls the cut faces, so a bounded build stops looking like a floating slab
  // with water walls at the edges. Pass null to clear. Call AFTER setVersion (resetWorld clears it).
  setRegionBounds (bounds) {
    this.regionBounds = bounds || null
    for (const worker of this.workers) {
      worker.postMessage({ type: 'regionBounds', bounds: this.regionBounds })
    }
  }

  // Bot-less render_region: tint water/grass/foliage by the real region biome (id) instead of always
  // plains. Pass null to clear. Call AFTER setVersion (which resets workers).
  setDefaultBiome (biome) {
    this.defaultBiome = (biome == null ? null : biome)
    for (const worker of this.workers) {
      worker.postMessage({ type: 'defaultBiome', biome: this.defaultBiome })
    }
  }

  updateTexturesData () {
    loadTexture(this.texturesDataUrl || `textures/${this.version}.png`, texture => {
      texture.magFilter = THREE.NearestFilter // crisp pixels up close
      // PER-TILE MIPMAPS. The block texture is a packed ATLAS (a 16px-tile grid). Naive generateMipmaps averages
      // the WHOLE atlas per level, so coarse mips blend ACROSS tile boundaries → distant flat surfaces get a
      // colour BLEED (e.g. grey stone_bricks tinting orange from a neighbour tile — round-8/9 #3), and anisotropy
      // pulled those bled levels even up close. Turning mipmaps OFF removes the bleed but brings back MOIRE/smear
      // on distant flats. The correct fix (both): build the mip chain OURSELVES, downsampling EACH 16px tile
      // INDEPENDENTLY (alpha-weighted box filter) so a tile's mips only ever contain that tile → no cross-tile
      // bleed AND full anti-aliasing. NearestMipmapLinear then keeps crisp pixels within a level + a smooth LOD
      // cross-fade (no #15 band). See [[hifi-renderer-stair-gap]].
      try {
        const base = texture.image
        if (base && base.data && base.width % 16 === 0 && base.height % 16 === 0) {
          // Alpha-bleed the atlas (transparent pixels -> tile's mean colour) so cutout textures (grass/leaves/
          // flowers) don't cross-fade toward black at distance (user note #4). Level 0 uses the bled copy too.
          const tm = computeTileMeans(base.data, base.width, base.height, 16)
          const bled = bleedTransparentTiles(base.data, base.width, base.height, 16, tm)
          const mips = buildTileMips(bled, base.width, base.height, 16, 4, tm)
          if (mips.length) {
            texture.mipmaps = [{ data: bled, width: base.width, height: base.height }, ...mips]
            texture.minFilter = THREE.NearestMipmapLinearFilter
            texture.generateMipmaps = false
          } else { texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false }
        } else { texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false }
      } catch { texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false }
      texture.flipY = false
      this.material.map = texture
      this.tMaterial.map = texture
    })

    const loadBlockStates = () => {
      return new Promise(resolve => {
        if (this.blockStatesData) return resolve(this.blockStatesData)
        return loadJSON(`blocksStates/${this.version}.json`, resolve)
      })
    }
    loadBlockStates().then((blockStates) => {
      for (const worker of this.workers) {
        worker.postMessage({ type: 'blockStates', json: blockStates })
      }
    })
  }

  addColumn (x, z, chunk) {
    this.loadedChunks[`${x},${z}`] = true
    for (const worker of this.workers) {
      worker.postMessage({ type: 'chunk', x, z, chunk })
    }
    for (let y = -64; y < 320; y += 16) {
      const loc = new Vec3(x, y, z)
      this.setSectionDirty(loc)
      this.setSectionDirty(loc.offset(-16, 0, 0))
      this.setSectionDirty(loc.offset(16, 0, 0))
      this.setSectionDirty(loc.offset(0, 0, -16))
      this.setSectionDirty(loc.offset(0, 0, 16))
    }
  }

  removeColumn (x, z) {
    delete this.loadedChunks[`${x},${z}`]
    for (const worker of this.workers) {
      worker.postMessage({ type: 'unloadChunk', x, z })
    }
    for (let y = -64; y < 320; y += 16) {
      this.setSectionDirty(new Vec3(x, y, z), false)
      const key = `${x},${y},${z}`
      for (const store of [this.sectionMeshs, this.sectionMeshsT]) {
        const mesh = store[key]
        if (mesh) { this.scene.remove(mesh); dispose3(mesh) }
        delete store[key]
      }
    }
  }

  setBlockStateId (pos, stateId) {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'blockUpdate', pos, stateId })
    }
    this.setSectionDirty(pos)
    if ((pos.x & 15) === 0) this.setSectionDirty(pos.offset(-16, 0, 0))
    if ((pos.x & 15) === 15) this.setSectionDirty(pos.offset(16, 0, 0))
    if ((pos.y & 15) === 0) this.setSectionDirty(pos.offset(0, -16, 0))
    if ((pos.y & 15) === 15) this.setSectionDirty(pos.offset(0, 16, 0))
    if ((pos.z & 15) === 0) this.setSectionDirty(pos.offset(0, 0, -16))
    if ((pos.z & 15) === 15) this.setSectionDirty(pos.offset(0, 0, 16))
  }

  setSectionDirty (pos, value = true) {
    // Dispatch sections to workers based on position
    // This guarantees uniformity accross workers and that a given section
    // is always dispatched to the same worker
    const hash = mod(Math.floor(pos.x / 16) + Math.floor(pos.y / 16) + Math.floor(pos.z / 16), this.workers.length)
    this.workers[hash].postMessage({ type: 'dirty', x: pos.x, y: pos.y, z: pos.z, value })
    this.sectionsOutstanding.add(`${Math.floor(pos.x / 16) * 16},${Math.floor(pos.y / 16) * 16},${Math.floor(pos.z / 16) * 16}`)
  }

  // Listen for chunk rendering updates emitted if a worker finished a render and resolve if the number
  // of sections not rendered are 0
  waitForChunksToRender () {
    return new Promise((resolve, reject) => {
      if (Array.from(this.sectionsOutstanding).length === 0) {
        resolve()
        return
      }

      const updateHandler = () => {
        if (this.sectionsOutstanding.size === 0) {
          this.renderUpdateEmitter.removeListener('update', updateHandler)
          resolve()
        }
      }
      this.renderUpdateEmitter.on('update', updateHandler)
    })
  }
}

module.exports = { WorldRenderer }
