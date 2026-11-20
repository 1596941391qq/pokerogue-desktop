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
  createTextNode: text => ({ nodeType: 3, textContent: String(text), children: [] }),
  head: { children: [], appendChild(c) { this.children.push(c); return c } },
  body: { children: [], appendChild(c) { this.children.push(c); return c } },
  getElementById: id => created.find(e => e.id === id) || null,
  addEventListener: noop,
}
globalThis.window = globalThis
// 假 Image：mod 的图标是打包成 data URI 的 PNG，引擎要拿 Image 解码一下
globalThis.Image = class {
  constructor() { this.width = 32; this.height = 32; this.onload = null; this.onerror = null }
  set src(v) { this._src = v; if (this.onload) this.onload() }
  get src() { return this._src }
}
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', userAgent: 'node' }, configurable: true }) } catch {}

// ---- 假游戏（游戏那边的接口：图鉴、初始宝可梦的点数、扭蛋机、蛋）----
const dexData = {}
// 假的图鉴：先塞 100 条进去（真的游戏里是 1084 种），好让「已捕捉 X / Y 种」有个分母
for (let i = 0; i < 100; i++) dexData['dummy' + i] = { caughtAttr: 0n }
const STARTER_COST = { 2: 1, 3: 4, 4: 8 }
class GameData {
  constructor() { this.dexData = dexData; this.starterData = { 2: {}, 3: {}, 4: {} }; this.eggs = [] }
  getSpeciesStarterValue(id) { return STARTER_COST[id] || 0 }
  // 和游戏一样（src/system/game-data.ts）：incrementCount=false 时只有根形态抓过才算数
  async setPokemonCaught(pokemon, incrementCount = true, fromEgg = false) {
    const id = pokemon.species.speciesId
    const rootId = pokemon.species.getRootSpeciesId()
    dexData[id] = dexData[id] || { caughtAttr: 0n }
    dexData[rootId] = dexData[rootId] || { caughtAttr: 0n }
    if (!incrementCount && !dexData[rootId].caughtAttr) return false
    dexData[id].caughtAttr = 1n
    return true
  }
}
class Egg {
  constructor(tier = 0, sourceType = 0) {
    this._baseTier = tier
    this._sourceType = sourceType
    this._tier = this.rollEggTier() // 游戏里就是这样：蛋一创建就定稀有度（src/data/egg.ts）
    this._id = ++Egg.seq // 编号在稀有度之后才有
  }
  rollEggTier() { return this._baseTier }
  getEggDescriptor() { return ['普通蛋', '高级蛋', '超级蛋', '大师蛋'][this._tier] || '普通蛋' }
}
Egg.seq = 0
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
// 假 Phaser：道具图标要画进游戏的道具栏里，这里给个够用的
globalThis.Phaser = {
  Geom: {
    Rectangle: class {
      constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h }
      static Contains() { return true }
    },
  },
  GameObjects: {
    Text: class {
      constructor(scene, x, y, str, style) {
        this.scene = scene; this.x = x; this.y = y; this.text = String(str); this.style = style
        // 中文一个字大概 6 个单位，英文字母 3 个（扩展里把字号缩了 1/6）
        this.displayWidth = [...this.text].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 6 : 3), 0)
        this.displayHeight = 6
      }
      setScale() { return this }
      setShadow() { return this }
      setPosition(x, y) { this.x = x; this.y = y; return this }
    },
    Graphics: class {
      constructor(scene) { this.scene = scene; this.ops = [] }
      fillStyle() { return this }
      fillRoundedRect(...a) { this.ops.push(['fill', ...a]); return this }
      lineStyle() { return this }
      strokeRoundedRect(...a) { this.ops.push(['stroke', ...a]); return this }
    },
    Sprite: class {
      constructor(scene, x, y, texture, frame) {
        this.scene = scene; this.x = x; this.y = y; this.texture = texture; this.frame = { name: frame }
        this.scale = 1; this.origin = 0
      }
      setOrigin(v) { this.origin = v; return this }
      setFrame(f) { this.frame = { name: f }; return this }
      setScale(v) { this.scale = v; return this }
      setVisible(v) { this.visible = v; return this }
    },
    Container: class {
      constructor(scene, x, y) {
        this.scene = scene; this.x = x; this.y = y; this.list = []; this.scale = 1; this.depth = 0; this.name = ''
        this.handlers = {}; this.visible = true
      }
      add(c) { this.list.push(c); return c }
      removeAll() { this.list = []; return this }
      setScale(v) { this.scale = v; return this }
      setDepth(v) { this.depth = v; return this }
      setName(v) { this.name = v; return this }
      setVisible(v) { this.visible = v; return this }
      setPosition(x, y) { this.x = x; this.y = y; return this }
      setInteractive() { this.interactive = true; return this }
      on(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); return this }
      destroy() { this.scene = null; this.destroyed = true }
    },
  },
}
const party = []
const messages = [] // 游戏里的消息条（api.battle.message）
const gd = new GameData()
const gacha = new EggGachaUiHandler()
const tooltips = [] // 游戏的道具说明面板（右上角那个）
const modBar = new Phaser.GameObjects.Container(null, 0, 0) // 游戏左上角那排道具图标
const fakeScene = {
  gameData: gd,
  ui: {
    handlers: [gacha], getHandler: () => null, mode: 0, setMode: noop,
    showTooltip: (title, content) => tooltips.push({ title, content }),
    hideTooltip: () => { tooltips.length = 0 },
    update: () => {},
  },
  phaseManager: { currentPhase: new SelectModifierPhase(), startCurrentPhase: noop, shiftPhase: noop, getCurrentPhase: () => null, queueMessage: t => messages.push(t) },
  getPlayerParty: () => party,
  currentBattle: { waveIndex: 5 },
  getModifierBar: () => modBar, // 游戏自己的道具栏（modifier-bar）
}
// 游戏画面上的东西
fakeScene.children = [];
fakeScene.children.getIndex = o => fakeScene.children.indexOf(o);
fakeScene.add = {
  container: (x, y) => {
    const c = new Phaser.GameObjects.Container(fakeScene, x, y)
    fakeScene.children.push(c)
    return c
  },
}
globalThis.PRS_SCENE = fakeScene
const mkPokemon = (speciesId, extra = {}) => {
  const species = { speciesId, name: '宝可梦' + speciesId, mythical: false, legendary: false, subLegendary: false, baseTotal: 500, ...extra }
  // extra.rootId 可以指定「根形态」（进化前的那个），默认是自己
  species.getRootSpeciesId = () => (extra.rootId != null ? extra.rootId : speciesId)
  return { species }
}
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
check('第一次捕捉给点（神话 95）', meta().points === 95, 'points=' + meta().points)
check('记下了这只', meta().caught['1'] === 95, JSON.stringify(meta().caught))
catchOne(1, { mythical: true })
check('重复捕捉不再给点', meta().points === 95, 'points=' + meta().points)
catchOne(2, { legendary: true })
check('传说 +65', meta().points === 160, 'points=' + meta().points)
catchOne(3, { subLegendary: true })
check('准神 +33', meta().points === 193, 'points=' + meta().points)
catchOne(4, { starterCost: 8 })
check('初始宝可梦（8 点）+25', meta().points === 218, 'points=' + meta().points)
catchOne(5, { baseTotal: 700 })
check('野外宝可梦 +9', meta().points === 227, 'points=' + meta().points)

// 面板（真的打开一次）
check('面板能打开', window.CoopMods.openPanel() === true)
const panel = document.body.children[document.body.children.length - 1]
// 面板每次重画都还是那一个卡片，按钮要从最新的树上找
const panelNow = () => document.body.children[document.body.children.length - 1]
const buttonsNow = () => { const out = []; walk(panelNow(), (n, p) => { if (n.tag === 'button') out.push({ n, p }) }); return out }
const toggleBtn = () => buttonsNow().find(b => /展开成长线|收起成长线/.test(b.n.textContent || ''))
const upgradeBtns = () => buttonsNow().filter(b => /升级（|已满级/.test(b.n.textContent || ''))
const click = b => { const fn = b && b.n.handlers.click && b.n.handlers.click[0]; if (fn) fn() }

// ---- 折叠：默认只留顶上几行，点一下才铺开全部成长线 ----
check('默认收起了成长线', upgradeBtns().length === 0, 'buttons=' + JSON.stringify(buttonsNow().map(b => b.n.textContent)))
check('有展开按钮', !!toggleBtn(), JSON.stringify(buttonsNow().map(b => b.n.textContent)))
check('收起时还是看得到当前效果', (() => { let t = ''; walk(panelNow(), n => { if (n.textContent) t += n.textContent + ' | ' }); return t.indexOf('当前效果：') >= 0 })(), '')
click(toggleBtn())
check('展开后成长线都在', upgradeBtns().length === 9, 'n=' + upgradeBtns().length)
check('展开状态记下来了', meta().open === true, JSON.stringify(meta()))
check('按钮变成收起', /收起成长线/.test(toggleBtn().n.textContent || ''), toggleBtn().n.textContent)
click(toggleBtn())
check('收起后成长线又没了', upgradeBtns().length === 0, 'n=' + upgradeBtns().length)
check('收起状态也记下来了', meta().open === false, JSON.stringify(meta()))
click(toggleBtn())
check('再展开还是 9 条', upgradeBtns().length === 9, 'n=' + upgradeBtns().length)

const buttons = buttonsNow()
check('面板里有按钮', buttons.length >= 10, 'buttons=' + buttons.length)
// 成长线的那一行（.set）：行 → 选项 → 按钮
const lineRow = b => { const n = b.p && b.p.parent; return n && n.attrs && n.attrs.class === 'set' ? n : null }
const rowText = b => { const n = lineRow(b); return n ? n.children.map(c => c.textContent || '').join(' | ') : '' }
const luckBtn = buttons.find(b => rowText(b).indexOf('运气') >= 0)
const gachaBtn = buttons.find(b => rowText(b).indexOf('扭蛋机') >= 0)
check('运气那行有按钮', !!luckBtn, JSON.stringify(buttons.map(b => rowText(b))))
check('扭蛋机那行有按钮', !!gachaBtn, JSON.stringify(buttons.map(b => rowText(b))))
const allText = () => { let out = []; walk(panel, n => { if (n.textContent) out.push(n.textContent) }); return out.join(' | ') }
check('面板上有当前效果的汇总', allText().indexOf('当前效果：') >= 0, allText())
check('面板上有捕捉进度', allText().indexOf('已捕捉 5 / 105 种') >= 0, allText())
check('面板上有累计点数', allText().indexOf('累计 227 点') >= 0, allText())

// 价格：每条线第 1 级的价钱（越高级越贵，后面再查涨没涨）
{
  const bs = []
  walk(document.body.children[document.body.children.length - 1], (n, par) => { if (n.tag === 'button') bs.push({ n, p: par }) })
  const priceOf = name => {
    const b = bs.find(x => rowText(x).indexOf(name) >= 0 && /升级（/.test(x.n.textContent || ''))
    const m = b && (b.n.textContent.match(/升级（(\d+) 点/) || [])
    return m ? Number(m[1]) : -1
  }
  check('局内运气第 1 级 120 点', priceOf('局内运气') === 120, String(priceOf('局内运气')))
  check('扭蛋机第 1 级 150 点', priceOf('扭蛋机') === 150, String(priceOf('扭蛋机')))
  check('免费刷新第 1 级 150 点', priceOf('免费刷新') === 150, String(priceOf('免费刷新')))
  check('战后奖励栏位第 1 级 150 点', priceOf('战后奖励栏位') === 150, String(priceOf('战后奖励栏位')))
  check('常驻能力第 1 级 90 点', priceOf('常驻攻击') === 90, String(priceOf('常驻攻击')))
}

// 升级「局内运气」（120 点）
click(luckBtn)
check('升级扣了 120 点', meta().points === 107, 'points=' + meta().points)
check('运气升到 1 级', meta().lines.luck === 1, JSON.stringify(meta().lines))
check('面板上写了刚升级了什么', allText().indexOf('刚升级：') >= 0, allText())
check('面板操作不再往游戏的消息栏里弹东西', !messages.some(t => /训练家提升/.test(t)), JSON.stringify(messages))
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

// ---- 被加成升过档的蛋：名字后面带个「+」 ----
let boostedEgg = null
for (let i = 0; i < 40 && !boostedEgg; i++) {
  for (const e of gacha.pullEggs(5)) {
    if (/\+/.test(e.getEggDescriptor())) { boostedEgg = e; break }
  }
}
check('被加成升档的蛋，名字后面有标记', !!boostedEgg, '200 个蛋里一个都没升（不该发生）')
check('没升档的蛋没有标记', !/\+/.test(new Egg(0, 3).getEggDescriptor()), new Egg(0, 3).getEggDescriptor())
// 重开游戏以后蛋是从存档里读回来的（没有「这一局升过档」的记号），
// 但 mod 记住了它的编号，还是标得出来
const reloaded = new Egg(0, 3)
reloaded._id = boostedEgg && boostedEgg._id
check('重开游戏后同一只蛋还是带标记', /\+/.test(reloaded.getEggDescriptor()), reloaded.getEggDescriptor())
// 面板上写着扭蛋机的账
window.CoopMods.openPanel()
{
  let t = ''
  walk(document.body.children[document.body.children.length - 1], n => { if (n.textContent) t += n.textContent + ' | ' })
  check('面板上写着上次扭蛋机的账', /上次扭蛋机 \d+ 个蛋里 \d+ 个被加成升档/.test(t), t)
  check('面板上写着这一局一共抽了多少', t.indexOf('这一局共抽了') >= 0, t)
}

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
check('升过一级后价格涨到 165 点', (() => {
  const bs = []
  walk(document.body.children[document.body.children.length - 1], (n, par) => { if (n.tag === 'button') bs.push({ n, p: par }) })
  const b = bs.find(x => rowText(x).indexOf('常驻攻击') >= 0 && /升级（/.test(x.n.textContent || ''))
  return !!b && b.n.textContent.indexOf('升级（165 点）') >= 0
})(), '')
await sleep(400)
check('攻击 +20%', hero.getStat(1) === 120, 'atk=' + hero.getStat(1))
// 再攒点，升级到 3 级：+30%，剩下的点不够再升了
// （价格越升越贵：第 2 级要 120 点、第 3 级要 165 点，所以得多抓一只才够）
catchOne(9, { mythical: true })
catchOne(14, { mythical: true })
const buttons5 = [] // 升级后面板重画了，重新找一次按钮
const findAtk = () => { buttons5.length = 0; walk(document.body.children[document.body.children.length - 1], (n, p) => { if (n.tag === 'button') buttons5.push({ n, p }) }); return buttons5.find(b => rowText(b).indexOf('常驻攻击') >= 0) }
click(findAtk())
check('攻击升到 3 级', meta().lines.statAtk === 3, JSON.stringify(meta().lines))
await sleep(400)
check('攻击 +30%', hero.getStat(1) === 130, 'atk=' + hero.getStat(1))
check('点不够时按钮是灰的', findAtk().n.attrs.disabled === 'disabled', JSON.stringify(findAtk().n.attrs))
check('点不够升不了级', meta().lines.statAtk === 3, JSON.stringify(meta().lines))

// ---- 免费刷新商店 / 战后奖励栏位 ----
// 攒点：4 只神话宝可梦 = 380 点
catchOne(10, { mythical: true }); catchOne(11, { mythical: true })
catchOne(12, { mythical: true }); catchOne(13, { mythical: true })
check('攒到足够的点', meta().points === 437, 'points=' + meta().points)

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

// ---- 退款：退一级，点数原样还回来，效果也跟着退 ----
const rowBtn = (row, kind) => {
  const bs = []
  walk(document.body.children[document.body.children.length - 1], (n, par) => { if (n.tag === 'button') bs.push({ n, p: par }) })
  return bs.find(x => rowText(x).indexOf(row) >= 0 && (kind === 'refund' ? /退款（/.test(x.n.textContent || '') : /升级（|已满级/.test(x.n.textContent || '')))
}

// 退常驻攻击的一级：3 级（+30%）→ 2 级（+20%）
const atkBack = rowBtn('常驻攻击', 'refund')
check('攻击那行有退款按钮', !!atkBack, JSON.stringify(rowBtn('常驻攻击', 'upgrade') && rowBtn('常驻攻击', 'upgrade').n.textContent))
const ptsBefore = meta().points
click(atkBack)
check('退款把 165 点还回来了（当初买 3 级花了 165）', meta().points === ptsBefore + 165, 'points=' + meta().points)
check('退款后攻击回到 2 级', meta().lines.statAtk === 2, JSON.stringify(meta().lines))
await sleep(400)
check('能力值加成跟着退了（+20%）', hero.getStat(1) === 120, 'atk=' + hero.getStat(1))
check('换的那只也跟着退', hero2.getStat(1) === 240, 'atk=' + hero2.getStat(1))
check('面板上写了退款', (() => { let t = ''; walk(document.body.children[document.body.children.length - 1], n => { if (n.textContent) t += n.textContent + ' | ' }); return t.indexOf('已退款：') >= 0 })(), '')

// 退局内运气的一级：1 级 → 0 级
const luckBack = rowBtn('局内运气', 'refund')
check('运气那行有退款按钮', !!luckBack, '')
const ptsBefore2 = meta().points
click(luckBack)
check('运气退款把 120 点还回来了', meta().points === ptsBefore2 + 120, 'points=' + meta().points)
check('运气回到 0 级', meta().lines.luck === 0, JSON.stringify(meta().lines))
check('运气加成也没了', window.CoopMods.debug.battle.teamLuck().bonus === 0, JSON.stringify(window.CoopMods.debug.battle.teamLuck()))

// 0 级的成长线没有退款按钮
check('0 级那行没有退款按钮', !rowBtn('局内运气', 'refund'), '')
// 退完还能再升回去
click(rowBtn('局内运气', 'upgrade'))
check('还能再升一级', meta().lines.luck === 1, JSON.stringify(meta().lines))
check('点数又扣了 120', meta().points === ptsBefore2, 'points=' + meta().points)

// ---- 孵蛋 / 进化：也算「获得」，但同一种只算一次 ----
// （放在最后：这一段只和「现在的点数」比，不会影响前面那些绝对值断言）
const pts = () => meta().points

// 孵蛋：这一种野外还没抓过
const beforeEgg = pts()
await gd.setPokemonCaught(mkPokemon(20, { mythical: true }), true, true)
check('孵蛋也给点', pts() === beforeEgg + 95, 'points=' + pts())
check('孵蛋的也记下了', meta().caught['20'] === 95, JSON.stringify(meta().caught))
// 孵蛋之后再在野外抓到同一只
await gd.setPokemonCaught(mkPokemon(20, { mythical: true }), true, false)
check('孵蛋之后再野外抓到同一只不再给点', pts() === beforeEgg + 95, 'points=' + pts())
// 同一只孵蛋两次
await gd.setPokemonCaught(mkPokemon(20, { mythical: true }), true, true)
check('同一只孵蛋两次只给一次点', pts() === beforeEgg + 95, 'points=' + pts())

// 进化：根形态抓过了，进化出来的新形态给点
await gd.setPokemonCaught(mkPokemon(21, { mythical: true }), true, false)
const afterRoot = pts()
await gd.setPokemonCaught(mkPokemon(22, { mythical: true, rootId: 21 }), false, false)
check('进化出来的新形态也给点', pts() === afterRoot + 95, 'points=' + pts())

// 租借：incrementCount=false，根形态还没抓过 → 游戏那边图鉴都不动，也不该给点
const beforeRent = pts()
await gd.setPokemonCaught(mkPokemon(23, { mythical: true }), false, false)
check('租借来的宝可梦不给点', pts() === beforeRent, 'points=' + pts())

// 图鉴里早就抓过（装这个 mod 之前抓的）也会给一次点，之后就不再给了
dexData['30'] = { caughtAttr: 1n }
const beforeOld = pts()
await gd.setPokemonCaught(mkPokemon(30, { mythical: true }), true, false)
check('图鉴里早就有的，第一次也会给点', pts() === beforeOld + 95, 'points=' + pts())
await gd.setPokemonCaught(mkPokemon(30, { mythical: true }), true, false)
check('之后就再也不给了', pts() === beforeOld + 95, 'points=' + pts())

// ---- 道具「训练家提升」 ----
{
  await sleep(300) // 扩展每个心跳画一次
  const items = window.CoopMods.list().find(m => m.id === 'trainer-growth').items
  check('mod 里有这个道具', items.indexOf('trainer-growth:boost') >= 0, JSON.stringify(items))
  const bag = window.CoopMods.debug.bag()
  check('道具在队伍背包里', bag['trainer-growth:boost'] && bag['trainer-growth:boost'].n === 1, JSON.stringify(bag))
  // 图标：画在游戏左上角的道具栏里（跟在游戏自己的道具后面）
  check('图标画在道具栏里', modBar.list.length === 1, 'n=' + modBar.list.length)
  const icon = modBar.list[0]
  check('图标是可点的', !!icon && icon.interactive === true, JSON.stringify(icon && icon.interactive))
  check('图标用的是道具贴图', !!icon && icon.list[0] && icon.list[0].texture === 'items', icon && icon.list[0] ? icon.list[0].texture : 'no sprite')
  check('图标在左上角', !!icon && icon.x >= 0 && icon.x < 320 && icon.y >= 0 && icon.y < 40, icon ? (icon.x + ',' + icon.y) : 'no icon')
  // 说明面板：点一下图标，右上角出现说明，写着现在各项加了多少
  const text = window.CoopMods.debug.tgItemInfo()
  check('说明里有内容', typeof text === 'string' && text.length > 0, JSON.stringify(text))
  check('说明写着扭蛋机的加成', text.indexOf('蛋的稀有度 Lv1：升档 +12%') >= 0, JSON.stringify(text))
  check('说明写着局内运气', text.indexOf('运气 Lv1：+1') >= 0, JSON.stringify(text))
  check('说明写着免费刷新', text.indexOf('免费刷新 Lv1：每场 ×1') >= 0, JSON.stringify(text))
  check('说明写着奖励栏位', text.indexOf('奖励栏位 Lv1：+1 个') >= 0, JSON.stringify(text))
  check('说明写着常驻攻击', text.indexOf('常驻攻击 Lv2') >= 0, JSON.stringify(text))
  check('说明写着成长点', text.indexOf('成长点') >= 0, JSON.stringify(text))
  check('说明里没有 0 级的成长线', text.indexOf('Lv0') < 0, JSON.stringify(text))
  // 点一下图标 → 游戏的道具说明面板
  icon.handlers.pointerover[0]()
  check('点一下就打开说明面板', tooltips.length === 1, JSON.stringify(tooltips))
  check('说明面板的标题是道具名', tooltips[0] && tooltips[0].title === '训练家提升', JSON.stringify(tooltips[0]))
  check('说明面板里就是那些加成', tooltips[0] && tooltips[0].content === text, JSON.stringify(tooltips[0]))
  // 移开 → 关掉
  icon.handlers.pointerout[0]()
  check('移开就关掉说明面板', tooltips.length === 0, JSON.stringify(tooltips))
}

// ---- 图鉴越满，抓到的新宝可梦越值钱 ----
{
  const dexState = () => {
    const keys = Object.keys(dexData)
    const caught = keys.filter(k => dexData[k] && dexData[k].caughtAttr).length
    return { caught, total: keys.length, p: keys.length ? caught / keys.length : 0 }
  }
  const multAt = p => { let m = 1; for (const [t, v] of [[0.2, 1.2], [0.4, 1.4], [0.6, 1.6], [0.8, 2.0]]) if (p >= t) m = v; return m }
  // 图鉴还很空：没有倍率
  const st1 = dexState()
  check('图鉴还不到 20% 时倍率是 ×1', multAt(st1.p) === 1, JSON.stringify(st1))
  const b1 = meta().points
  catchOne(41, { mythical: true })
  check('空图鉴时按原点数给（95 点）', meta().points - b1 === 95, 'got=' + (meta().points - b1))
  // 把图鉴填到一半左右（40%~60% 那一档）
  let guard = 0
  while (dexState().p < 0.5 && guard++ < 200) { const k = 'dummy' + guard; if (dexData[k]) dexData[k].caughtAttr = 1n }
  const st2 = dexState()
  const m2 = multAt(st2.p)
  check('图鉴过了 40% 以后倍率是 ×1.4', m2 === 1.4, JSON.stringify(st2))
  const b2 = meta().points
  const logs = []
  const realLog = console.log
  console.log = (...a) => { logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); realLog(...a) }
  catchOne(42, { mythical: true })
  console.log = realLog
  check('这一只按倍率给点（95 × 1.4）', meta().points - b2 === Math.round(95 * 1.4), 'got=' + (meta().points - b2))
  check('消息里写着这次的倍率', logs.some(t => /×1\.4/.test(t)), JSON.stringify(logs))
  // 面板和说明面板上都要写现在的倍率
  window.CoopMods.openPanel()
  const noteText = (() => { let t = ''; walk(document.body, n => { if (n.textContent) t += n.textContent + ' | ' }); return t })()
  check('面板上写着现在的倍率', /现在的倍率 ×1\.4/.test(noteText), noteText.slice(0, 200))
  const tipText = window.CoopMods.debug.tgItemInfo()
  check('说明面板上写着倍率', /倍率 ×1\.4/.test(tipText), JSON.stringify(tipText))
  check('说明面板上写着图鉴百分比', /图鉴 \d+%/.test(tipText), JSON.stringify(tipText))
}

// ---- 局内运气：上限 10 级 ----
{
  // 攒够点（神话宝可梦一只 95 点）
  let guard = 0
  while (meta().points < 7000 && guard++ < 300) catchOne(1000 + guard, { mythical: true })
  window.CoopMods.openPanel()
  if (!upgradeBtns().length) click(toggleBtn()) // 成长线是收着的就展开
  const luckBtnIn = re => {
    const bs = []
    walk(document.body.children[document.body.children.length - 1], (n, par) => { if (n.tag === 'button') bs.push({ n, p: par }) })
    return bs.find(x => rowText(x).indexOf('局内运气') >= 0 && re.test(x.n.textContent || ''))
  }
  const luckUpgrade = () => luckBtnIn(/升级（|已满级/)
  // 前面的测试把运气升到过 1 级：先退款退回 0 级，从头升一遍
  for (let i = 0; i < 12; i++) {
    const back = luckBtnIn(/退款（/)
    if (!back) break
    click(back)
  }
  check('运气先退回 0 级', meta().lines.luck === 0, JSON.stringify(meta().lines))
  const pointsBefore = meta().points
  const prices = []
  for (let i = 0; i < 10; i++) {
    const b = luckUpgrade()
    if (!b) break
    prices.push((b.n.textContent.match(/升级（(\d+) 点/) || [])[1] || '满')
    click(b)
  }
  check('运气能升到 10 级', meta().lines.luck === 10, JSON.stringify(meta().lines))
  check('运气满级以后按钮写着已满级', /已满级/.test((luckUpgrade() || { n: {} }).n.textContent || ''), JSON.stringify((luckUpgrade() || { n: {} }).n.textContent))
  check('运气 10 级是 +10 点运气', window.CoopMods.debug.battle.teamLuck().bonus === 10, JSON.stringify(window.CoopMods.debug.battle.teamLuck()))
  check('运气各级价格 120/160/220/295/400/540/725/980/1325/1785', prices.join('/') === '120/160/220/295/400/540/725/980/1325/1785', prices.join('/'))
  check('运气升满一共花了 6550 点', pointsBefore - meta().points === 6550, 'spent=' + (pointsBefore - meta().points))
  check('面板上运气那行写着 Lv10/10', rowText(luckUpgrade()).indexOf('Lv10/10') >= 0, rowText(luckUpgrade()))
}

console.log(failed ? '\n有 ' + failed + ' 项没过' : '\n全部通过')
process.exit(failed ? 1 : 0)
