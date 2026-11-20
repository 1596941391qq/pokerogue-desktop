// 引擎扩展（本地）：「训练家提升」要用的几个钩子，普通 mod 接口里没有，另外还提供一个局外数据仓库。
//
//   1. 捕捉到宝可梦：游戏里所有「这只宝可梦被收下了」都走 GameData.setPokemonCaught()
//      （src/system/game-data.ts）。第一次记下图鉴的那一次就是「第一次捕捉」。
//   2. 扭蛋机的蛋：Egg.prototype.rollEggTier()（src/data/egg.ts）是抽蛋时定稀有度的地方。
//      游戏的稀有度概率（src/data/balance/rates.ts）：普通 204/256、高级 44/256、超级 7/256、大师 1/256。
//      蛋的名字是 Egg.prototype.getEggDescriptor()（扭蛋机结果页、背包里的蛋列表都用它）：
//      被加成升过档的蛋，名字后面加个「+」，这样一眼能看出是哪几只。
//   3. 常驻能力值：游戏算一只宝可梦的能力值只有一处 Pokemon.calculateStats()
//      （src/field/pokemon.ts）：升级、进化、换算都会重算。加成加在重算之后，所以是「永久」的：
//      宝可梦自己的数值变大，换宝可梦也照样有（每只自己的都吃到）。
//   4. 局外数据：每个 mod 一份，存 localStorage（关掉游戏、换存档都还在）。
//   5. 成长线面板：mod 用 api.metaPanel() 描述它的成长线，这里负责画出来、扣点、升级。
//
// 这个文件在 coop/host-mods.js 之后加载（main.mjs 的 modsJs()），用 window.CoopModsExt 注册，
// 和上游的 engine/ext-*.js 是同一套机制（见 host-mods.js 里的 CoopModsExt）。
(function () {
  if (!window.CoopModsExt) return; // 引擎还没起来（顺序不对）
  window.CoopModsExt('trainer-growth', function (X) {
    const log = (...a) => X.log('ext', ...a);
    const TIER_ZH = ['普通', '高级', '超级', '大师']; // EggTier: COMMON / RARE / EPIC / LEGENDARY
    const GACHA_SOURCE = [0, 1, 2]; // EggSourceType: GACHA_MOVE / GACHA_LEGENDARY / GACHA_SHINY
    const EGG_MARK = '+'; // 蛋名后面的标记：这只蛋是被加成升过档的（游戏那个像素字体里有这个字）

    // ---- 事件 ----
    X.addEvent('pokemonCaught'); // 获得一只宝可梦：{ speciesId, name, kind, first, rarity }
                                // kind: 'catch' 野外捕捉 / 'egg' 孵蛋 / 'evolution' 进化
    X.addEvent('gachaEggTier');  // 扭蛋机抽到的蛋：{ tier, sourceType, n }，返回更高的 tier（0..3）就是升级
    X.addEvent('gachaEggBoosted'); // 蛋真的被升了一档：{ tier, newTier, sourceType, n, egg }
    X.addEvent('gachaEggMark');    // 这只蛋要不要加标记：{ id, tier, boosted, egg }，返回 true 就加
    X.addEvent('gachaPull');       // 扭蛋机要抽蛋了：{ count }（这一批几个蛋）
    X.addEvent('pokemonStatBonus'); // 常驻能力值加成：{ pokemon, bonus }，往 bonus 里写比例（0.1 = +10%）

    // ---- 局外数据：每个 mod 一份 ----
    const metas = {};
    const metaKey = id => 'prs-mod-meta-' + id;
    function metaOf(id) {
      if (metas[id]) return metas[id];
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(metaKey(id)) || 'null'); } catch {}
      const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      if (typeof m.points !== 'number' || !isFinite(m.points)) m.points = 0;
      if (!m.lines || typeof m.lines !== 'object') m.lines = {};
      if (!m.caught || typeof m.caught !== 'object') m.caught = {};
      m.v = 1;
      return (metas[id] = m);
    }
    function saveMeta(id) {
      try { localStorage.setItem(metaKey(id), JSON.stringify(metaOf(id))); } catch {}
    }

    // ---- 成长线面板 ----
    const panels = {};
    function costOf(line, lv) { return Math.max(0, Math.floor(typeof line.cost === 'function' ? line.cost(lv) : line.cost)); }
    X.onPanel((id, render) => {
      const def = panels[id];
      if (!def) return null;
      const m = metaOf(id);
      const on = X.isOn(id);
      const lines = def.lines || [];
      // 成长线有十来条，全展开面板很长：默认只留顶上这几行，点一下「展开」才铺开。
      // 展开状态记在局外数据里（m.open），下次打开面板还是原来那样。
      const expanded = !!m.open;
      const rows = [];
      // 顶上一行：成长点 + 展开/收起
      rows.push(X.el('div', { class: 'set' }, [
        X.el('div', { text: (def.title || '成长点') + '：' + Math.floor(m.points) + ' 点' }),
        X.el('div', { class: 'opts' }, [X.el('button', {
          text: expanded ? '收起成长线 ▲' : '展开成长线 ▼（' + lines.length + ' 条）',
          onclick: () => {
            m.open = !expanded;
            saveMeta(id);
            render();
          },
        })]),
      ]));
      if (!on) rows.push(X.el('div', { class: 'meta', text: '（打开这个 mod 才能用）' }));
      // 现在这些成长线加在一起是什么效果（mod 自己给一行汇总）
      if (def.summary) {
        const s = String(X.guard('metaPanel summary', () => def.summary(), '') || '');
        if (s) rows.push(X.el('div', { class: 'meta', text: '当前效果：' + s }));
      }
      // 刚点了升级：告诉玩家升到了几级（面板会重画，这一行留在最上面）
      if (def.lastMsg) rows.push(X.el('div', { class: 'meta', text: def.lastMsg }));
      // mod 自己想多写一行（比如「已捕捉多少种」）：note() 返回空字符串就不画
      if (def.note) {
        const nt = String(X.guard('metaPanel note', () => def.note(), '') || '');
        if (nt) rows.push(X.el('div', { class: 'meta', text: nt }));
      }
      // 收起来的时候下面什么都不画
      for (const line of expanded ? lines : []) {
        const lv = Math.max(0, Math.min(line.max || 99, Math.floor(Number(m.lines[line.id]) || 0)));
        const cost = costOf(line, lv);
        const full = lv >= (line.max || 99);
        const can = !full && m.points >= cost;
        const btn = X.el('button', {
          class: can ? '' : 'off',
          text: full ? '已满级' : '升级（' + cost + ' 点）',
          onclick: () => {
            if (full || m.points < cost) return;
            m.points -= cost;
            m.lines[line.id] = lv + 1;
            saveMeta(id);
            def.lastMsg = '刚升级：' + line.name + ' → Lv' + (lv + 1) + '/' + (line.max || 99);
            log('成长线 ' + line.id + ' → Lv' + (lv + 1));
            if (def.onChange) X.guard('metaPanel onChange', () => def.onChange(line.id, lv + 1, 'up'));
            render();
          },
        });
        if (!can) btn.setAttribute('disabled', 'disabled');
        const opts = [btn];
        // 退款：退一级，把当初升这一级花的点数原样还回来（等级降了，效果也就跟着降）
        if (lv > 0) {
          const back = costOf(line, lv - 1); // 从 lv-1 升到 lv 当时花的点数
          opts.push(X.el('button', {
            class: 'off',
            text: '退款（+' + back + ' 点）',
            onclick: () => {
              if (lv <= 0) return;
              m.points += back;
              m.lines[line.id] = lv - 1;
              saveMeta(id);
              def.lastMsg = '已退款：' + line.name + ' → Lv' + (lv - 1) + '/' + (line.max || 99);
              log('成长线 ' + line.id + ' 退了一级 → Lv' + (lv - 1));
              if (def.onChange) X.guard('metaPanel onChange', () => def.onChange(line.id, lv - 1, 'down'));
              render();
            },
          }));
        }
        rows.push(X.el('div', { class: 'set' }, [
          X.el('div', { text: line.name + '  Lv' + lv + '/' + (line.max || 99) }),
          X.el('div', { class: 'meta', text: typeof line.desc === 'function' ? String(line.desc(lv)) : String(line.desc || '') }),
          X.el('div', { class: 'opts' }, opts),
        ]));
      }
      return X.el('div', {}, rows);
    });

    X.extendApi(mod => ({
      // 局外数据（live 对象）：改了之后调 api.metaSave() 存起来
      meta: () => metaOf(mod.id),
      metaSave: () => saveMeta(mod.id),
      // 图鉴里一共有多少种：游戏自己的数据（GameData.dexData 每个物种一条），拿不到就 0
      dexTotal: () => {
        try {
          const gd = X.scene() && X.scene().gameData;
          if (gd && gd.dexData) {
            const n = Object.keys(gd.dexData).length;
            if (n > 0) return n;
          }
        } catch {}
        return 0;
      },
      // 和引擎一样的种子随机数（同样的字符串总是同样的数）：mod 用来掷骰子
      rng: X.rng,
      // 成长线面板：def = { title, summary(), note(), lines: [{ id, name, max, cost, desc(lv) }], onChange(id, lv, kind) }
      // kind 是 'up'（升级了）或 'down'（退款了）
      metaPanel(def) {
        if (panels[mod.id]) throw new Error('metaPanel: one per mod');
        if (!def || !Array.isArray(def.lines)) throw new Error('metaPanel needs lines');
        panels[mod.id] = def;
      },
    }));

    // ---- 捕捉到宝可梦 ----
    function rarityOf(gd, pokemon) {
      const species = pokemon && pokemon.species;
      if (!species) return null;
      const speciesId = species.speciesId;
      let first = true;
      try { const entry = gd && gd.dexData ? gd.dexData[speciesId] : null; first = !(entry && entry.caughtAttr); } catch {}
      let starterCost = 0; // 初始宝可梦在游戏里值几个点（1..10）：越贵越稀有
      try {
        // 第二个参数传 0：只看这只宝可梦「本来」值几个点，不算玩家用糖果降过的那部分，
        // 否则越常用的初始宝可梦反而点越少。
        if (gd && gd.starterData && gd.starterData[speciesId] && typeof gd.getSpeciesStarterValue === 'function') {
          const v = gd.getSpeciesStarterValue(speciesId, 0);
          if (Number.isFinite(v) && v > 0) starterCost = v;
        }
      } catch {}
      let baseTotal = 0;
      try { baseTotal = species.baseTotal || (species.getTotalStat ? species.getTotalStat() : 0) || 0; } catch {}
      return {
        speciesId, name: species.name || '', first,
        rarity: {
          mythical: !!species.mythical, legendary: !!species.legendary, subLegendary: !!species.subLegendary,
          baseTotal, starterCost,
        },
      };
    }
    function hookGameData(s) {
      const gd = s && s.gameData;
      if (!gd) return;
      const proto = Object.getPrototypeOf(gd);
      if (!proto || typeof proto.setPokemonCaught !== 'function') return;
      X.wrap(proto, 'setPokemonCaught', 'tg', orig => function (...args) {
        try {
          const pokemon = args[0], incrementCount = args[1], fromEgg = args[2];
          // 游戏自己的规矩（src/system/game-data.ts 的 setPokemonCaught）：
          //   incrementCount=true  是真的「获得」：野外捕捉、孵蛋、神秘遭遇，游戏都会记图鉴；
          //   incrementCount=false 是形态变化/进化，游戏只有在「根形态已经捕捉过」时才记图鉴，
          //                       否则那只是租借/借用来的，图鉴不动。
          // 所以这里照抄游戏的判断：算不算一次「获得」，和游戏自己记不记图鉴是一致的。
          let kind = null;
          if (incrementCount !== false) kind = fromEgg ? 'egg' : 'catch';
          else {
            let rootCaught = false;
            try {
              const rootId = pokemon.species.getRootSpeciesId();
              const entry = this.dexData && this.dexData[rootId];
              rootCaught = !!(entry && entry.caughtAttr);
            } catch {}
            if (rootCaught) kind = 'evolution'; // 进化出新形态
          }
          if (kind) {
            const info = rarityOf(this, pokemon);
            if (info) {
              info.kind = kind;
              for (const [m, fn] of X.listeners('pokemonCaught')) X.guard('pokemonCaught (' + (m && m.id) + ')', () => fn(info));
            }
          }
        } catch (e) { log('捕捉钩子出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return orig.apply(this, args);
      });
    }

    // ---- 扭蛋机的蛋 ----
    const pulls = { n: 0 };
    let eggProto = null;
    function installEgg(proto) {
      if (!proto || eggProto === proto) return;
      eggProto = proto;
      X.wrap(proto, 'rollEggTier', 'tg', orig => function (...args) {
        const tier = orig.apply(this, args);
        try {
          if (!GACHA_SOURCE.includes(this._sourceType)) return tier; // 只有扭蛋机抽的蛋才算
          const ev = { tier, sourceType: this._sourceType, n: ++pulls.n };
          let best = tier;
          for (const [m, fn] of X.listeners('gachaEggTier')) {
            const r = X.guard('gachaEggTier (' + (m && m.id) + ')', () => fn(ev));
            if (Number.isFinite(r) && r > best) best = Math.min(3, Math.floor(r));
          }
          if (best !== tier) {
            // 记在这只蛋身上：等它的名字被画出来的时候，后面加个「+」
            this.__tgBoosted = { from: tier, to: best };
            log('蛋升了一档：' + TIER_ZH[tier] + ' -> ' + TIER_ZH[best]);
            const bev = { tier, newTier: best, sourceType: this._sourceType, n: ev.n, egg: this };
            for (const [m, fn] of X.listeners('gachaEggBoosted')) {
              X.guard('gachaEggBoosted (' + (m && m.id) + ')', () => fn(bev));
            }
          }
          return best;
        } catch (e) { log('扭蛋机钩子出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return tier;
      });
      // 蛋的名字：扭蛋机结果页和背包里的蛋列表都是用它画的。
      // 被加成升过档的，后面加个「+」；问一遍开着 mod，它说自己认得这只蛋就标上
      // （mod 把自己升过档的蛋的编号记下来了，所以重开游戏以后还标得出来）。
      X.wrap(proto, 'getEggDescriptor', 'tg', orig => function (...args) {
        const s = orig.apply(this, args);
        try {
          const ev = { id: this._id, tier: this._tier, boosted: !!this.__tgBoosted, egg: this };
          let marked = ev.boosted;
          for (const [m, fn] of X.listeners('gachaEggMark')) {
            const r = X.guard('gachaEggMark (' + (m && m.id) + ')', () => fn(ev));
            if (r === true) marked = true;
          }
          return marked ? s + EGG_MARK : s;
        } catch (e) { log('蛋的标记出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return s;
      });
    }
    function findEgg(s) {
      const gd = s && s.gameData;
      const eggs = gd && gd.eggs;
      if (eggs && eggs.length) installEgg(Object.getPrototypeOf(eggs[0])); // 玩家已经有蛋了
      // 扭蛋机：包住 pullEggs。抽之前先告诉 mod「这一批要抽几个」，
      // 抽完第一批就知道游戏里「蛋」这个类了（那一批还是原来的稀有度）。
      const handlers = (s.ui && s.ui.handlers) || [];
      const h = handlers.find(x => x && x.constructor && x.constructor.name === 'EggGachaUiHandler');
      if (!h || h.__tgEggHooked) return;
      h.__tgEggHooked = true;
      const orig = h.pullEggs;
      if (typeof orig !== 'function') return;
      h.pullEggs = function (...args) {
        try {
          const ev = { count: Number(args[0]) || 0 };
          for (const [m, fn] of X.listeners('gachaPull')) {
            X.guard('gachaPull (' + (m && m.id) + ')', () => fn(ev));
          }
        } catch {}
        const eggs = orig.apply(this, args);
        try { if (eggs && eggs[0]) installEgg(Object.getPrototypeOf(eggs[0])); } catch {}
        return eggs;
      };
    }

    // ---- 常驻能力值加成 ----
    // 游戏的 Pokemon.calculateStats() 按「等级 + 个体值 + 性格 + 道具」重算一只宝可梦的能力值，
    // 结果存在 pokemon.stats 里（存档也存这份）。加成加在重算之后：数值直接变大，永久有效。
    const STAT_NUM = { hp: 0, atk: 1, def: 2, spatk: 3, spdef: 4, spd: 5 };
    const applied = new WeakMap(); // 宝可梦 -> 已经算进去的加成（用来发现「该重算了」）
    const sigOf = bonus => Object.keys(bonus).sort().map(k => k + ':' + (Number(bonus[k]) || 0)).join(',');

    // 现在该加多少：问一遍在跑的 mod（没开的 mod 不在 listeners 里）
    function bonusOf(pokemon) {
      const bonus = {};
      const ev = { pokemon, bonus };
      for (const [m, fn] of X.listeners('pokemonStatBonus')) {
        X.guard('pokemonStatBonus (' + (m && m.id) + ')', () => fn(ev));
      }
      return bonus;
    }
    // 把加成加到这只宝可梦身上（只有玩家自己的宝可梦；HP 不动）
    function applyBonus(pokemon) {
      if (!pokemon || typeof pokemon.isPlayer !== 'function' || !pokemon.isPlayer()) return;
      const bonus = bonusOf(pokemon);
      applied.set(pokemon, sigOf(bonus));
      for (const key of Object.keys(bonus)) {
        const num = STAT_NUM[key];
        if (!num) continue; // HP（0）不加
        const pct = Number(bonus[key]);
        if (!isFinite(pct) || !pct) continue;
        const cur = typeof pokemon.getStat === 'function' ? pokemon.getStat(num) : (pokemon.stats || [])[num];
        if (!(cur > 0)) continue;
        const next = Math.max(1, Math.round(cur * (1 + pct)));
        if (typeof pokemon.setStat === 'function') pokemon.setStat(num, next);
        else if (pokemon.stats) pokemon.stats[num] = next;
      }
    }
    X.pokemonClass(proto => {
      X.wrap(proto, 'calculateStats', 'tg', orig => function (...args) {
        const r = orig.apply(this, args);
        try { applyBonus(this); } catch (e) { log('能力值加成出错：' + String((e && e.stack) || e).slice(0, 200)); }
        return r;
      });
    });
    // 队伍里有宝可梦是引擎找到 Pokemon 这个类之前就有的（开局选初始宝可梦那会儿），或者刚点了升级：
    // 这两种时候能力值都还没算上加成，重算一遍就补上了。
    function refreshParty() {
      let party = [];
      try { party = X.battle.party(); } catch { return; }
      for (const p of party) {
        if (!p || typeof p.isPlayer !== 'function' || !p.isPlayer()) continue;
        if (typeof p.calculateStats !== 'function') continue;
        let want = '';
        try { want = sigOf(bonusOf(p)); } catch { continue; }
        if ((applied.get(p) || '') === want) continue; // 已经是对的
        try { p.calculateStats(); applied.set(p, want); } catch (e) { log('重算能力值出错：' + String((e && e.stack) || e).slice(0, 200)); }
      }
    }

    X.onTick(s => {
      try { hookGameData(s); findEgg(s); refreshParty(); } catch (e) { log('扩展出错：' + String((e && e.stack) || e).slice(0, 200)); }
    });
  });
})();
