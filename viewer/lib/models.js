const { Vec3 } = require('vec3')

const tints = require('minecraft-data')('1.16.2').tints

for (const key of Object.keys(tints)) {
  tints[key] = prepareTints(tints[key])
}

function prepareTints (tints) {
  const map = new Map()
  const defaultValue = tintToGl(tints.default)
  for (let { keys, color } of tints.data) {
    color = tintToGl(color)
    for (const key of keys) {
      map.set(`${key}`, color)
    }
  }
  return new Proxy(map, {
    get: (target, key) => {
      return target.has(key) ? target.get(key) : defaultValue
    }
  })
}

function tintToGl (tint) {
  const r = (tint >> 16) & 0xff
  const g = (tint >> 8) & 0xff
  const b = tint & 0xff
  return [r / 255, g / 255, b / 255]
}

const elemFaces = {
  up: {
    dir: [0, 1, 0],
    mask1: [1, 1, 0],
    mask2: [0, 1, 1],
    corners: [
      [0, 1, 1, 0, 1],
      [1, 1, 1, 1, 1],
      [0, 1, 0, 0, 0],
      [1, 1, 0, 1, 0]
    ]
  },
  down: {
    dir: [0, -1, 0],
    mask1: [1, 1, 0],
    mask2: [0, 1, 1],
    corners: [
      [1, 0, 1, 0, 1],
      [0, 0, 1, 1, 1],
      [1, 0, 0, 0, 0],
      [0, 0, 0, 1, 0]
    ]
  },
  east: {
    dir: [1, 0, 0],
    mask1: [1, 1, 0],
    mask2: [1, 0, 1],
    corners: [
      [1, 1, 1, 0, 0],
      [1, 0, 1, 0, 1],
      [1, 1, 0, 1, 0],
      [1, 0, 0, 1, 1]
    ]
  },
  west: {
    dir: [-1, 0, 0],
    mask1: [1, 1, 0],
    mask2: [1, 0, 1],
    corners: [
      [0, 1, 0, 0, 0],
      [0, 0, 0, 0, 1],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 1, 1]
    ]
  },
  north: {
    dir: [0, 0, -1],
    mask1: [1, 0, 1],
    mask2: [0, 1, 1],
    corners: [
      [1, 0, 0, 0, 1],
      [0, 0, 0, 1, 1],
      [1, 1, 0, 0, 0],
      [0, 1, 0, 1, 0]
    ]
  },
  south: {
    dir: [0, 0, 1],
    mask1: [1, 0, 1],
    mask2: [0, 1, 1],
    corners: [
      [0, 0, 1, 0, 1],
      [1, 0, 1, 1, 1],
      [0, 1, 1, 0, 0],
      [1, 1, 1, 1, 0]
    ]
  }
}

function getLiquidRenderHeight (world, block, type) {
  if (!block || block.type !== type) return 1 / 9
  if (block.metadata === 0) { // source block
    const blockAbove = world.getBlock(block.position.offset(0, 1, 0))
    if (blockAbove && blockAbove.type === type) return 1
    return 8 / 9
  }
  return ((block.metadata >= 8 ? 8 : 7 - block.metadata) + 1) / 9
}

function renderLiquid (world, cursor, texture, type, biome, water, attr) {
  const heights = []
  for (let z = -1; z <= 1; z++) {
    for (let x = -1; x <= 1; x++) {
      heights.push(getLiquidRenderHeight(world, world.getBlock(cursor.offset(x, 0, z)), type))
    }
  }
  const cornerHeights = [
    Math.max(Math.max(heights[0], heights[1]), Math.max(heights[3], heights[4])),
    Math.max(Math.max(heights[1], heights[2]), Math.max(heights[4], heights[5])),
    Math.max(Math.max(heights[3], heights[4]), Math.max(heights[6], heights[7])),
    Math.max(Math.max(heights[4], heights[5]), Math.max(heights[7], heights[8]))
  ]

  for (const face in elemFaces) {
    const { dir, corners } = elemFaces[face]
    const isUp = dir[1] === 1

    const neighbor = world.getBlock(cursor.offset(...dir))
    if (!neighbor) continue
    if (neighbor.type === type) continue
    if ((neighbor.isCube && !isUp) || neighbor.material === 'plant' || neighbor.getProperties().waterlogged) continue
    // (removed: `if (neighbor.position.y < 0) continue` — a stale guard that dropped EVERY liquid face
    // whose neighbour sits below y=0, i.e. ALL water/lava in a 1.18+ negative-Y world (y-64..0). It made
    // water render completely invisible in render_region/terrain. The solid path already dropped the
    // same guard; liquids kept it, so water never showed. This is the fix for "vision wasn't showing water".)

    let tint = [1, 1, 1]
    if (water) {
      let m = 1 // Fake lighting to improve lisibility
      if (Math.abs(dir[0]) > 0) m = 0.6
      else if (Math.abs(dir[2]) > 0) m = 0.8
      tint = tints.water[biome] || tints.water.plains || [0.25, 0.46, 0.9] // fallback: biome tint may be absent
      tint = [tint[0] * m, tint[1] * m, tint[2] * m]
    }

    const u = texture.u
    const v = texture.v
    const su = texture.su
    const sv = texture.sv

    for (const pos of corners) {
      const height = cornerHeights[pos[2] * 2 + pos[0]]
      attr.t_positions.push(
        (pos[0] ? 1 : 0) + (cursor.x & 15) - 8,
        (pos[1] ? height : 0) + (cursor.y & 15) - 8,
        (pos[2] ? 1 : 0) + (cursor.z & 15) - 8)
      attr.t_normals.push(...dir)
      attr.t_uvs.push(pos[3] * su + u, pos[4] * sv * (pos[1] ? 1 : height) + v)
      attr.t_colors.push(tint[0], tint[1], tint[2])
    }
  }
}

function vecadd3 (a, b) {
  if (!b) return a
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function vecsub3 (a, b) {
  if (!b) return a
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function matmul3 (matrix, vector) {
  if (!matrix) return vector
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
  ]
}

function matmulmat3 (a, b) {
  const te = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]

  const a11 = a[0][0]; const a12 = a[1][0]; const a13 = a[2][0]
  const a21 = a[0][1]; const a22 = a[1][1]; const a23 = a[2][1]
  const a31 = a[0][2]; const a32 = a[1][2]; const a33 = a[2][2]

  const b11 = b[0][0]; const b12 = b[1][0]; const b13 = b[2][0]
  const b21 = b[0][1]; const b22 = b[1][1]; const b23 = b[2][1]
  const b31 = b[0][2]; const b32 = b[1][2]; const b33 = b[2][2]

  te[0][0] = a11 * b11 + a12 * b21 + a13 * b31
  te[1][0] = a11 * b12 + a12 * b22 + a13 * b32
  te[2][0] = a11 * b13 + a12 * b23 + a13 * b33

  te[0][1] = a21 * b11 + a22 * b21 + a23 * b31
  te[1][1] = a21 * b12 + a22 * b22 + a23 * b32
  te[2][1] = a21 * b13 + a22 * b23 + a23 * b33

  te[0][2] = a31 * b11 + a32 * b21 + a33 * b31
  te[1][2] = a31 * b12 + a32 * b22 + a33 * b32
  te[2][2] = a31 * b13 + a32 * b23 + a33 * b33

  return te
}

function buildRotationMatrix (axis, degree) {
  const radians = degree / 180 * Math.PI
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  const axis0 = { x: 0, y: 1, z: 2 }[axis]
  const axis1 = (axis0 + 1) % 3
  const axis2 = (axis0 + 2) % 3

  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]

  matrix[axis0][axis0] = 1
  matrix[axis1][axis1] = cos
  matrix[axis1][axis2] = -sin
  matrix[axis2][axis1] = +sin
  matrix[axis2][axis2] = cos

  return matrix
}

function renderElement (world, cursor, element, doAO, attr, globalMatrix, globalShift, block, biome) {
  const cullIfIdentical = block.name.indexOf('glass') >= 0

  for (const face in element.faces) {
    const eFace = element.faces[face]
    const { corners, mask1, mask2 } = elemFaces[face]
    const dir = matmul3(globalMatrix, elemFaces[face].dir)

    if (eFace.cullface) {
      const neighbor = world.getBlock(cursor.plus(new Vec3(...dir)))
      if (!neighbor) continue
      if (cullIfIdentical && neighbor.type === block.type) continue
      if (!neighbor.transparent && neighbor.isCube) continue
      // (removed: `if (neighbor.position.y < 0) continue` — it culled every face
      // whose neighbor sits below y=0, breaking all terrain in 1.18+ negative-Y worlds.)
    }

    // Bake the real light level of the air this face is exposed to (server sky + block light),
    // once per face. Open faces read skyLight 15; enclosed read low; emitters raise blockLight.
    // Floored so nothing is pure black. skyLight assumes daytime (renders are day by default).
    let faceLight = 1
    {
      const lb = world.getBlock(cursor.plus(new Vec3(...dir)))
      const sky = (lb && lb.skyLight != null) ? lb.skyLight : 15
      const blk = (lb && lb.light != null) ? lb.light : 0
      const lvl = Math.min(15, Math.max(blk, sky))
      faceLight = 0.12 + 0.88 * (lvl / 15)
      // Emissive self-glow: a light-SOURCE block renders its own faces bright regardless of the
      // (often dim) neighbour light — so torches/glowstone/lava/lanterns visibly glow in a shot.
      // Not vanilla's client-side bloom, but real self-illumination; neighbour surfaces are still
      // lit by the separate block-light flood-fill in worldView._applyLight.
      let emit = (world.emitLight && world.emitLight[block.name]) || 0
      try {
        if (emit < 13 && block.getProperties && block.getProperties().lit === 'true') emit = 13
      } catch (e) { /* no props */ }
      if (emit > 0) faceLight = Math.max(faceLight, 0.4 + 0.6 * (emit / 15))
    }

    const minx = element.from[0]
    const miny = element.from[1]
    const minz = element.from[2]
    const maxx = element.to[0]
    const maxy = element.to[1]
    const maxz = element.to[2]

    const u = eFace.texture.u
    const v = eFace.texture.v
    const su = eFace.texture.su
    const sv = eFace.texture.sv

    const ndx = Math.floor(attr.positions.length / 3)

    let tint = [1, 1, 1]
    if (eFace.tintindex !== undefined) {
      if (eFace.tintindex === 0) {
        if (block.name === 'redstone_wire') {
          tint = tints.redstone[`${block.getProperties().power}`]
        } else if (block.name === 'birch_leaves' ||
          block.name === 'spruce_leaves' ||
          block.name === 'lily_pad') {
          tint = tints.constant[block.name]
        } else if (block.name.includes('leaves') || block.name === 'vine') {
          tint = tints.foliage[biome]
        } else {
          tint = tints.grass[biome]
        }
      }
    }

    // UV rotation
    const r = eFace.rotation || 0
    const uvcs = Math.cos(r * Math.PI / 180)
    const uvsn = -Math.sin(r * Math.PI / 180)

    let localMatrix = null
    let localShift = null

    if (element.rotation) {
      localMatrix = buildRotationMatrix(
        element.rotation.axis,
        element.rotation.angle
      )

      localShift = vecsub3(
        element.rotation.origin,
        matmul3(
          localMatrix,
          element.rotation.origin
        )
      )
    }

    const aos = []
    for (const pos of corners) {
      let vertex = [
        (pos[0] ? maxx : minx),
        (pos[1] ? maxy : miny),
        (pos[2] ? maxz : minz)
      ]

      vertex = vecadd3(matmul3(localMatrix, vertex), localShift)
      // Element rescale: a rotated element with `rescale` grows along the two axes
      // perpendicular to the rotation axis by 1/cos(angle), so 45°/22.5° parts
      // (rails, hoppers, levers) fill the block instead of rendering undersized.
      if (element.rotation && element.rotation.rescale) {
        const a = Math.abs(element.rotation.angle || 0) * Math.PI / 180
        const s = a ? 1 / Math.cos(a) : 1
        const origin = element.rotation.origin
        if (element.rotation.axis !== 'x') vertex[0] = origin[0] + (vertex[0] - origin[0]) * s
        if (element.rotation.axis !== 'y') vertex[1] = origin[1] + (vertex[1] - origin[1]) * s
        if (element.rotation.axis !== 'z') vertex[2] = origin[2] + (vertex[2] - origin[2]) * s
      }
      vertex = vecadd3(matmul3(globalMatrix, vertex), globalShift)
      vertex = vertex.map(v => v / 16)

      attr.positions.push(
        vertex[0] + (cursor.x & 15) - 8,
        vertex[1] + (cursor.y & 15) - 8,
        vertex[2] + (cursor.z & 15) - 8
      )

      attr.normals.push(...dir)

      const baseu = (pos[3] - 0.5) * uvcs - (pos[4] - 0.5) * uvsn + 0.5
      const basev = (pos[3] - 0.5) * uvsn + (pos[4] - 0.5) * uvcs + 0.5
      attr.uvs.push(baseu * su + u, basev * sv + v)

      let light = 1
      if (doAO) {
        const dx = pos[0] * 2 - 1
        const dy = pos[1] * 2 - 1
        const dz = pos[2] * 2 - 1
        const cornerDir = matmul3(globalMatrix, [dx, dy, dz])
        const side1Dir = matmul3(globalMatrix, [dx * mask1[0], dy * mask1[1], dz * mask1[2]])
        const side2Dir = matmul3(globalMatrix, [dx * mask2[0], dy * mask2[1], dz * mask2[2]])
        const side1 = world.getBlock(cursor.offset(...side1Dir))
        const side2 = world.getBlock(cursor.offset(...side2Dir))
        const corner = world.getBlock(cursor.offset(...cornerDir))

        const side1Block = (side1 && side1.isCube) ? 1 : 0
        const side2Block = (side2 && side2.isCube) ? 1 : 0
        const cornerBlock = (corner && corner.isCube) ? 1 : 0

        // Per-corner AO: this block runs once PER VERTEX (the 4 face corners), each sampling its own
        // side1/side2/corner neighbours from its corner direction, and pushes a per-vertex colour below —
        // so the GPU interpolates AO smoothly across the quad. The aos[0]+aos[3]>=aos[1]+aos[2] flip
        // (further down) picks the triangulation diagonal to avoid the classic AO interpolation artifact.
        // (This is the "interpolate AO per corner" the old TODO asked for — already implemented.)
        const ao = (side1Block && side2Block) ? 0 : (3 - (side1Block + side2Block + cornerBlock))
        // AO darkening. The old (ao+1)/4 bottomed out at 0.25 — far harsher than Minecraft's smooth
        // lighting (whose fully-occluded corner is ~0.5), so detailed/tiered builds read gloomy with
        // near-black recesses. Match MC: min 0.5 for a full corner, up to 1.0 open.
        light = 0.5 + 0.5 * (ao / 3)
        aos.push(ao)
      }

      light *= faceLight // combine ambient occlusion with the real baked light level
      // The faceLight "nothing pure black" floor (0.12) was being multiplied AWAY by AO (down to 0.25),
      // so shadowed recesses / floating-island undersides / dark-material corners rendered near-black.
      // Re-apply a TRUE minimum AFTER AO so shadowed geometry stays dark-but-legible in a render.
      if (light < 0.14) light = 0.14
      // Defensive: a non-finite tint/light (e.g. a bad biome-tint lookup or a NaN in a rotated model) would
      // push NaN into the colour buffer, which the GPU clamps to 0 → a block that renders ALL BLACK. Guard
      // each channel so a colour glitch degrades to the light value instead of a black artifact.
      const cr = tint[0] * light, cg = tint[1] * light, cb = tint[2] * light
      attr.colors.push(
        Number.isFinite(cr) ? cr : light,
        Number.isFinite(cg) ? cg : light,
        Number.isFinite(cb) ? cb : light
      )
    }

    if (doAO && aos[0] + aos[3] >= aos[1] + aos[2]) {
      attr.indices.push(
        ndx, ndx + 3, ndx + 2,
        ndx, ndx + 1, ndx + 3
      )
    } else {
      attr.indices.push(
        ndx, ndx + 1, ndx + 2,
        ndx + 2, ndx + 1, ndx + 3
      )
    }
  }
}

// Render a plain textured cube from a model that has no elements. Used as a
// fallback for block-entity / builtin models (chests, beds, signs, banners,
// shulker boxes, heads, bells) which the block-model mesher can't build — this
// at least shows a solid, correctly-tinted-ish block instead of nothing.
// Proportional stand-in shapes for block-entities that ship builtin/entity models
// with no elements (chest/bed/sign/…). Not the true entity geometry (that needs the
// entity texture atlas), but the right SIZE/shape textured with the block's particle
// texture — far better than a uniform 16³ cube. Returns element boxes (0..16).
function fallbackShape (name) {
  if (name.includes('chest')) return [{ from: [1, 0, 1], to: [15, 14, 15] }]        // 7/8 box on the floor
  if (name.includes('bed')) return [{ from: [0, 0, 0], to: [16, 9, 16] }]           // low slab
  if (name.includes('shulker')) return [{ from: [0, 0, 0], to: [16, 12, 16] }]      // closed-ish box
  if (name.includes('decorated_pot')) return [{ from: [1, 0, 1], to: [15, 16, 15] }]
  if (name.includes('flower_pot') || name.endsWith('_pot')) return [{ from: [5, 0, 5], to: [11, 6, 11] }]
  if (name.includes('skull') || name.endsWith('_head')) return [{ from: [4, 0, 4], to: [12, 8, 12] }] // small head cube
  if (name.includes('conduit')) return [{ from: [5, 5, 5], to: [11, 11, 11] }]
  if (name.includes('bell')) return [{ from: [5, 4, 5], to: [11, 12, 11] }]
  if (name.includes('banner')) {                                                    // thin tall board + post
    return [{ from: [0, 0, 7], to: [16, 16, 9] }]
  }
  if (name.includes('hanging_sign')) return [{ from: [1, 2, 7], to: [15, 12, 9] }]
  if (name.includes('wall_sign')) return [{ from: [0, 4, 7], to: [16, 12, 9] }]
  if (name.includes('sign')) {                                                       // standing sign: board + post
    return [{ from: [1, 8, 7], to: [15, 16, 9] }, { from: [7, 0, 7], to: [9, 8, 9] }]
  }
  return [{ from: [0, 0, 0], to: [16, 16, 16] }]                                     // default: full cube
}

// Block-entities we draw as true entity-texture models via the entity overlay pass
// (Entities.addBlockEntityModels) — the mesher must NOT also draw a stand-in box for
// them, or the box z-fights inside the model.
const MODELED_HEADS = new Set([
  'skeleton_skull', 'skeleton_wall_skull', 'wither_skeleton_skull', 'wither_skeleton_wall_skull',
  'zombie_head', 'zombie_wall_head', 'creeper_head', 'creeper_wall_head', 'piglin_head', 'piglin_wall_head',
  'player_head', 'player_wall_head', 'dragon_head', 'dragon_wall_head'
])
function hasEntityModel (name) {
  return name === 'chest' || name === 'trapped_chest' || name === 'ender_chest' ||
    name === 'conduit' || name === 'bell' || name.endsWith('shulker_box') ||
    name.endsWith('_bed') || name.endsWith('banner') || name === 'decorated_pot' ||
    MODELED_HEADS.has(name)
}

function renderFallbackCube (world, cursor, model, attr, block, biome) {
  if (hasEntityModel(block.name)) return
  const tex = model.textures && (model.textures.particle || model.textures.all || Object.values(model.textures)[0])
  if (!tex || tex.su === undefined) return
  const shape = fallbackShape(block.name)
  // A full cube can cull faces against solid neighbours; smaller stand-in shapes
  // don't touch the block boundary, so they must render every face.
  const full = shape.length === 1 && shape[0].to[0] - shape[0].from[0] === 16 &&
    shape[0].to[1] - shape[0].from[1] === 16 && shape[0].to[2] - shape[0].from[2] === 16
  for (const box of shape) {
    const faces = {}
    for (const f of ['up', 'down', 'north', 'south', 'east', 'west']) {
      faces[f] = full ? { texture: tex, cullface: f } : { texture: tex }
    }
    renderElement(world, cursor, { from: box.from, to: box.to, faces }, false, attr, null, null, block, biome)
  }
}

// Blocks that should be drawn in a second, alpha-blended pass so they tint what's
// behind them (true translucency) instead of the flat alpha-cutout the solid pass
// uses. Leaves/plain-glass frames stay in the solid (cutout) pass; water/lava keep
// their existing path.
function isTranslucent (name) {
  return name.includes('stained_glass') ||
    name === 'glass' || name === 'glass_pane' || name === 'tinted_glass' ||
    name === 'ice' || name === 'frosted_ice' || name === 'honey_block' ||
    name === 'slime_block' || name === 'nether_portal' || name === 'bubble_column'
}

function getSectionGeometry (sx, sy, sz, world, blocksStates) {
  const attr = {
    sx: sx + 8,
    sy: sy + 8,
    sz: sz + 8,
    positions: [],
    normals: [],
    colors: [],
    uvs: [],
    t_positions: [],
    t_normals: [],
    t_colors: [],
    t_uvs: [],
    indices: []
  }
  // Separate accumulator for translucent blocks (glass, ice, …) — drawn after the
  // solid pass with depthWrite off so overlapping blocks blend correctly.
  const tattr = { positions: [], normals: [], colors: [], uvs: [], indices: [] }

  const cursor = new Vec3(0, 0, 0)
  for (cursor.y = sy; cursor.y < sy + 16; cursor.y++) {
    for (cursor.z = sz; cursor.z < sz + 16; cursor.z++) {
      for (cursor.x = sx; cursor.x < sx + 16; cursor.x++) {
        const block = world.getBlock(cursor)
        // null = unloaded, or OUTSIDE the render region bounds (see world.setRegionBounds): nothing to
        // mesh here. Skipping it also means the region's outward boundary faces (neighbour lookups
        // return null) cull like an unloaded edge — no floating-slab underside / water walls at the cut.
        if (!block) continue
        const biome = block.biome.name
        if (block.variant === undefined) {
          block.variant = getModelVariants(block, blocksStates)
        }

        for (const variant of block.variant) {
          if (!variant || !variant.model) continue

          if (block.name === 'water') {
            renderLiquid(world, cursor, variant.model.textures.particle, block.type, biome, true, attr)
          } else if (block.name === 'lava') {
            renderLiquid(world, cursor, variant.model.textures.particle, block.type, biome, false, attr)
          } else {
            const target = isTranslucent(block.name) ? tattr : attr
            let globalMatrix = null
            let globalShift = null

            for (const axis of ['x', 'y', 'z']) {
              if (axis in variant) {
                if (!globalMatrix) globalMatrix = buildRotationMatrix(axis, -variant[axis])
                else globalMatrix = matmulmat3(globalMatrix, buildRotationMatrix(axis, -variant[axis]))
              }
            }

            if (globalMatrix) {
              globalShift = [8, 8, 8]
              globalShift = vecsub3(globalShift, matmul3(globalMatrix, globalShift))
            }

            const elements = variant.model.elements
            if (!elements || elements.length === 0) {
              renderFallbackCube(world, cursor, variant.model, target, block, biome)
            } else {
              for (const element of elements) {
                renderElement(world, cursor, element, variant.model.ao, target, globalMatrix, globalShift, block, biome)
              }
            }
          }
        }
      }
    }
  }

  let ndx = attr.positions.length / 3
  for (let i = 0; i < attr.t_positions.length / 12; i++) {
    attr.indices.push(
      ndx, ndx + 1, ndx + 2,
      ndx + 2, ndx + 1, ndx + 3,
      // back face
      ndx, ndx + 2, ndx + 1,
      ndx + 2, ndx + 3, ndx + 1
    )
    ndx += 4
  }

  attr.positions.push(...attr.t_positions)
  attr.normals.push(...attr.t_normals)
  attr.colors.push(...attr.t_colors)
  attr.uvs.push(...attr.t_uvs)

  delete attr.t_positions
  delete attr.t_normals
  delete attr.t_colors
  delete attr.t_uvs

  attr.positions = new Float32Array(attr.positions)
  attr.normals = new Float32Array(attr.normals)
  attr.colors = new Float32Array(attr.colors)
  attr.uvs = new Float32Array(attr.uvs)

  attr.translucent = {
    positions: new Float32Array(tattr.positions),
    normals: new Float32Array(tattr.normals),
    colors: new Float32Array(tattr.colors),
    uvs: new Float32Array(tattr.uvs),
    indices: tattr.indices
  }

  return attr
}

function parseProperties (properties) {
  if (typeof properties === 'object') { return properties }

  const json = {}
  for (const prop of properties.split(',')) {
    const [key, value] = prop.split('=')
    json[key] = value
  }
  return json
}

function matchProperties (block, properties) {
  if (!properties) { return true }

  properties = parseProperties(properties)
  const blockProps = block.getProperties()
  if (properties.OR) {
    return properties.OR.some((or) => matchProperties(block, or))
  }
  for (const prop in blockProps) {
    if (typeof properties[prop] === 'string' && !properties[prop].split('|').some((value) => value === blockProps[prop] + '')) {
      return false
    }
  }
  return true
}

function getModelVariants (block, blockStates) {
  // air, cave_air, void_air and so on... — must be an exact/suffix match, NOT a
  // substring: `'stairs'.includes('air')` is true, which invisibly dropped all
  // 58 stair block types (no variants -> no geometry).
  if (block.name === 'air' || block.name.endsWith('_air')) return []
  const state = blockStates[block.name] ?? blockStates.missing_texture
  if (!state) return []
  if (state.variants) {
    for (const [properties, variant] of Object.entries(state.variants)) {
      if (!matchProperties(block, properties)) continue
      // Weighted variants (grass/stone/etc.): pick deterministically by block POSITION so a still
      // render is reproducible yet the field shows variety, honouring each variant's `weight`
      // (was always variant[0] → a flat, single-variant look).
      if (variant instanceof Array) return [pickVariant(variant, block.position)]
      return [variant]
    }
  }
  if (state.multipart) {
    const parts = state.multipart.filter(multipart => matchProperties(block, multipart.when))
    let variants = []
    for (const part of parts) {
      if (part.apply instanceof Array) {
        variants = [...variants, ...part.apply]
      } else {
        variants = [...variants, part.apply]
      }
    }

    return variants
  }

  return []
}

// Deterministic weighted variant pick from a block position (stable per render, varied across the
// field). Falls back to the first variant when there's no position.
function pickVariant (arr, pos) {
  if (!arr || arr.length === 0) return undefined
  if (arr.length === 1 || !pos) return arr[0]
  let total = 0
  for (const v of arr) total += (v.weight || 1)
  const hash = (((pos.x | 0) * 73856093) ^ ((pos.y | 0) * 19349663) ^ ((pos.z | 0) * 83492791)) >>> 0
  let r = (hash % 100000) / 100000 * total
  for (const v of arr) { r -= (v.weight || 1); if (r < 0) return v }
  return arr[0]
}

module.exports = { getSectionGeometry }
