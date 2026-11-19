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
| `api.metaPanel({...})` | 在 Mod 列表里画自己的面板（成长线、升级按钮）。参数：`{ title, summary(), lines: [{id,name,max,cost,desc(lv)}], onChange(id,lv,kind) }`，`summary()` 是面板顶上那行「当前效果」，`kind` 是 `'up'`（升级）或 `'down'`（退款） |
| `api.rng(字符串)` | 种子随机数：同样的字符串总是同样的数 |
| `api.log(...)` | 写进控制台（`COOP mods` 开头） |

## 引擎扩展

有些游戏里的钩子普通 mod 接口里没有，那就在 `coop/ext-*.js` 里加一个扩展，和上游的
`engine/ext-*.js` 是同一套机制（用 `window.CoopModsExt('名字', X => { ... })` 注册）。

现有的：

- `coop/ext-trainer-growth.js`
  - `pokemonCaught` 事件：捕捉到宝可梦（第一次才算），带图鉴和稀有度信息
  - `gachaEggTier` 事件：扭蛋机抽到的蛋，可以让它升一档
  - `pokemonStatBonus` 事件：常驻能力值。事件带 `{ pokemon, bonus }`，往 `bonus` 里写比例
    （`bonus.atk = 0.1` 就是这只宝可梦的攻击 +10%）。游戏算完能力值之后才会加上去，
    所以是永久的：升级、进化、换宝可梦都还在。只有玩家自己的宝可梦算数，敌人不算。
  - `api.meta()` / `api.metaSave()` / `api.metaPanel()` / `api.rng()`
  - 面板上会多两行：顶上「当前效果：」（mod 给的 `summary()`）和「刚升级：xxx → Lv2」
  - 成长线是**收起来**的：面板里只留「成长点：N 点」和「当前效果：」两行，点一下
    「展开成长线」才铺开全部成长线，再点一下收起。展开状态记在局外数据里（`meta.open`），
    下次打开面板还是原来那样。
  - 每条成长线除了「升级」，还有「退款」：退一级，把当初升这一级花的点数原样还回来，
    等级降了效果也跟着降（常驻能力值会在下一次重算时退回原数值）。

扩展文件在 `coop/host-mods.js` 之后加载（`main.mjs` 的 `MOD_FILES`），所以引擎先起来，扩展再装钩子，
mod 最后加载——mod 用到的钩子必须先由扩展 `X.addEvent()` 注册好。

## 已知限制

- 扭蛋机那一档要等游戏里「蛋」这个类出现才开始生效：玩家已经有蛋的时候立刻生效；
  还没有蛋的话，第一次抽蛋之后才生效（那一批蛋还是原来的稀有度）。
- 局外数据存在 localStorage，是**按设备**的：换存档不丢，清浏览器数据会丢。
- 常驻能力值加在宝可梦自己的数值上（存档里存的就是加过之后的数值），所以：
  - 升级、进化、换形态重算能力值时，加成会自动重新加上，不会重复也不会丢；
  - 把 mod 关掉之后，加成还留在存档里，直到那只宝可梦下次重算能力值（升级/进化）才消失；
  - 变身前（变身）用的是变身后的数值，不吃这个加成；
  - 双人合作时两个人的宝可梦在同一支队伍里，两边都吃这个加成（点数是开房间那台电脑的）。
- 免费刷新商店的次数是「每场战斗」算的：按层数记，换一场战斗（层数变了）重新给满；
  次数记在这一局的存档里（`api.runState()`），中途退出游戏再回来还是这一场的次数。
