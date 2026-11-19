// 训练家提升（trainer-growth）0.3.0
//
// 规则：
//   - 捕捉到一只宝可梦时给成长点。同一只只算第一次：这只在这台设备上已经算过点，就不再给。
//   - 给多少点看稀有度：神话 > 传说 > 准神 > 初始宝可梦（游戏里选它要几个点）> 普通野外宝可梦。
//   - 成长点是局外的（存在 localStorage，关掉游戏、换存档都还在），用来升级下面这些成长线。
//   - 扭蛋机蛋的稀有度：每级让抽到的蛋有 12% 的概率升一档（普通→高级→超级→大师）。
//   - 局内运气：每级给队伍 +1 点运气（游戏里的运气值 0..14），战后奖励更容易出好东西。
//   - 常驻能力值：每级让玩家自己的每一只宝可梦的这项能力 +10%（像挥剑舞那样一直有效）：
//     升级、进化、换宝可梦都还在，敌人的不受影响。
//   - 免费刷新商店：每级让每场战斗结束后有 1 次免费刷新（游戏里那个「刷新商店」按钮）。
//   - 战后奖励栏位：每级让战后奖励的道具栏位 +1（默认 3 个）。
CoopMods.define('trainer-growth', function (api) {
  const M = api.meta(); // 局外数据：{ points, lines: {}, caught: {} }

  // ---- 稀有度 → 成长点 ----
  const POINTS = {
    mythical: 120, legendary: 80, subLegendary: 40,
    starterTop: 30, starterMid: 22, starterLow: 15, starterCheap: 10,
    wildBig: 10, wild: 6,
  };
  function pointsOf(r) {
    if (!r) return 0;
    if (r.mythical) return POINTS.mythical;
    if (r.legendary) return POINTS.legendary;
    if (r.subLegendary) return POINTS.subLegendary;
    if (r.starterCost > 0) {
      return r.starterCost >= 7 ? POINTS.starterTop : r.starterCost >= 5 ? POINTS.starterMid : r.starterCost >= 3 ? POINTS.starterLow : POINTS.starterCheap;
    }
    return r.baseTotal >= 600 ? POINTS.wildBig : POINTS.wild;
  }
  function rarityName(r) {
    if (!r) return '普通';
    if (r.mythical) return '神话';
    if (r.legendary) return '传说';
    if (r.subLegendary) return '准神';
    if (r.starterCost > 0) return '初始宝可梦（' + r.starterCost + ' 点）';
    return '野外';
  }

  // ---- 捕捉：第一次才算点 ----
  api.on('pokemonCaught', ev => {
    if (!ev || !ev.first) return;
    const key = String(ev.speciesId);
    if (M.caught[key]) return; // 这台设备上已经算过这只了
    const points = pointsOf(ev.rarity);
    if (!(points > 0)) return;
    M.caught[key] = points;
    M.points += points;
    M.total = (Number(M.total) || 0) + points;
    api.metaSave();
    api.log('捕捉到 ' + ev.name + '（' + rarityName(ev.rarity) + '）：+' + points + ' 成长点，一共 ' + Math.floor(M.points) + ' 点');
  });

  // ---- 成长线 ----
  const GACHA_STEP = 0.12; // 每级：蛋升一档的概率
  const STAT_STEP = 0.10;  // 每级：这项能力 +10%（对玩家自己的每一只宝可梦）
  const STAT_MAX = 5;      // 每项能力最多几级（5 级 = +50%）
  const STAT_COST = 120;   // 能力值每级多少点
  // 能力值：key 是游戏里的名字（atk/def/spatk/spdef/spd），id 是成长线的名字
  const STATS = [
    { id: 'statAtk', key: 'atk', name: '攻击' },
    { id: 'statDef', key: 'def', name: '防御' },
    { id: 'statSpAtk', key: 'spatk', name: '特攻' },
    { id: 'statSpDef', key: 'spdef', name: '特防' },
    { id: 'statSpd', key: 'spd', name: '速度' },
  ];
  const LINES = [
    {
      id: 'gacha', name: '扭蛋机蛋的稀有度', max: 5, cost: 200,
      desc: lv => '抽到的蛋有 ' + Math.round(GACHA_STEP * lv * 100) + '% 的概率升一档（普通→高级→超级→大师）。',
    },
    {
      id: 'luck', name: '局内运气', max: 5, cost: 150,
      desc: lv => '队伍的运气 +' + lv + '（游戏里的运气值 0..14）。战后奖励更容易出好东西，野怪也更容易出稀有种。',
    },
    {
      id: 'freeReroll', name: '免费刷新商店', max: 3, cost: 150,
      desc: lv => '每场战斗结束后有 ' + lv + ' 次免费刷新（战后奖励界面左下角那个「刷新商店」）。',
    },
    {
      id: 'rewardSlots', name: '战后奖励栏位', max: 5, cost: 120,
      desc: lv => '战后奖励的道具栏位 +' + lv + '（默认 3 个，可以挑的更多）。',
    },
  ].concat(STATS.map(s => ({
    id: s.id, name: '常驻' + s.name, max: STAT_MAX, cost: STAT_COST,
    desc: lv => '自己的每只宝可梦' + s.name + ' +' + Math.round(STAT_STEP * lv * 100) + '%（升级、进化、换宝可梦都还在，敌人不受影响）。',
  })));
  const level = id => {
    const l = LINES.find(x => x.id === id);
    if (!l) return 0;
    return Math.max(0, Math.min(l.max, Math.floor(Number(M.lines[id]) || 0)));
  };

  // 面板顶上那一行：现在这些成长线加在一起是什么效果
  function summary() {
    const parts = [];
    const luck = level('luck');
    if (luck > 0) parts.push('运气 +' + luck);
    const gacha = level('gacha');
    if (gacha > 0) parts.push('抽蛋升档 +' + Math.round(GACHA_STEP * gacha * 100) + '%');
    const freeReroll = level('freeReroll');
    if (freeReroll > 0) parts.push('免费刷新 ×' + freeReroll);
    const rewardSlots = level('rewardSlots');
    if (rewardSlots > 0) parts.push('奖励栏位 +' + rewardSlots);
    for (const s of STATS) {
      const lv = level(s.id);
      if (lv > 0) parts.push(s.name + ' +' + Math.round(STAT_STEP * lv * 100) + '%');
    }
    return parts.length ? parts.join(' · ') : '还没有升级任何成长线';
  }

  api.metaPanel({
    title: '成长点',
    summary,
    lines: LINES.map(l => ({ id: l.id, name: l.name, max: l.max, cost: l.cost, desc: l.desc })),
    onChange: (lineId, lv) => {
      // 效果都是用的时候现算的，这里只是在游戏里也提示一句（面板开着时在面板后面，关掉就能看到）
      try {
        const l = LINES.find(x => x.id === lineId);
        if (l) api.battle.message('训练家提升：' + l.name + ' Lv' + lv);
      } catch {}
    },
  });

  // ---- 效果 1：局内运气 ----
  // 游戏把队伍的运气加到 0..14：奖励选项的稀有度、奖励画面上的字母、野外宝可梦的稀有度都用它。
  api.on('teamLuck', ev => {
    const lv = level('luck');
    return lv > 0 ? lv : undefined;
  });

  // ---- 效果 2：扭蛋机蛋的稀有度 ----
  api.on('gachaEggTier', ev => {
    const lv = level('gacha');
    if (!(lv > 0) || ev.tier >= 3) return;
    const p = GACHA_STEP * lv;
    const roll = api.rng('trainer-growth:gacha:' + ev.n + ':' + ev.tier)();
    return roll < p ? ev.tier + 1 : undefined;
  });

  // ---- 效果 3：常驻能力值 ----
  // 扩展在游戏算完能力值之后问一遍：往 ev.bonus 里写比例，它会加到这只宝可梦的数值上。
  // 每一只玩家自己的宝可梦都算（所以换宝可梦也照样有），敌人的不算。
  api.on('pokemonStatBonus', ev => {
    if (!ev || !ev.bonus) return;
    for (const s of STATS) {
      const lv = level(s.id);
      if (lv > 0) ev.bonus[s.key] = (Number(ev.bonus[s.key]) || 0) + lv * STAT_STEP;
    }
  });

  // ---- 效果 4：免费刷新商店 ----
  // 战后奖励界面左下角那个「刷新商店」按钮（重掷战后奖励）本来要钱，
  // 这里给的成长线让它每场战斗有几次是免费的：换一场战斗（层数变了）重新给满。
  // 次数记在这一局的存档里（api.runState()），关掉游戏也还在。
  function freeRerollLeft() {
    const lv = level('freeReroll');
    if (!(lv > 0)) return 0;
    const st = api.runState();
    const wave = api.battle.wave();
    if (st.frWave !== wave) { st.frWave = wave; st.frUsed = 0; } // 新的一场战斗，重新给次数
    return Math.max(0, lv - (Number(st.frUsed) || 0));
  }
  api.on('rerollCost', ev => {
    if (!ev || !(ev.cost > 0)) return;
    const left = freeRerollLeft();
    if (left > 0) return { cost: 0, label: '免费×' + left }; // 按钮下面会写「免费×N」
  });
  api.on('rerolled', ev => {
    if (!ev || !ev.free) return; // 只有免费的刷新才用掉一次
    freeRerollLeft();
    const st = api.runState();
    st.frUsed = (Number(st.frUsed) || 0) + 1;
  });

  // ---- 效果 5：战后奖励的栏位 ----
  // 常规战斗结束后那排道具（默认 3 个）能多几个，可以挑的更多。
  api.on('rewardCount', ev => {
    const lv = level('rewardSlots');
    if (lv > 0 && ev) return ev.count + lv;
  });
});
