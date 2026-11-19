#!/usr/bin/env node
// 本地 mod 的冒烟测试：用真的引擎（coop/host-mods.js）+ 一个假游戏，跑一遍
// coop/ext-trainer-growth.js 和 coop/mods-local.js，检查捕捉加点、重复捕捉不加点、
// 成长线升级、局内运气和扭蛋机稀有度这些规则。
//   node tools/test-mods.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 假环境（浏览器里有的，这里给个够用的）----
const store = new Map()
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
}
const noop = () => {}
const created = []
function fakeEl(tag) {
  const e = {
    tag, children: [], attrs: {}, handlers: {}, style: {}, id: '',
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v },
    getAttribute(k) { return this.attrs[k] },
    appendChild(c) { this.children.push(c); if (c) c.parent = this; return c },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn) },
    removeEventListener() {}, remove() {},
    classList: { add: noop },
    getContext: () => ({ drawImage: noop, fillRect: noop, clearRect: noop }),
    width: 0, height: 0,
  }
  // 真的浏览器里 textContent = '' 会把子节点清掉，面板重画就靠这个
  Object.defineProperty(e, 'textContent', {
    get() { return e._text || '' },
    set(v) { e._text = String(v); if (v === '') e.children.length = 0 },
  })
  created.push(e)
  return e
}
globalThis.document = {
  createElement: fakeEl,
  head: { children: [], appendChild(c) { this.children.push(c); return c } },
  body: { children: [], appendChild(c) { this.children.push(c); return c } },
  getElementById: id => created.find(e => e.id === id) || null,
  addEventListener: noop,
}
globalThis.window = globalThis
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', userAgent: 'node' }, configurable: true }) } catch {}

// ---- 假游戏（游戏那边的接口：图鉴、初始宝可梦的点数、扭蛋机、蛋）----
const dexData = {}
const STARTER_COST = { 2: 1, 3: 4, 4: 8 }
class GameData {
  constructor() { this.dexData = dexData; this.starterData = { 2: {}, 3: {}, 4: {} }; this.eggs = [] }
  getSpeciesStarterValue(id) { return STARTER_COST[id] || 0 }
  async setPokemonCaught(pokemon, incrementCount = true, fromEgg = false) {
    const id = pokemon.species.speciesId
    dexData[id] = dexData[id] || { caughtAttr: 0n }
    if (!incrementCount && !dexData[id].caughtAttr) return false
    dexData[id].caughtAttr = 1n
    return true
  }
}
class Egg {
  constructor(tier = 0, sourceType = 0) { this._tier = tier; this._sourceType = sourceType }
  rollEggTier() { return this._tier }
}
class EggGachaUiHandler {
  constructor() { this.gachaCursor = 0 }
  pullEggs(n) { const eggs = []; for (let i = 0; i < n; i++) eggs.push(new Egg(0, 0)); return eggs }
}
class SelectModifierPhase {
  constructor(rerollCount = 0) {
    this.phaseName = 'SelectModifierPhase'
    this.rerollCount = rerollCount
    this.typeOptions = [{ type: { tier: 0 } }]
    this.customModifierSettings = undefined
  }
  getModifierCount() { return 3 } // 战后奖励默认 3 个
  getRerollCost(lock) { return 250 * 2 ** this.rerollCount } // 游戏的刷新价格
  rerollModifiers() { this.rerolled = (this.rerolled || 0) + 1; return true }
}
// 假宝可梦：游戏那边算能力值的地方是 calculateStats()，重算就是回到基础值
class FakePokemon {
  constructor(player = true, base = 100) {
    this.player = player
    this.base = base
    this.stats = [100, base, base, base, base, base]
  }
  isPlayer() { return this.player }
  isAllowedInBattle() { return this.player }
  getLuck() { return 0 }
  getStat(n) { return this.stats[n] }
  setStat(n, v) { if (v > 0) this.stats[n] = v }
  calculateStats() { this.stats = [100, this.base, this.base, this.base, this.base, this.base] }
  damageAndUpdate() {} // 引擎靠它认出 Pokemon 这个类
}
const party = []
const messages = [] // 游戏里的消息条（api.battle.message）
const gd = new GameData()
const gacha = new EggGachaUiHandler()
const fakeScene = {
  gameData: gd,
  ui: { handlers: [gacha], getHandler: () => null, mode: 0, setMode: noop },
  phaseManager: { currentPhase: new SelectModifierPhase(), startCurrentPhase: noop, shiftPhase: noop, getCurrentPhase: () => null, queueMessage: t => messages.push(t) },
  getPlayerParty: () => party,
  currentBattle: { waveIndex: 5 },
}
globalThis.PRS_SCENE = fakeScene
const mkPokemon = (speciesId, extra = {}) => ({ species: { speciesId, name: '宝可梦' + speciesId, mythical: false, legendary: false, subLegendary: false, baseTotal: 500, ...extra } })
const catchOne = (id, extra) => gd.setPokemonCaught(mkPokemon(id, extra), true, false)

// ---- 加载（顺序和游戏里的一样：引擎 → 扩展 → mod）----
const load = f => { const code = readFileSync(path.join(ROOT, f), 'utf8'); (0, eval)(code) }
load('coop/host-mods.js')
load('coop/ext-trainer-growth.js')
load('coop/mods-local.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- 检查 ----
let failed = 0
const check = (name, ok, extra) => { console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + (ok || !extra ? '' : '  -> ' + extra)); if (!ok) failed++ }
const walk = (node, fn, parent = null) => { if (!node) return; fn(node, parent); for (const c of node.children || []) walk(c, fn, node) }
const meta = () => JSON.parse(localStorage.getItem('prs-mod-meta-trainer-growth') || '{"points":0,"lines":{},"caught":{}}')

check('引擎起来了', typeof window.CoopMods === 'object', typeof window.CoopMods)
check('扩展装上了', window.CoopMods.extensions()['trainer-growth'] === 'ok', JSON.stringify(window.CoopMods.extensions()))
const list = window.CoopMods.list()
check('mod 在列表里', list.some(m => m.id === 'trainer-growth'), JSON.stringify(list))
const tg = list.find(m => m.id === 'trainer-growth')
check('没有加载错误', !tg.error, tg.error)
check('默认是关的', !tg.on)
window.CoopMods.setOn('trainer-growth', true)
check('开关能打开', window.CoopMods.isOn('trainer-growth'))

await sleep(400) // 引擎每 200ms 跑一次：钩子就是那时候装上的
check('单人模式也在跑', window.CoopMods.list().find(m => m.id === 'trainer-growth').running)

// 玩家还没有蛋：扩展先包住扭蛋机，抽第一批蛋时才知道游戏里「蛋」这个类
gacha.pullEggs(1)

// 第一次捕捉
catchOne(1, { mythical: true })
check('第一次捕捉给点（神话 120）', meta().points === 120, 'points=' + meta().points)
check('记下了这只', meta().caught['1'] === 120, JSON.stringify(meta().caught))
catchOne(1, { mythical: true })
check('重复捕捉不再给点', meta().points === 120, 'points=' + meta().points)
catchOne(2, { legendary: true })
check('传说 +80', meta().points === 200, 'points=' + meta().points)
catchOne(3, { subLegendary: true })
check('准神 +40', meta().points === 240, 'points=' + meta().points)
catchOne(4, { starterCost: 8 })
check('初始宝可梦（8 点）+30', meta().points === 270, 'points=' + meta().points)
catchOne(5, { baseTotal: 700 })
check('野外宝可梦 +10', meta().points === 280, 'points=' + meta().points)

// 面板（真的打开一次）
check('面板能打开', window.CoopMods.openPanel() === true)
const panel = document.body.children[document.body.children.length - 1]
const buttons = []
walk(panel, (n, p) => { if (n.tag === 'button') buttons.push({ n, p }) })
check('面板里有按钮', buttons.length >= 3, 'buttons=' + buttons.length)
// 成长线的那一行（.set）：行 → 选项 → 按钮
const lineRow = b => { const n = b.p && b.p.parent; return n && n.attrs && n.attrs.class === 'set' ? n : null }
const rowText = b => { const n = lineRow(b); return n ? n.children.map(c => c.textContent || '').join(' | ') : '' }
const luckBtn = buttons.find(b => rowText(b).indexOf('运气') >= 0)
const gachaBtn = buttons.find(b => rowText(b).indexOf('扭蛋机') >= 0)
check('运气那行有按钮', !!luckBtn, JSON.stringify(buttons.map(b => rowText(b))))
check('扭蛋机那行有按钮', !!gachaBtn, JSON.stringify(buttons.map(b => rowText(b))))
const allText = () => { let out = []; walk(panel, n => { if (n.textContent) out.push(n.textContent) }); return out.join(' | ') }
check('面板上有当前效果的汇总', allText().indexOf('当前效果：') >= 0, allText())
const click = b => { const fn = b && b.n.handlers.click && b.n.handlers.click[0]; if (fn) fn() }

// 升级「局内运气」（150 点）
click(luckBtn)
check('升级扣了 150 点', meta().points === 130, 'points=' + meta().points)
check('运气升到 1 级', meta().lines.luck === 1, JSON.stringify(meta().lines))
check('面板上写了刚升级了什么', allText().indexOf('刚升级：') >= 0, allText())
check('游戏里也弹了一句', messages.some(t => /训练家提升/.test(t)), JSON.stringify(messages))
const luck = window.CoopMods.debug.battle.teamLuck()
check('队伍运气 +1', luck.bonus === 1, JSON.stringify(luck))

// 扭蛋机的蛋
check('没升级时蛋的稀有度不变', new Egg(0, 0).rollEggTier() === 0)

// 攒点，升级扭蛋机
catchOne(6, { mythical: true }); catchOne(7, { mythical: true })
window.CoopMods.openPanel()
const panel2 = document.body.children[document.body.children.length - 1]
const buttons2 = []
walk(panel2, (n, p) => { if (n.tag === 'button') buttons2.push({ n, p }) })
const gachaBtn2 = buttons2.find(b => rowText(b).indexOf('扭蛋机') >= 0)
click(gachaBtn2)
check('扭蛋机升到 1 级', meta().lines.gacha === 1, JSON.stringify(meta().lines))
let up = 0
for (let i = 0; i < 200; i++) if (new Egg(0, 0).rollEggTier() > 0) up++
check('1 级时约 12% 的蛋升一档', up > 5 && up < 50, '升了 ' + up + '/200')
check('不是扭蛋机的蛋不动', new Egg(0, 3).rollEggTier() === 0)

// ---- 常驻能力值 ----
const hero = new FakePokemon(true, 100)    // 自己的宝可梦
const hero2 = new FakePokemon(true, 200)   // 另一只：换宝可梦也该有加成
const foe = new FakePokemon(false, 100)    // 敌人：不受影响
party.push(hero, hero2)
await sleep(400) // 引擎找到 Pokemon 这个类，扩展把钩子装上
check('钩子装上后能力值没变', hero.getStat(1) === 100, 'atk=' + hero.getStat(1))

// 升级「常驻攻击」（120 点）
window.CoopMods.openPanel()
const panel3 = document.body.children[document.body.children.length - 1]
const buttons3 = []
walk(panel3, (n, p) => { if (n.tag === 'button') buttons3.push({ n, p }) })
const atkBtn = buttons3.find(b => rowText(b).indexOf('常驻攻击') >= 0)
check('攻击那行有按钮', !!atkBtn, JSON.stringify(buttons3.map(b => rowText(b))))
click(atkBtn)
check('攻击升到 1 级', meta().lines.statAtk === 1, JSON.stringify(meta().lines))
await sleep(400) // 扩展在下一个心跳里把队伍的能力值重算一遍
check('自己的宝可梦攻击 +10%', hero.getStat(1) === 110, 'atk=' + hero.getStat(1))
{
  let txt = ''
  walk(document.body.children[document.body.children.length - 1], n => { if (n.textContent) txt += n.textContent + ' | ' })
  check('汇总行写着攻击 +10%', txt.indexOf('攻击 +10%') >= 0, txt)
}
check('换一只也有加成', hero2.getStat(1) === 220, 'atk=' + hero2.getStat(1))
check('别的能力没动', hero.getStat(2) === 100 && hero.getStat(3) === 100 && hero.getStat(5) === 100, JSON.stringify(hero.stats))
check('HP 没动', hero.getStat(0) === 100, 'hp=' + hero.getStat(0))
foe.calculateStats()
check('敌人不受影响', foe.getStat(1) === 100, 'atk=' + foe.getStat(1))

// 再升一级：+20%
catchOne(8, { mythical: true })
window.CoopMods.openPanel()
const panel4 = document.body.children[document.body.children.length - 1]
const buttons4 = []
walk(panel4, (n, p) => { if (n.tag === 'button') buttons4.push({ n, p }) })
click(buttons4.find(b => rowText(b).indexOf('常驻攻击') >= 0))
check('攻击升到 2 级', meta().lines.statAtk === 2, JSON.stringify(meta().lines))
await sleep(400)
check('攻击 +20%', hero.getStat(1) === 120, 'atk=' + hero.getStat(1))
// 再攒点，升级到 3 级：+30%，剩下的点不够再升了
catchOne(9, { mythical: true })
const buttons5 = [] // 升级后面板重画了，重新找一次按钮
const findAtk = () => { buttons5.length = 0; walk(document.body.children[document.body.children.length - 1], (n, p) => { if (n.tag === 'button') buttons5.push({ n, p }) }); return buttons5.find(b => rowText(b).indexOf('常驻攻击') >= 0) }
click(findAtk())
check('攻击升到 3 级', meta().lines.statAtk === 3, JSON.stringify(meta().lines))
await sleep(400)
check('攻击 +30%', hero.getStat(1) === 130, 'atk=' + hero.getStat(1))
check('点不够时按钮是灰的', findAtk().n.attrs.disabled === 'disabled', JSON.stringify(findAtk().n.attrs))
check('点不够升不了级', meta().lines.statAtk === 3, JSON.stringify(meta().lines))

// ---- 免费刷新商店 / 战后奖励栏位 ----
// 攒点：4 只神话宝可梦 = 480 点
catchOne(10, { mythical: true }); catchOne(11, { mythical: true })
catchOne(12, { mythical: true }); catchOne(13, { mythical: true })
check('攒到足够的点', meta().points === 530, 'points=' + meta().points)

// 打开面板，升级名字里带这个词的那一行
const upgrade = name => {
  window.CoopMods.openPanel()
  const p = document.body.children[document.body.children.length - 1]
  const bs = []
  walk(p, (n, par) => { if (n.tag === 'button') bs.push({ n, p: par }) })
  const b = bs.find(x => rowText(x).indexOf(name) >= 0)
  if (!b) return false
  click(b)
  return true
}
const ph = fakeScene.phaseManager.currentPhase
const b2 = () => window.CoopMods.debug.b2()

// 还没升级的时候
check('没升级时刷新要钱', ph.getRerollCost(false) === 250, 'cost=' + ph.getRerollCost(false))
check('奖励栏位默认 3 个', ph.getModifierCount() === 3, 'n=' + ph.getModifierCount())

// 免费刷新商店
check('能升级免费刷新商店', upgrade('免费刷新商店'))
check('免费刷新升到 1 级', meta().lines.freeReroll === 1, JSON.stringify(meta().lines))
check('刷新变免费了', ph.getRerollCost(false) === 0, 'cost=' + ph.getRerollCost(false))
check('按钮下面写着免费×1', b2().last.quote.label === '免费×1', JSON.stringify(b2().last.quote))
check('刷新真的发生了', ph.rerollModifiers() === true)
check('用掉一次免费刷新', b2().freeUsed === 1, JSON.stringify(b2().chain))
check('次数用完又要钱了', ph.getRerollCost(false) === 250, 'cost=' + ph.getRerollCost(false))
fakeScene.currentBattle.waveIndex = 6 // 换一场战斗
check('换一场战斗又免费了', ph.getRerollCost(false) === 0, 'cost=' + ph.getRerollCost(false))
check('免费刷新只算这一场', b2().freeUsed === 1, JSON.stringify(b2().chain))

// 战后奖励栏位
check('能升级战后奖励栏位', upgrade('战后奖励栏位'))
check('奖励栏位升到 1 级', meta().lines.rewardSlots === 1, JSON.stringify(meta().lines))
check('奖励栏位变成 4 个', ph.getModifierCount() === 4, 'n=' + ph.getModifierCount())

{
  let txt = ''
  walk(document.body.children[document.body.children.length - 1], n => { if (n.textContent) txt += n.textContent + ' | ' })
  check('汇总行写着免费刷新', txt.indexOf('免费刷新 ×1') >= 0, txt)
  check('汇总行写着奖励栏位', txt.indexOf('奖励栏位 +1') >= 0, txt)
}

console.log(failed ? '\n有 ' + failed + ' 项没过' : '\n全部通过')
process.exit(failed ? 1 : 0)
