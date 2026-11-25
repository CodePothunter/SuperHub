<p align="center"><img src="site/assets/hub-fold.webp" width="190" alt="SuperHub 标志"></p>

<h1 align="center">SuperHub</h1>

<p align="center"><strong>从一句交办，到一份交付。</strong></p>
<p align="center">让 AI 分头忙，让你专心做主。</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="https://codepothunter.github.io/SuperHub/">在线演示</a> ·
  <a href="https://github.com/CodePothunter/SuperHub/releases/tag/v0.2.0">下载 0.2.0</a> ·
  <a href="#使用工作区">工作区</a> ·
  <a href="#导入与导出">导入与导出</a>
</p>

SuperHub 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的个人 AI 工作空间。从「今天」把事情交给接口人，团队在对应项目里推进。你可以继续手头的工作，等有空再从红点打开汇报，查看结论、补充方向，或沿原工单看过程。

![SuperHub 的今天首页，显示接口人、已有资料和三个项目工作区](screenshots/superhub/today.png)

*本文演示图全部使用通用虚构的项目、对话和文件。*

## 快速开始

需要 **Node.js 24+** 和 **DSH Web**。仓库以 DSH `0.2.2-rc.1` 作为打包安装与宿主回归的基准，建议同时安装 Git。

### 1. 安装 SuperHub

从 [SuperHub 0.2.0](https://github.com/CodePothunter/SuperHub/releases/tag/v0.2.0) 下载 `SuperHub-0.2.0.tgz`。在运行 DSH 的机器上，用实际文件路径安装：

```sh
dsh plugin --profile web add /absolute/path/to/SuperHub-0.2.0.tgz
dsh web
```

请通过本仓库的 GitHub Release 获取 SuperHub 安装包。

<details>
<summary>安装 DSH Web</summary>

```sh
npm install --global @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
```

</details>

<details>
<summary>从源码打包</summary>

```sh
pnpm install --frozen-lockfile
npm pack
```

打包会先运行类型检查、测试和构建。安装时使用终端输出的实际 `.tgz` 文件名。

</details>

### 2. 选择第二大脑目录

1. 打开 DSH Web，在侧栏选择「SuperHub」。
2. 选择 **DSH 主机**上的第二大脑目录。新用户可以用默认的 `~/chief-brain` 或另选空目录。已有资料时使用原目录。
3. 在「今天」点「一句话交办」，说清目标、材料和完成标准。也可以创建工作区，与本区成员直接沟通。

旧版资料可从「今天 → 导入 → 从上一版 SuperHub 导入」接入。导入后可在「今天 → 已有资料」查看。

<details>
<summary>检查安装与使用包内 CLI</summary>

在已安装插件的目录运行 `node bin/cli.mjs doctor`。

若宿主使用自定义 `DSH_HOME`，请在终端使用相同的配置。`doctor` 会显示第二大脑和运行环境。安装或升级之后，按宿主提示重启或刷新页面。

</details>

## 从一句交办开始

1. 在「今天」点**一句话交办**，说清目标和边界。例如「我先继续客户访谈。请核对产品研发的接入问题，给我修复与验证方案，实际改动等我确认。」
2. 接口人把任务交到对应工作区，回执带你找到原工单。团队在项目里核对材料、讨论和交付，你可以回到访谈继续工作。
3. 有新回复或汇报时，「一句话交办」会显示未读红点。你可以先把眼前的话写完，再打开汇报。红点清除代表已读，工单状态单独记录。
4. 先读结论与待确认项，再决定是否查看原会话。补一句方向后可以回到刚才的访谈，接着写原来的提纲。

![客户访谈仍停在原会话，研发汇报的未读红点显示在一句话交办入口旁](screenshots/superhub/unread.png)

## 使用工作区

**每个项目，都有自己的工作现场。** 工作区可以记录当前目标和绑定项目目录。「概览」按会话列出工单，「执行」可以打开原对话、继续发言或用 `@名字` 叫一位本区成员。打开工单可查看约定、范围与成果，并在原对话里找到交办和材料。仍在推进的工单可以暂停、恢复或收窄范围。

例如，产品研发保留接入排查的记录与验证方案，客户访谈保留原话与下一轮追问。回来时从本区的会话与工单接上，项目经验也有自己的使用范围。需要复用某个方法时，可以选择文字、接收成员与用途再共享。

![产品研发工单的原对话、报告附件与工单信息](screenshots/superhub/workspace.png)

### 你的团队，由你来组

在工作区的「幕僚」页，可以邀请全局名册里的成员并为这个项目设置职责，也可以创建专属幕僚，自己定名字、头像和职责。已有经验可查看来源，再决定是否采纳或共享。团队可按成员配置使用 DSH 模型、Codex 或 Claude Code，具体由主机环境提供。

![产品研发的示例阵容，包含从名册邀请的工程师、研究员和自建的验收顾问](screenshots/superhub/team.png)

### 在手机上接着做

已登录 DSH Web 时，可以打开同一站点的 `/chief/m/`。也可以在桌面的「设置」启用独立手机访问并设置密码，再从手机浏览器打开显示的地址。独立端口使用 HTTP，跨公网访问时请配置 HTTPS 反向代理。

<img src="screenshots/superhub/mobile.png" width="280" alt="在手机浏览器里查看接口人汇报、打开附件并补充方向">

## 导入与导出

换个工具，默契不用从零开始。在「今天 → 导入 → 从别的助手导入」复制提示词，发给你常用的助手，再把它对你的了解贴回来。在「核对资料」逐条查看原话和依据，选择采纳、修改后采纳或跳过。也可以把回答交给接口人，从回执进入核对页。

「导出」会整理你已确认的本人资料、协作约定与当前有效目标。文本可以带到 ChatGPT 或 Claude。本机的 Codex、Claude Code 可按导出页说明配置指令文件或会话启动背景。标记为 `[机密]` 的内容会被过滤。

![导入助手已有的了解，逐条核对后，导出给常用助手和编程工具](screenshots/superhub/import-export.png)

## 为什么这样设计

交办有去处，继续手头的事时知道去哪里找进展。工作区保存过程，未读汇报留在统一入口。「今天」保留项目与交付的全局视图，让你可以重新决定下一步该关注什么。这套设计借鉴了注意力残留、目标记忆与局势感知研究。[设计说明与参考资料](docs/attention.md)

## 你可能想知道

### SuperHub 和 DS Bot、Personal Agent 有什么区别？

**同一个用例。** 你正在根据受访者原话整理下一轮访谈提纲，产品研发的接入检查突然失败了。你想请 AI 核对接入记录，交一份修复与验证方案，实际改动等你确认。

**DS Bot** 把研发排查交到专门的群聊，由群管理员叫来工程和验证 Bot，也可以直接 `@` 对应成员。研发群有自己的记忆和工作目录，Bot 把结果发回群里，你也可以在任务页查看后台进度。[DS Bot 功能说明](https://github.com/Fei-Craft/DS-Bot#features)

**Personal Agent（以「搭档」为例）** 把排查交给面板或微信里的同一个助手。助手把请求登记为工单，安排在该工单的会话和目录里执行。你可以从原交办入口接回结果，也能在面板看在办事项，或从日报集中回看。[「搭档」项目说明](https://github.com/yinguobing/dsh-personal-agent)

**SuperHub** 从「一句话交办」把排查交给接口人。它把原话、交付要求和改动边界放进「产品研发」的工单，由本区幕僚分工。你回「客户访谈」继续写提纲。

- **工作区 Context 隔离。** 接入记录、排查对话和验证方案留在「产品研发」，受访者原话和提纲留在「客户访谈」。同一位幕僚可以参与两边，按各自的项目职责和本区经验工作。想把研发现成的「怎么标注待核实项」用在访谈里，可以只共享那条经验，选定接收工作区和成员。
- **注意力管理。** 研发交回方案时，「一句话交办」出现未读红点，眼前仍是访谈对话。你可以先写完这段，再打开汇报，看结论、待确认项和建议下一步。要补方向或追溯依据时，从汇报回到原工单。也可以回「今天」，一起看各项目的交付。

[在在线演示里走一遍这个用例](https://codepothunter.github.io/SuperHub/#story-sequence)

## 体验在线演示

[打开 SuperHub 演示](https://codepothunter.github.io/SuperHub/)。用滚轮或左右方向键推进场景，也可以切换「产品研发」「客户访谈」「研究周报」，查看各自的工单、材料与成员。演示使用内置样例。

从源码预览时，在仓库根目录运行 `python3 -m http.server 8080 --bind 127.0.0.1 --directory site`，再打开 [本地演示](http://127.0.0.1:8080/)。

## 数据存放

业务记录保存在所选第二大脑目录。工作区记录位于 `ops/superhub-v2/`，会话来源位于 `ops/superhub-v2-dialogues/`，每场会话有单独的 `work/superhub-v2/` 子目录。第二大脑位置、接口人会话和手机访问设置保存于 DSH 主机的 `$DSH_HOME/chief/`。执行时，任务所需内容会交给你配置的模型服务商。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm smoke
```

- [src/core](src/core) 与 [src/dsh](src/dsh) 包含工单、运行时和执行器适配。
- [src/client](src/client) 与 [src/mobile](src/mobile) 包含桌面和手机页面。
- [site](site) 包含独立静态落地页和通用演示素材。
- [注意力设计](docs/attention.md) · [CI 回归入口](.github/workflows/check.yml)

## 许可

[MIT](LICENSE) · [第三方声明](NOTICE)
