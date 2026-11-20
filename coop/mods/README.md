# 本地 mod

这个目录放**本仓库自己写的 mod**。上游合作项目里的 mod 是另一份（`coop/mods-bundle.js`，由
`scripts/sync-coop.sh` 同步过来），两边不冲突：游戏页面里两份一起注入。

```
coop/mods/
  trainer-growth/
    mod.json      清单
    mod.js        主体
    icons/        可选：32x32 的 PNG，文件名去掉 .png 就是图标名
```

## 加一个 mod

1. 复制 `trainer-growth/` 改名成你的 mod 的 id（小写字母、数字和 `-`）。
2. 改 `mod.json`：

   | 字段 | 说明 |
   |---|---|
   | `id` | 目录名，小写字母/数字/`-`，3~40 个字符 |
   | `name` | 面板上显示的名字 |
   | `version` | 版本号 |
   | `author` / `credits` / `description` | 作者、致谢、说明 |
   | `default` | `"on"`（默认开）或 `"off"`（默认关） |
   | `api` | 接口版本，这套引擎是 `3` |
   | `modes` | `["solo"]` 只在单人、`["coop"]` 只在双人、两个都写就都行 |

3. 写 `mod.js`：

```js
CoopMods.define('my-mod', function (api) {
  api.on('damageCalc', ev => { /* 返回数字就改伤害，不返回就不改 */ });
});
```

4. 打包：`npm run build:mods` → 生成 `coop/mods-local.js`。
5. 测一下：`npm run test:mods`。

## mod 能用什么

`api` 上的东西（`coop/host-mods.js` 的 `makeApi`）：

| 名字 | 干什么 |
|---|---|
| `api.on(事件, fn)` | 挂钩子。`damageCalc` `beforeDamage` `moveSelect` `status` `statChange` `faint` `turnStart` `turnEnd` `give` `remove` `heal` `moveUsed` `battleStart` `battleEnd` `rewardOdds` `moneyGain` `expGain` `partyHeal` `reviveHp` `bossWave` `bossSegments` `wildBiome` `itemAllowed` `partyMax` `starterMax` `starterPoints` `teamLuck` `rewardCount` `mintRate` `ballThrown` `rerollCost` `rerolled` `fatalHit` `fainted` `healDone` `hpLost` `medicineUsed` `berryTime` `berryEaten` `screenSet` `weatherDamage` `powderMove` `effectSpore` `pokemonCaught` `gachaEggTier` |
| `api.item({...})` | 加一个道具（携带道具 / 被动增益） |
| `api.onPhase(阶段名, fn, 'start'\|'end')` | 挂在游戏的阶段上 |
| `api.battle` | 战斗里的各种东西（血量、位置、消息、伤害、治疗……） |
| `api.runState()` | 这一局里 mod 自己的数据（跟着存档走） |
| `api.fieldState(p, tag)` | 只在场上的记忆（换下去就没了） |
| `api.mode()` | 现在是 `'solo'` 还是 `'coop'` |
| `api.oncePerTurn(tag)` | 一回合里只问一次 |
| `api.meta()` / `api.metaSave()` | **局外数据**（localStorage，关掉游戏还在） |
| `api.metaPanel({...})` | 在 Mod 列表里画自己的面板（成长线、升级/退款按钮）。参数：`{ title, summary(), note(), lines: [{id,name,max,cost,desc(lv)}], onChange(id,lv,kind) }`，`summary()` 是面板顶上那行「当前效果」，`note()` 是再多写一行，`kind` 是 `'up'`（升级）或 `'down'`（退款）。`cost` 可以写成函数 `cost(lv)`，lv 是当前等级，这样能做出「越升越贵」的价格 |
| `api.rng(字符串)` | 种子随机数：同样的字符串总是同样的数 |
| `api.log(...)` | 写进控制台（`COOP mods` 开头） |

## 引擎扩展

有些游戏里的钩子普通 mod 接口里没有，那就在 `coop/ext-*.js` 里加一个扩展，和上游的
`engine/ext-*.js` 是同一套机制（用 `window.CoopModsExt('名字', X => { ... })` 注册）。

现有的：

- `coop/ext-trainer-growth.js`
  - `pokemonCaught` 事件：**获得**一只宝可梦时触发，带图鉴和稀有度信息。
    `kind` 说明是怎么获得的：`'catch'` 野外捕捉、`'egg'` 孵蛋、`'evolution'` 进化出来的新形态。
    判定和游戏自己一致（`GameData.setPokemonCaught`）：租借/借来的宝可梦（根形态没抓过）不算。
  - `gachaEggTier` 事件：扭蛋机抽到的蛋，可以让它升一档
  - `gachaEggBoosted` 事件：蛋真的被升了一档时触发，带 `{ tier, newTier, sourceType, n, egg }`
  - `gachaEggMark` 事件：画蛋的名字（`Egg.getEggDescriptor()`，扭蛋机结果页和背包里的蛋列表都用它）
    之前问一次「这只蛋要不要加标记」，带 `{ id, tier, boosted, egg }`，返回 `true` 就给名字后面加个「+」
  - `gachaPull` 事件：扭蛋机要抽蛋了，带 `{ count }`（这一批几个蛋）
  - `pokemonStatBonus` 事件：常驻能力值。事件带 `{ pokemon, bonus }`，往 `bonus` 里写比例
    （`bonus.atk = 0.1` 就是这只宝可梦的攻击 +10%）。游戏算完能力值之后才会加上去，
    所以是永久的：升级、进化、换宝可梦都还在。只有玩家自己的宝可梦算数，敌人不算。
  - `itemInfo` 事件：道具说明面板里写什么。mod 返回一段文字（`\n` 分行），
    扩展把它交给游戏自己的道具说明面板（右上角那个）。
  - `api.meta()` / `api.metaSave()` / `api.metaPanel()` / `api.rng()`
  - `api.dexTotal()`：图鉴里一共有多少种（游戏自己的数据 `GameData.dexData`，拿不到就 0）
  - 面板上会多两行：顶上「当前效果：」（mod 给的 `summary()`）和「刚升级：xxx → Lv2」
  - 成长线是**收起来**的：面板里只留「成长点：N 点」和「当前效果：」两行，点一下
    「展开成长线」才铺开全部成长线，再点一下收起。展开状态记在局外数据里（`meta.open`），
    下次打开面板还是原来那样。
  - 每条成长线除了「升级」，还有「退款」：退一级，把当初升这一级花的点数原样还回来，
    等级降了效果也跟着降（常驻能力值会在下一次重算时退回原数值）。
  - 升级/退款**不再**往游戏的消息栏里弹东西了：面板上已经写着「刚升级：xxx → Lv2」
    「已退款：xxx → Lv1」。
  - 有一个真的道具：「训练家提升」（`api.item({ id: 'boost', kind: 'passive', icon: 'boost' })`，
    图标是 `coop/mods/trainer-growth/icons/boost.png`，自己画的 32x32 像素画）。
    它画在游戏左上角的道具栏里（跟在游戏自己的道具后面），指上去/点一下，
    游戏自己的道具说明面板就在右上角出现，写着现在每一项成长线加了多少。
    道具一直在队伍背包里，所以它也不会被当成随机奖励发出去。
  - 被「扭蛋机蛋的稀有度」升过档的蛋，名字后面带个「+」（抽蛋结果页和背包里的蛋列表都能看到）。
    升过档的蛋的编号记在这一局的存档里，所以重开游戏以后还标得出来。
    面板上还会写「上次扭蛋机 N 个蛋里 M 个被加成升档」。
  - 价格是 `cost(lv)` 算出来的：训练家提升用的是「基础价 × 1.35^当前等级」，
    所以第 1 级很便宜，后面越来越贵。

训练家提升（0.7.0）一只宝可梦给多少点：

| 稀有度 | 成长点 |
|---|---|
| 神话 | 95 |
| 传说 | 65 |
| 准神 | 33 |
| 初始宝可梦（7~10 点） | 25 |
| 初始宝可梦（5~6 点） | 19 |
| 初始宝可梦（3~4 点） | 13 |
| 初始宝可梦（1~2 点） | 9 |
| 野外（种族值 ≥ 600） | 9 |
| 野外 | 6 |

成长线的价格（基础价 × 1.35^当前等级，取整到 5 的倍数）：

| 成长线 | 上限 | 基础价 | 各级价格 | 满级 |
|---|---|---|---|---|
| 扭蛋机蛋的稀有度 | 5 | 150 | 150/205/275/370/500 | 1500 |
| 局内运气 | 5 | 120 | 120/160/220/295/400 | 1195 |
| 免费刷新商店 | 2 | 150 | 150/205 | 355 |
| 战后奖励栏位 | 5 | 150 | 150/205/275/370/500 | 1500 |
| 常驻攻击/防御/特攻/特防/速度 | 各 5 | 90 | 90/120/165/220/300 | 各 895 |

全部满级一共 9025 点。图鉴里 1084 种宝可梦全算一遍是 14648 点，
野外能抓到的 951 种是 12743 点（平均每种 13.4 点），所以全满大约要抓 674 种（野外图鉴的 71%）。

扩展文件在 `coop/host-mods.js` 之后加载（`main.mjs` 的 `MOD_FILES`），所以引擎先起来，扩展再装钩子，
mod 最后加载——mod 用到的钩子必须先由扩展 `X.addEvent()` 注册好。

## 已知限制

- 扭蛋机那一档要等游戏里「蛋」这个类出现才开始生效：玩家已经有蛋的时候立刻生效；
  还没有蛋的话，第一次抽蛋之后才生效（那一批蛋还是原来的稀有度）。
- 蛋上的「+」标记：升档那一刻就在这只蛋身上，重开游戏（蛋是从存档里读回来的）靠的是
  记下来的编号，所以同一只蛋不会一会儿有一会儿没有。
- 局外数据存在 localStorage，是**按设备**的：换存档不丢，清浏览器数据会丢。
- 「第一次」是**这个 mod 自己记的**（局外数据里的 `caught`），不是看游戏的图鉴：
  - 野外捕捉、孵蛋、进化出来的新形态都给点，同一种只给一次；
  - 装这个 mod 之前就已经抓过的宝可梦，之后再抓一次也会给一次点（之后就再也不给了）；
  - 租借/借来的宝可梦不给点（游戏自己也不会把它记进图鉴）。
- 初始宝可梦的稀有度按它**本来**在游戏里值几个点算（1~10 点），不看玩家用糖果降过的那部分，
  所以越常抓的初始宝可梦不会因为降过价而少给点。
- 常驻能力值加在宝可梦自己的数值上（存档里存的就是加过之后的数值），所以：
  - 升级、进化、换形态重算能力值时，加成会自动重新加上，不会重复也不会丢；
  - 把 mod 关掉之后，加成还留在存档里，直到那只宝可梦下次重算能力值（升级/进化）才消失；
  - 变身前（变身）用的是变身后的数值，不吃这个加成；
  - 双人合作时两个人的宝可梦在同一支队伍里，两边都吃这个加成（点数是开房间那台电脑的）。
- 免费刷新商店的次数是「每场战斗」算的：按层数记，换一场战斗（层数变了）重新给满；
  次数记在这一局的存档里（`api.runState()`），中途退出游戏再回来还是这一场的次数。
