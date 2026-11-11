#!/usr/bin/env node
// Patch the game build in dist/ for co-op mode (run at the end of scripts/fetch-game.sh, or alone:
//   node scripts/patch-coop.mjs [distDir]).
// All three patches are in assets/battle-scene-*.js and change nothing while no co-op room is open:
// 1. doubles: every battle is a double battle, only while window.PRS_COOP_TEAMS is set (coop/host-team.js);
// 2. scene:   the battle scene is exposed as window.PRS_SCENE for the co-op scripts;
// 3. points:  the starter points limit doubles while window.PRS_COOP_TEAMS is set (each player gets their own).
// Each patch must match exactly once (or already be applied), otherwise the script fails: the game build
// changed and the patches below need updating.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PATCHES = [
  ['doubles', 'doCheckDoubleOverride(e){switch(bl.FIELD_SIZE_OVERRIDE){', 'doCheckDoubleOverride(e){switch(window.PRS_COOP_TEAMS?`double`:bl.FIELD_SIZE_OVERRIDE){'],
  ['scene', 'window.gameInfo=t}getActiveKeys(){', 'window.gameInfo=t;window.PRS_SCENE=this}getActiveKeys(){'],
  ['points', 'default:e.value=10}return In(1,e),e.value}', 'default:e.value=10}return In(1,e),e.value*(window.PRS_COOP_TEAMS?2:1)}'],
]
const count = (s, sub) => s.split(sub).length - 1

const dist = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'))
const files = readdirSync(path.join(dist, 'assets')).filter(f => /^battle-scene-.*\.js$/.test(f))
if (files.length !== 1) { console.error(`patch-coop: expected one assets/battle-scene-*.js in ${dist}, found ${files.length}`); process.exit(1) }
const file = path.join(dist, 'assets', files[0])
let code = readFileSync(file, 'utf8')
const done = []
for (const [name, from, to] of PATCHES) {
  const nFrom = count(code, from), nTo = count(code, to)
  if (nFrom === 0 && nTo === 1) { done.push(name + ' (already)'); continue }
  if (nFrom !== 1 || nTo !== 0) {
    console.error(`patch-coop: patch "${name}" found ${nFrom} times (patched form ${nTo} times), expected exactly 1 and 0; the game build changed, update scripts/patch-coop.mjs. Nothing written.`)
    process.exit(1)
  }
  code = code.replace(from, () => to)
  done.push(name)
}
if (done.some(d => !d.endsWith('(already)'))) writeFileSync(file, code)
console.log(`patch-coop: ${files[0]}: ${done.join(', ')}`)
