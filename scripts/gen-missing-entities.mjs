// Add missing 1.17+ mob geometry to the bundled entities.json so they render with
// real models instead of placeholder boxes. Source: Mojang's public bedrock-samples
// (the entities.json IS Bedrock geometry format) + Java entity textures from
// minecraft-assets. Run: node scripts/gen-missing-entities.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const ENTITIES = path.resolve("viewer/lib/entity/entities.json");
const TEX_VERSION = "1.16.4"; // entities.js loads entity textures from public/textures/<this>/
const ASSETS_VERSION = "1.21.8";
const BEDROCK = "https://raw.githubusercontent.com/Mojang/bedrock-samples/main/resource_pack/models/entity";

const entities = JSON.parse(readFileSync(ENTITIES, "utf8"));
const mcData = require("minecraft-data")(ASSETS_VERSION);
const assetsDir = require("minecraft-assets")(ASSETS_VERSION).directory;
const publicDir = path.resolve("public");

const missing = mcData.entitiesArray.map((e) => e.name).filter((n) => !entities[n]);
console.log(`${missing.length} entity types missing a model; fetching bedrock geometry…`);

// Pick the best base texture for a mob from its minecraft-assets entity folder.
function findTexture(name) {
  const sub = path.join(assetsDir, "entity", name);
  const flat = path.join(assetsDir, "entity", `${name}.png`);
  if (existsSync(sub)) {
    const pngs = readdirSync(sub).filter((f) => f.endsWith(".png"));
    const main =
      pngs.find((f) => f === `${name}.png`) ||
      pngs.find((f) => !/_layer|_eyes|_wind|_heart|_spots|_saddle|_armor|_bioluminescent|_pulsating/.test(f)) ||
      pngs[0];
    if (main) return { src: path.join(sub, main), rel: `textures/entity/${name}/${main.replace(/\.png$/, "")}` };
  } else if (existsSync(flat)) {
    return { src: flat, rel: `textures/entity/${name}` };
  }
  return null;
}

let added = 0;
const skipped = [];
for (const name of missing) {
  let geoJson;
  try {
    const res = await fetch(`${BEDROCK}/${name}.geo.json`);
    if (!res.ok) { skipped.push(`${name}(no geo)`); continue; }
    geoJson = await res.json();
  } catch { skipped.push(`${name}(fetch)`); continue; }

  const geo = (geoJson["minecraft:geometry"] || [])[0];
  if (!geo || !geo.bones || !geo.bones.some((b) => b.cubes)) { skipped.push(`${name}(no bones)`); continue; }

  const tex = findTexture(name);
  if (!tex) { skipped.push(`${name}(no texture)`); continue; }

  // copy the Java texture into public/textures/<TEX_VERSION>/entity/…
  const dest = path.join(publicDir, tex.rel.replace("textures", `textures/${TEX_VERSION}`) + ".png");
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(tex.src, dest);

  const d = geo.description;
  entities[name] = {
    identifier: `minecraft:${name}`,
    materials: { default: "entity_alphatest" },
    textures: { default: tex.rel },
    geometry: {
      default: {
        visible_bounds_width: d.visible_bounds_width,
        visible_bounds_height: d.visible_bounds_height,
        visible_bounds_offset: d.visible_bounds_offset,
        texturewidth: d.texture_width,
        textureheight: d.texture_height,
        bones: geo.bones,
      },
    },
    render_controllers: ["controller.render.default"],
  };
  added++;
  console.log(`  + ${name} (${geo.bones.length} bones, ${d.texture_width}x${d.texture_height})`);
}

writeFileSync(ENTITIES, JSON.stringify(entities));
console.log(`\nadded ${added} entities → ${Object.keys(entities).length} total`);
console.log(`skipped ${skipped.length}: ${skipped.slice(0, 20).join(", ")}${skipped.length > 20 ? " …" : ""}`);
