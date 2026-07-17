# Booster Match Runner

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Booster 内部参考（喂给 AI 的上下文）](./docs/booster-internals.md)

一个 **Booster Studio** 侧边栏插件，用于在两个 agent（红方 vs 蓝方）之间运行 **3v3 机器人足球比赛**，提供实时比分、关键事件时间线、无头对战、以及比赛记录自动归档。

> 整个面板——每个标签、按钮、事件名——都支持**一键中英文切换**，语言选择会被记住。

---

## ✨ 主要功能

- **选择双方 agent**：从运行中的仿真容器和/或本地 `.agent` 文件里挑选（红方 vs 蓝方）。
- **两种运行模式**
  - **Start Match + UI（带界面）**：打开仿真回放窗口并开始可视化比赛。
  - **Start Headless（无头）**：不开可视化界面运行比赛。
- **实时比分与比赛时间**：每 3 秒轮询，自动检测比赛结束。
- **Key Events 关键事件时间线**：进球、犯规、定位球等，增量读取自容器内的 `events.jsonl`。
- **自动保存与导出**
  - 每场结束的比赛自动归档到 `~/.booster-match-runner/matches/`（zip 内含：摘要 + 事件 + 运行日志）。
  - **Match records（比赛记录）**选择器：在文件管理器中定位，或**全部导出为 CSV**（Excel 友好，UTF-8 BOM）。
  - **Save log**：手动把当前比赛打包成 zip。
- **上传 `.agent`** 包直接部署进容器。上传的 agent 若 ID 已存在，可选择用**自定义 ID/名称**部署为独立副本（或直接覆盖）——这样同一个 agent 可以同时作为红蓝双方对战。
- **管理 agent**：**Manage** 操作列出全部 agent，可删除任意一个（容器内 agent 从容器移除，本地 `.agent` 文件从磁盘删除），删除前有二次确认。
- **启动仿真容器**：容器没运行时可从面板一键启动（启动过程中显示转圈动画）。
- **可选自动结束**：在面板设置超时秒数和/或领先球数阈值；填 `0` 表示不启用，比赛仅在仿真判定结束时结束。
- **抗重载**：插件能在 Booster Studio 窗口重载/重开后恢复——红蓝下拉自动恢复到当前比赛的两队，**End（结束）**按钮在比赛进行中保持可点击。
- **诊断与取证**：**Diagnose** 按钮列出运行中的 `ros2 launch` 进程和堆积的 sandbox；开赛失败时，故障现场（`run.py` 日志尾、`/health`、进程列表）会自动保存到 `~/.booster-match-runner/match-start-failure.log`。正在比赛中的 agent 会被禁止删除。

---

## 🔢 版本与 Booster 版本映射表

| 插件版本 | Booster Studio | 仿真镜像（默认） | 备注 |
|---|---|---|---|
| 0.2.4 | **1.9.10** | 自动探测（任意 tag） | 修复：End→Start 后机器人不动——End 与每场启动前清理残留的 team `ros2 launch` 父进程 |
| 0.2.3 | **1.9.10** | 自动探测（任意 tag） | 可视化模式支持 Count、自动结束不再杀整个批次、start/end 重试、插件市场安装 |
| 0.2.2 | **1.9.10** | 自动探测（任意 tag） | 机器人不动取证日志 + 诊断按钮、比赛中删除 agent 保护、错误提示重启 Studio |
| 0.2.1 | **1.9.10** | 自动探测（任意 tag） | 重载后仍生效的自动结束、按镜像名自动探测容器、无头模式按钮状态修复、配置项移至设置页 |
| 0.2.0 | **1.9.10** | `virtual-robot:0.6.5-beta` | 重复 ID 上传支持自定义 id/名称、agent 管理与删除、重载后恢复队伍选择 |
| 0.1.0 | **1.9.10** | `virtual-robot:0.6.5-beta` | 中英 i18n、新图标、GitHub Actions 发布流水线 |

> 要求的 Booster Studio 版本也写在 `package.json` 的 `engines.boosterStudio` 中。

---

## ✅ 环境要求

- **Booster Studio ≥ 1.9.10**。
- **Docker** 可在宿主机命令行调用（`docker` 在 PATH 中）。
- 正在运行的 **virtual-robot 仿真容器**（插件可以帮你启动）。
- 仅在源码编译时需要 Node.js 18+。

---

## 🔧 首次使用前必读（重要）

本插件对接的 3v3 比赛运行环境——game-control HTTP API（端口 **38383**）、`football3v3_runner`、`events.jsonl` 日志——**并非镜像自带，而是 Booster Studio 在你点击「运行」按钮时才部署进容器的**。因此，首次使用前（以及每次重建容器后）必须先手动部署一次：

1. 在 Booster Studio 左侧活动栏打开 **ROBOTS** → 选择 **Virtual robot**，创建并启动 Docker 容器。
2. 点击右上角的 **运行** 按钮，Booster Studio 会向容器部署完整的 3v3 比赛依赖。
3. 等容器内出现 `football3v3_runner`、38383 端口开始监听后，插件即可正常发起比赛。

> ⚠️ **容器重建后需重新部署**：如果该 Docker 容器被删除后重新创建，上述依赖会丢失，必须**再点一次「运行」按钮**重新注入，否则插件会一直卡在 `Health 1/15 … 15/15`，最终报 `Runner not ready in 75s`。

---

## 📦 安装方式

### 方式 A — 从插件市场安装（推荐）

在 Booster Studio 中打开 **扩展** 视图（`Ctrl+Shift+X` / `Cmd+Shift+X`），搜索 **Booster Match Runner**，点击 **Install** 即可。

### 方式 B — 从 Release 下载（.vsix）

1. 进入项目的 **Releases** 页面，下载最新的 `booster-match-runner-<版本>.vsix`。
2. 安装到 Booster Studio，二选一：
   - **图形界面：** 命令面板 → `Extensions: Install from VSIX...` → 选择该文件。
   - **命令行：**
     ```bash
     # Windows
     "<BoosterStudio路径>\bin\booster-studio.cmd" --install-extension booster-match-runner-<版本>.vsix --force
     # macOS / Linux
     booster-studio --install-extension booster-match-runner-<版本>.vsix --force
     ```
3. 重新加载窗口，活动栏会出现 **Match Runner** 图标。

### 方式 C — 源码编译

```bash
npm install
npm run compile
npx vsce package --no-git-tag-version --allow-missing-repository
# 然后按方式 B 安装生成的 .vsix
```

> fork 仓库 + 流水线编译的方式见 [自定义编译](#-自定义编译与流水线发布)。

---

## ⚙️ 配置项

在 Booster Studio 设置中搜索 `boosterMatch`：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `boosterMatch.containerName` | `""` | Docker 容器名；为空时按 `simImage` 自动探测。 |
| `boosterMatch.simImage` | `""` | 可选，用于自动探测仿真容器的镜像名（子串匹配）。留空则兜底匹配 `virtual-robot/virtual-robot`（任意版本）；填完整 image:tag 可锁定指定版本。 |
| `boosterMatch.gameControlPort` | `38383` | **容器内** game-control HTTP API 端口。 |
| `boosterMatch.defaultOpponent` | `com.booster.default3v3ai` | 默认蓝方 agent id。 |
| `boosterMatch.matchLength` | `0` | 开赛后经过该秒数自动结束单场。`0` = 不启用（跑到仿真结束或手动点 End）。 |
| `boosterMatch.leadGoals` | `0` | 任一方领先达到该球数即自动结束（双向）。`0` = 不启用。 |
| `boosterMatch.hostAgentRoots` | `[]` | 宿主机目录，用于扫描 `.agent` 文件（深入一层工程目录 + 根目录下的 `.agent`）。 |

---

## 🕹️ 使用说明

1. 确认仿真容器在运行（没有就点 **Start Container**）。
2. 在 **Teams** 区域选择 **红方 / 蓝方** agent。
3. （可选）设置 **Count（次数）**——多场比赛会逐场排队执行。
4. 点 **Start Match + UI**（可视化）或 **Start Headless**（无界面）。
5. 观察实时比分与 Key Events；比赛结束会自动保存。
6. 用 📋 按钮打开 **Match records**，定位文件或导出全部为 CSV。
7. 用 **Manage** 删除不再需要的 agent（容器内 agent 或本地 `.agent` 文件）。

---

## 🛠️ 自定义编译与流水线发布

本仓库自带 GitHub Actions（`.github/workflows/release.yml`）：

- 遇到任意 **`v*` 开头的 tag**（如 `v0.1.0`）自动触发；
- 在 Ubuntu + Node 20 上构建 `.vsix`；
- 把产物附加到**该 tag 对应的 Release**，并自动生成更新说明。

**Fork → 改代码 → 发布** 流程：

```bash
git clone https://github.com/Samge0/booster-match-runner
# ……修改代码，在 package.json 改版本号……
git tag v0.1.0
git push origin v0.1.0
# GitHub Actions 会自动构建并把 .vsix 发布到你 fork 的 Releases
```

> 该流水线**无需任何 secret** —— `permissions: contents: write` 已足够 `softprops/action-gh-release` 使用。

---

## 🤖 优先用 AI 解决问题

这个插件比较复杂（涉及 Docker、ROS2 环境、容器内 HTTP API）。**遇到问题，建议优先问 AI**——把报错加上 [docs/booster-internals.md](./docs/booster-internals.md) 里的相关上下文（镜像、路径、API、runner 启动命令、设计原理）一起发给 AI。那份文档本来就是为「喂给 AI」而写的，方便 AI 帮你修 bug 或加功能。

文档末尾还附了一段现成的 prompt，可以让本地 AI **自动编译并把插件安装到 Booster Studio**。

---

## 💬 社群

本插件运行在 **Booster Studio**（加速进化 Booster Robotics 出品的具身开发 IDE）之上。加速进化是一家专注为人形机器人（T1 / K1）打造开发者平台的公司，并开源了本插件所驱动的足球技术栈。加入 Booster 开发者社群可获取最新资讯、机器人开源资料与技术交流：

| 飞书群 | Discord | 官网 |
|:---:|:---:|:---:|
| <img src="https://github.com/user-attachments/assets/41885d6f-fca4-4acc-bab4-6a12fe5bbd55" alt="Booster Studio 开发者社群" width="128"> | <img src="https://github.com/user-attachments/assets/c2c24437-9cda-4bc8-a72e-100031e77fca" alt="Discord 二维码" width="128"> | <img src="https://github.com/user-attachments/assets/2a1e1f21-95b7-4dae-a20e-019fbe46274a" alt="Booster官网二维码" width="128"> |
| [Booster Studio 开发者社群](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=cd0g4e4b-661a-4ab3-8555-f4be56b173ae) | [Booster Discord](https://discord.gg/dCJARfRfe) | [booster.tech](https://www.booster.tech/) |


---

## 🤝 参与贡献

欢迎提 Issue 和 **Pull Request**。改动较大时，请描述你要修复的场景。

---

## ⚠️ 免责声明

- 本项目**主要用于学习与研究** Booster 机器人足球开发。
- 代码由 **AI 辅助生成**；遇到兼容性问题或 bug 时，建议优先与 AI 协作迭代解决——这是预期的工作流，不是退路。
- 本项目**与 Booster Robotics 无关、也未获其背书**，所有商标归 respective 所有者。
- 风险自负；正式依赖比赛结果前请自行核对。

---

## 📄 许可证

MIT
