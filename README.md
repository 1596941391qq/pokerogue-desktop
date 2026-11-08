# PokéRogue 宝可梦肉鸽 · 电脑离线版（Windows / Mac）

把官方开源游戏 [PokéRogue](https://github.com/pagefaultgames/pokerogue) 打包成电脑上双击就能玩的离线版。不用联网，不用登录，存档保存在自己电脑上。

手机版（安卓 / iOS）在另一个仓库：[pokerogue-ios-android](https://github.com/1596941391qq/pokerogue-ios-android)。三个平台的游戏内容完全一样，都来自同一份官方构建。

## 下载

去 [Releases](https://github.com/1596941391qq/pokerogue-desktop/releases) 下载最新版：

| 文件 | 适合谁 |
|---|---|
| `prsYYMMDD-portable.exe` | Windows 玩家，双击就能玩。每次启动要先解压，慢一点 |
| `prsYYMMDD-pc.zip` | Windows 玩家，电脑性能一般的推荐用这个。解压后双击「启动游戏.exe」 |
| `prsYYMMDD-mac-arm64.dmg` | M 芯片的 Mac（M1 及以后） |

### 老玩家升级

直接下新版用就行，**存档会自动接上**。存档放在：
- Windows：`%APPDATA%\pokemon-rogue-battle`
- Mac：`~/Library/Application Support/pokemon-rogue-battle`

升级前建议先在游戏里「管理数据 → 导出数据」备份一份。

### Mac 打不开？

这个版本没有付费的苹果开发者签名，第一次打开会提示「无法验证开发者」：在「访达 → 应用程序」里**右键点 PokeRogue → 打开**，再点「打开」。如果提示「已损坏」，在终端运行：

```bash
xattr -cr /Applications/PokeRogue.app
```

## 自己构建

```bash
npm ci
npm run fetch-game        # 按 game-version.json 把游戏构建拉到 dist/
npm start                 # 本机运行
npm run dist:win          # 出 Windows 便携版 exe + zip
npm run dist:mac          # 出 Mac dmg
```

更新游戏版本：先在手机版仓库同步官方新版本，再把那边的提交号写进 `game-version.json` 的 `sourceRef`。推送 `pokerogue日期` 格式的标签，GitHub Actions 会自动打包并上传到同名 Release。

## 源码与许可证

游戏本体 PokéRogue 由 Pagefault Games 开发，以 AGPL-3.0 开源。这个仓库只做电脑端打包，同样以 AGPL-3.0 发布，见 [LICENSE](LICENSE)。

打包：B 站 UP 主 黑咖啡和冰月亮。免费提供，禁止倒卖。

---

**English:** Offline desktop build (Windows / macOS) of the open-source game [PokéRogue](https://github.com/pagefaultgames/pokerogue) by Pagefault Games, packaged with Electron. Saves stay on your computer. Licensed under AGPL-3.0.
