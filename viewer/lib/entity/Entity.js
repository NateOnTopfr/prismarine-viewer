/* global THREE */

const entities = require('./entities.json')
const { loadTexture } = globalThis.isElectron ? require('../utils.electron.js') : require('../utils')

// Entity textures load from the CURRENT asset version (minecraft-assets, 1.21.x) so new
// content (decorated pots, current skins, …) renders — the bundled public/textures/1.16.4
// set is only a fallback for anything the package doesn't ship. (node render path only.)
const _fs = require('fs')
const _path = require('path')
let _cc = null; let _Img = null
try { const c = require('canvas'); _cc = c.createCanvas; _Img = c.Image } catch { /* browser build */ }
// minecraft-assets entity dir for a version — the package auto-resolves to the NEAREST
// bundled version (e.g. 1.21.3 -> 1.21.8), so we can pass the running server version straight
// through and get matching assets. Cached; falls back down a list if the package is missing.
const _maDirCache = {}
function maEntityDir (version) {
  const key = version || 'default'
  if (_maDirCache[key] !== undefined) return _maDirCache[key]
  let dir = null
  try { dir = _path.join(require('minecraft-assets')(version).directory, 'entity') } catch {
    for (const v of ['1.21.8', '1.21.1', '1.20.2', '1.19.1']) { try { dir = _path.join(require('minecraft-assets')(v).directory, 'entity'); break } catch { /* next */ } }
  }
  _maDirCache[key] = dir
  return dir
}
const _forkPublic = _path.resolve(__dirname, '../../../public')
// texture arg is "textures/<version>/entity/chest/normal.png" — resolve the real file for that
// version from minecraft-assets, with the bundled 1.16.4 set as a last-resort fallback.
function resolveEntityTexture (texture) {
  try {
    const s = String(texture)
    const after = s.split('/entity/')[1]
    if (!after) { const p0 = _path.join(_forkPublic, s); return _fs.existsSync(p0) ? p0 : null }
    const m = s.match(/textures\/([^/]+)\/entity\//)
    const dir = maEntityDir(m ? m[1] : undefined)
    if (dir) { const f = _path.join(dir, after); if (_fs.existsSync(f)) return f }
    const pub = _path.join(_forkPublic, 'textures', '1.16.4', 'entity', after)
    if (_fs.existsSync(pub)) return pub
  } catch { /* fall through */ }
  return null
}
function loadTextureAbs (file, cb) {
  try {
    const img = new _Img(); img.src = _fs.readFileSync(file)
    const c = _cc(img.width || 16, img.height || 16)
    c.getContext('2d').drawImage(img, 0, 0)
    cb(new THREE.Texture(c))
  } catch { /* skip */ }
}

const elemFaces = {
  up: {
    dir: [0, 1, 0],
    u0: [0, 0, 1],
    v0: [0, 0, 0],
    u1: [1, 0, 1],
    v1: [0, 0, 1],
    corners: [
      [0, 1, 1, 0, 0],
      [1, 1, 1, 1, 0],
      [0, 1, 0, 0, 1],
      [1, 1, 0, 1, 1]
    ]
  },
  down: {
    dir: [0, -1, 0],
    u0: [1, 0, 1],
    v0: [0, 0, 0],
    u1: [2, 0, 1],
    v1: [0, 0, 1],
    corners: [
      [1, 0, 1, 0, 0],
      [0, 0, 1, 1, 0],
      [1, 0, 0, 0, 1],
      [0, 0, 0, 1, 1]
    ]
  },
  east: {
    dir: [1, 0, 0],
    u0: [0, 0, 0],
    v0: [0, 0, 1],
    u1: [0, 0, 1],
    v1: [0, 1, 1],
    corners: [
      [1, 1, 1, 0, 0],
      [1, 0, 1, 0, 1],
      [1, 1, 0, 1, 0],
      [1, 0, 0, 1, 1]
    ]
  },
  west: {
    dir: [-1, 0, 0],
    u0: [1, 0, 1],
    v0: [0, 0, 1],
    u1: [1, 0, 2],
    v1: [0, 1, 1],
    corners: [
      [0, 1, 0, 0, 0],
      [0, 0, 0, 0, 1],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 1, 1]
    ]
  },
  north: {
    dir: [0, 0, -1],
    u0: [0, 0, 1],
    v0: [0, 0, 1],
    u1: [1, 0, 1],
    v1: [0, 1, 1],
    corners: [
      [1, 0, 0, 0, 1],
      [0, 0, 0, 1, 1],
      [1, 1, 0, 0, 0],
      [0, 1, 0, 1, 0]
    ]
  },
  south: {
    dir: [0, 0, 1],
    u0: [1, 0, 2],
    v0: [0, 0, 1],
    u1: [2, 0, 2],
    v1: [0, 1, 1],
    corners: [
      [0, 0, 1, 0, 1],
      [1, 0, 1, 1, 1],
      [0, 1, 1, 0, 0],
      [1, 1, 1, 1, 0]
    ]
  }
}

function dot (a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function addCube (attr, boneId, bone, cube, texWidth = 64, texHeight = 64) {
  const cubeRotation = new THREE.Euler(0, 0, 0)
  if (cube.rotation) {
    cubeRotation.x = -cube.rotation[0] * Math.PI / 180
    cubeRotation.y = -cube.rotation[1] * Math.PI / 180
    cubeRotation.z = -cube.rotation[2] * Math.PI / 180
  }
  for (const { dir, corners, u0, v0, u1, v1 } of Object.values(elemFaces)) {
    const ndx = Math.floor(attr.positions.length / 3)

    for (const pos of corners) {
      const u = (cube.uv[0] + dot(pos[3] ? u1 : u0, cube.size)) / texWidth
      const v = (cube.uv[1] + dot(pos[4] ? v1 : v0, cube.size)) / texHeight

      const inflate = cube.inflate ? cube.inflate : 0
      let vecPos = new THREE.Vector3(
        cube.origin[0] + pos[0] * cube.size[0] + (pos[0] ? inflate : -inflate),
        cube.origin[1] + pos[1] * cube.size[1] + (pos[1] ? inflate : -inflate),
        cube.origin[2] + pos[2] * cube.size[2] + (pos[2] ? inflate : -inflate)
      )

      vecPos = vecPos.applyEuler(cubeRotation)
      vecPos = vecPos.sub(bone.position)
      vecPos = vecPos.applyEuler(bone.rotation)
      vecPos = vecPos.add(bone.position)

      attr.positions.push(vecPos.x, vecPos.y, vecPos.z)
      attr.normals.push(...dir)
      attr.uvs.push(u, v)
      attr.skinIndices.push(boneId, 0, 0, 0)
      attr.skinWeights.push(1, 0, 0, 0)
    }

    attr.indices.push(
      ndx, ndx + 1, ndx + 2,
      ndx + 2, ndx + 1, ndx + 3
    )
  }
}

function getMesh (texture, jsonModel) {
  const bones = {}

  // The bundled entity geometry declares LEGACY texture dims (e.g. zombie/player textureheight:32), but modern
  // minecraft-assets ships 64x64 textures. The legacy pixel-UVs address the SAME top-half regions on a 64x64
  // atlas, so if we normalise by the declared 32 the V coord samples the wrong rows → the skin is SCRAMBLED
  // (head on the arms, face on the legs). Read the ACTUAL texture dimensions from the PNG header (IHDR) and
  // normalise by those, so legacy UVs land on the correct regions of whatever-size texture actually ships.
  let texW = jsonModel.texturewidth || 64
  let texH = jsonModel.textureheight || 64
  try {
    const abs = resolveEntityTexture(texture)
    if (abs) {
      const buf = _fs.readFileSync(abs)
      if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
        texW = buf.readUInt32BE(16); texH = buf.readUInt32BE(20)
      }
    }
  } catch { /* fall back to the declared dims */ }

  const geoData = {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    skinIndices: [],
    skinWeights: []
  }
  let i = 0
  for (const jsonBone of jsonModel.bones) {
    const bone = new THREE.Bone()
    if (jsonBone.pivot) {
      bone.position.x = jsonBone.pivot[0]
      bone.position.y = jsonBone.pivot[1]
      bone.position.z = jsonBone.pivot[2]
    }
    if (jsonBone.bind_pose_rotation) {
      bone.rotation.x = -jsonBone.bind_pose_rotation[0] * Math.PI / 180
      bone.rotation.y = -jsonBone.bind_pose_rotation[1] * Math.PI / 180
      bone.rotation.z = -jsonBone.bind_pose_rotation[2] * Math.PI / 180
    } else if (jsonBone.rotation) {
      bone.rotation.x = -jsonBone.rotation[0] * Math.PI / 180
      bone.rotation.y = -jsonBone.rotation[1] * Math.PI / 180
      bone.rotation.z = -jsonBone.rotation[2] * Math.PI / 180
    }
    bones[jsonBone.name] = bone

    if (jsonBone.cubes) {
      for (const cube of jsonBone.cubes) {
        addCube(geoData, i, bone, cube, texW, texH)
      }
    }
    i++
  }

  const rootBones = []
  for (const jsonBone of jsonModel.bones) {
    if (jsonBone.parent) bones[jsonBone.parent].add(bones[jsonBone.name])
    else rootBones.push(bones[jsonBone.name])
  }

  const skeleton = new THREE.Skeleton(Object.values(bones))

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(geoData.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(geoData.normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(geoData.uvs, 2))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(geoData.skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(geoData.skinWeights, 4))
  geometry.setIndex(geoData.indices)

  // Standard SkinnedMesh + translucent-overlay material (upstream). The entity-collapse bug was NOT here —
  // it was the UV normalisation above (legacy textureheight:32 vs the real 64x64 texture) scrambling the skin
  // so the body sampled transparent atlas-padding and alphaTest discarded it, which merely LOOKED like a
  // skinning/depth-write collapse. With the UV fix, all four mesh/material combos render identically (verified
  // via an isolated render matrix), so we keep the minimal upstream form: SkinnedMesh works fine under
  // headless-gl, and `transparent:true` is correct for the semi-transparent 2nd (hat/jacket) skin layer.
  const material = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.1 })
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.add(...rootBones)
  mesh.scale.set(1 / 16, 1 / 16, 1 / 16)
  mesh.updateMatrixWorld(true) // ensure bone world matrices reflect scale+pivots before bind
  mesh.bind(skeleton)

  const applyTex = (t) => {
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.NearestFilter
    t.flipY = false
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.needsUpdate = true
    material.map = t
    material.needsUpdate = true
  }
  const abs = (_cc && _Img) ? resolveEntityTexture(texture) : null
  if (abs) loadTextureAbs(abs, applyTex)
  else loadTexture(texture, applyTex)

  return mesh
}

class Entity {
  constructor (version, type, scene) {
    const e = entities[type]
    if (!e) throw new Error(`Unknown entity ${type}`)

    this.mesh = new THREE.Object3D()
    for (const [name, jsonModel] of Object.entries(e.geometry)) {
      const texture = e.textures[name]
      if (!texture) continue
      // console.log(JSON.stringify(jsonModel, null, 2))
      const mesh = getMesh(texture.replace('textures', 'textures/' + version) + '.png', jsonModel)
      /* const skeletonHelper = new THREE.SkeletonHelper( mesh )
      skeletonHelper.material.linewidth = 2
      scene.add( skeletonHelper ) */
      this.mesh.add(mesh)
    }
  }
}

module.exports = Entity
