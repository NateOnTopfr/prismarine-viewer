/* global Worker */
const THREE = require('three')
const Vec3 = require('vec3').Vec3
const { loadTexture, loadJSON } = globalThis.isElectron ? require('./utils.electron.js') : require('./utils')
const { EventEmitter } = require('events')
const { dispose3 } = require('./dispose')

function mod (x, n) {
  return ((x % n) + n) % n
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

  updateTexturesData () {
    loadTexture(this.texturesDataUrl || `textures/${this.version}.png`, texture => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
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
