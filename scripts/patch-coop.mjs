#!/usr/bin/env node
// Patch the game build in dist/ for co-op mode (run at the end of scripts/fetch-game.sh, or alone:
//   node scripts/patch-coop.mjs [distDir]).
// The patches change nothing while no co-op room is open (window.PRS_COOP_TEAMS is set by coop/host-team.js):
// 1. doubles: every battle is a double battle while a room is open (assets/battle-scene-*.js);
// 2. scene:   the battle scene is exposed as window.PRS_SCENE for the co-op scripts (battle-scene);
// 3. full:    after a catch, "party full, release one?" is asked when window.PRS_COOP_FULL() says so: the
//             catcher has their six, whatever the teammate has (each player may have six, twelve in all).
//             Without a room: at six in the party, as the game does (battle-scene);
// 4. mefull:  the same for a Pokémon obtained in a mystery encounter (assets/loading-scene-*.js).
// Gone since 11-14: "points" (doubled starter points; each player now picks in their own round with the
// game's own limit). A build that still has it, or the earlier form of "full", is brought up to date.
// Everything else for twelve Pokémon is done at run time in coop/host-team.js, not here.
// The same list is in pokerogue-android/scripts/patch-web.mjs and the co-op project's host-mac/patch-game.py.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// [name, file (assets/<file>-*.js), original text, patched text, earlier patched forms that are brought up to date]
const PATCHES = [
  ['doubles', 'battle-scene', 'doCheckDoubleOverride(e){switch(bl.FIELD_SIZE_OVERRIDE){', 'doCheckDoubleOverride(e){switch(window.PRS_COOP_TEAMS?`double`:bl.FIELD_SIZE_OVERRIDE){', []],
  ['scene', 'battle-scene', 'window.gameInfo=t}getActiveKeys(){', 'window.gameInfo=t;window.PRS_SCENE=this}getActiveKeys(){', []],
  // after a catch: "party full, release one?" is asked when the catcher has their six (the hook), not at six in all
  ['full', 'battle-scene', 'if(B.getPlayerParty().length===6){let e={options:[{label:q.t(`partyUiHandler:summary`)', 'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():B.getPlayerParty().length===6)){let e={options:[{label:q.t(`partyUiHandler:summary`)',
    ['if(B.getPlayerParty().length===6||window.PRS_COOP_FULL&&window.PRS_COOP_FULL()){let e={options:[{label:q.t(`partyUiHandler:summary`)']],
  // the same question for a Pokémon obtained in a mystery encounter
  ['mefull', 'loading-scene', 'if(b.getPlayerParty().length===6){let t={options:[{label:k.t(`partyUiHandler:summary`)', 'if((window.PRS_COOP_TEAMS&&window.PRS_COOP_FULL?window.PRS_COOP_FULL():b.getPlayerParty().length===6)){let t={options:[{label:k.t(`partyUiHandler:summary`)', []],
  // taken out again (until 11-14 the starter points limit was doubled; now each player has their own round)
  ['points-off', 'battle-scene', null, 'default:e.value=10}return In(1,e),e.value}', ['default:e.value=10}return In(1,e),e.value*(window.PRS_COOP_TEAMS?2:1)}']],
]
const count = (s, sub) => s.split(sub).length - 1

// Apply PATCHES to the game build in <dir>/assets. Every patch must be found exactly once in exactly one file
// (as the original text, as the patched text, or as one earlier patched form); otherwise nothing is written.
function patchGame(dir, tag) {
  const assets = path.join(dir, 'assets'), all = readdirSync(assets), code = {}, changed = new Set(), done = []
  const fail = msg => { console.error(`${tag}: ${msg}. The game build changed: update the patches in scripts/${tag}.mjs. Nothing written.`); process.exit(1) }
  for (const [name, prefix, from, to, earlier] of PATCHES) {
    const hits = []
    for (const f of all.filter(f => f.startsWith(prefix + '-') && f.endsWith('.js'))) {
      code[f] ??= readFileSync(path.join(assets, f), 'utf8')
      const forms = [from, to, ...earlier].map(t => (t == null ? 0 : count(code[f], t)))
      if (forms.some(Boolean)) hits.push([f, forms])
    }
    if (hits.length !== 1) fail(`patch "${name}" matches ${hits.length} files named ${prefix}-*.js, expected 1`)
    const [f, forms] = hits[0], which = forms.findIndex(Boolean)
    if (forms.reduce((a, b) => a + b, 0) !== 1) fail(`patch "${name}" found ${forms.join('/')} times in ${f} (original/patched/earlier forms), expected exactly one`)
    if (which === 1) { done.push(name + ' (already)'); continue }
    code[f] = code[f].replace([from, to, ...earlier][which], () => to)
    changed.add(f)
    done.push(name + (which > 1 ? ' (updated)' : ''))
  }
  for (const f of changed) writeFileSync(path.join(assets, f), code[f])
  return `${[...changed].join(' + ') || 'nothing to write'}: ${done.join(', ')}`
}

const dist = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'))
console.log('patch-coop: ' + patchGame(dist, 'patch-coop'))
