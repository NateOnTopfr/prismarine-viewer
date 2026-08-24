module.exports = {
  // Free an object AND its whole subtree (geometry + material + material.map). The entity/equipment
  // meshes are Object3D trees (holder → inner → model, or an armor group of box meshes), so a
  // shallow dispose would leak every child's geometry + pack textures on each rebuild.
  dispose3 (o) {
    if (!o) return
    const free = (n) => {
      n.geometry?.dispose?.()
      // Dispose materials (created per-build, not shared) but NOT their `.map` — pack/entity textures
      // are cached and shared across entities via loadPackTexture, so freeing them here would blank
      // other meshes and poison the cache. material.dispose() leaves the map intact.
      const mats = Array.isArray(n.material) ? n.material : (n.material ? [n.material] : [])
      for (const m of mats) m?.dispose?.()
      n.dispose?.()
    }
    if (typeof o.traverse === 'function') o.traverse(free)
    else free(o)
  }
}
