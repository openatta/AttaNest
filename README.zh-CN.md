# AttaNest

[English](README.md) | 简体中文

**[AttaCore](https://github.com/openatta/AttaCore) 在浏览器里。** 一个 Rust 二进制：引擎、Web
服务器和前端是同一个进程 —— 没有子进程、没有 socket、没有 npm。

![AttaNest](docs/images/nest.png)

`daemon` 是个 lib，所以 `nest` 把引擎链进来，用函数调用而不是 socket 跟它说话。这一下省掉的
是一整类要运维的东西：引擎不用占端口、不用握手、不用健康检查、不用重启守护、不用 discovery
文件。前端则是原生 ES 模块，直接从二进制里发出去 —— 没有打包器、没有 `node_modules`，改一个
文件到刷新页面之间没有构建这一步。

## 状态

早期。底下的引擎是实打实的东西，UI 也已经够日常用，但这个仓库还年轻，浏览器与中枢之间的协议
是我们自己的、随时会动。会有破坏性变更；要依赖它就先钉住一个 commit。

## 跑起来

```sh
git clone --recurse-submodules https://github.com/openatta/AttaNest.git
cd AttaNest
cargo build --release
./target/release/nest                      # → http://127.0.0.1:4080/
```

Rust 1.80 以上。不需要 Node，不需要包管理器，别的也不需要。`--recurse-submodules` 是要紧的：
AttaCore 在 `core/`，编译要用它。

不需要任何环境变量。没有凭据时打开**设置 → 模型与凭据 → 添加 provider**，填 base URL 与 API
key 即可 —— 它写进 `settings.json`，不进浏览器也不进日志。习惯用环境变量就设
`ANTHROPIC_AUTH_TOKEN`（外加可选的 `ANTHROPIC_BASE_URL`）。两者都没有时启动会失败并明确说
明这件事。

## 有意思的地方

- **一个 turn 属于服务端，不属于你这个 tab。** 跑到一半关掉 tab、刷新、换一个 tab 回来 ——
  中枢**在任何浏览器开口之前**就已经订阅了这个会话，所以你错过的帧本来就在缓冲里，追上即可。
  整个设计压在这条不变量上，也正是刷新丢不掉半截回答的原因。

- **发给模型的东西，你能原样读到。** 不是摘要 —— 装配好的 system 块、完整工具表、调用配置，
  而且每一块、每一个工具都说得出自己出自哪个装配阶段（`identity`、`skills`、`memory`、
  `mcp:<server>`、`plugin:<id>`）。见下。

- **安装物是一个文件，界面照样能换。** 界面编译在里面，所以页面和后端不可能对不上。
  `--ui-dir` 整套替换掉它，什么都不用重编译；`--headless` 一张都不发；`nest ui export`
  把它写出来交给 CDN。

- **界面由六个具名接缝拼起来。** 工具行、详情面板、侧栏分组都是注册，不是 switch 分支——
  换一个产品是换一批注册，不是 fork，装上的包也走同样这几个点。

- **前端没有构建步骤。** 原生 ES 模块加 CSS，`nest --ui-dir ./ui` 从磁盘读：改完刷新就行。

- **它和终端共用状态。** 引擎目录就是 `attacored` 与 AttaCode 用的那个 `~/.atta`，所以在 TUI
  里跑过的会话在这里能直接打开，反过来也一样。

- **发送会排队，而不是失败。** 有 turn 在跑时发送会进队列，上一轮结束自动发出。按停止会连队列
  一起清掉。

- **只在本机，而且是真的按住了。** 只绑回环（`127.0.0.1` 与 `[::1]` 都绑，因为浏览器把
  `localhost` 先解析成 `::1`）、一个进程一个 token、Origin 校验，以及一份不留内联、不留外部源
  的 CSP。

- **中英双语**，运行时可切。

## 界面

三栏，形态参照 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：左侧会话列表
（按项目分组），中间对话流（流式 markdown、工具卡片、权限卡片、压缩标记、子 Agent），右侧详情栏
（一次调用的完整输入与输出）。

- Enter 发送，Shift+Enter 换行；`/` 唤起命令补全（来自引擎的实时命令表）；`@` 引用项目文件
  （走 `.gitignore`）
- ⌘K / Ctrl+K 新建会话；右键会话行 → 关闭 / 分叉 / 删除
- 左侧按项目分组：可折叠、每组默认 5 条、拖拽排序、重命名、归档。输入框内过滤标题，回车转为
  内容搜索
- 图片可粘贴或拖放进输入框，附件是 64px 缩略图
- 设置涵盖外观、语言、引擎设置（模型、单轮 token、权限模式 —— 每项可选择写进全局／场景／项目
  哪一层）、provider 与凭据、场景、MCP、插件、诊断

## 请求信封

![请求信封](docs/images/request-envelope.png)

每一次模型调用都带着一个信封 —— 装配好的系统提示词、每一个工具定义、调用配置 —— 而通常你是
看不到它的。AttaCore 会把每次调用录下来，Nest 把这些录像折成信封**发生变化**的那些点：对话里
一次变化一行，详情栏给全文。

因为它是从录像里读的、不是当事件收的，所以它留得住：刷新页面、明天重开这个会话、重启进程 ——
信封都还在。录像放在 `<atta-dir>/recordings/<session-id>/`，随会话一起删除。

录像里也就是模型看到的一切，明文，不做脱敏。请按它对应的 transcript 同等对待。

## 参数

```
nest --port 4080 --scene coding --scenes chat,research --model claude-sonnet-5
```

| 参数 | 说明 |
|---|---|
| `--port` / `--host` | 默认 `4080` / `127.0.0.1`。`--host` 只接受回环地址；给的是 IPv4 回环时会**同时监听 `[::1]`** |
| `--scene` / `--scenes` | 默认场景，以及一并激活的场景（`coding` `chat` `research` `demo`） |
| `--atta-dir` | 引擎目录：配置、transcript、记忆、技能、录像。默认 `$ATTA_CONFIG_HOME`，再默认 `~/.atta` |
| `--data-dir` | 项目目录：选择器从这里开始，新建项目也建在这里。默认 `$NEST_DATA_DIR`，再默认 `~/Documents` |

<details>
<summary>不那么常用的参数</summary>

| 参数 | 说明 |
|---|---|
| `--model` / `--max-tokens` | 给新会话用。settings 三层仍然优先于它，与 `attacored` 一致 |
| `--session-cap` / `--session-idle-timeout` | 活跃会话上限与空闲回收 |
| `--permission-prompt-timeout` | 权限提问多久没人答就按拒绝处理（默认 300 秒，UI 上是倒计时） |
| `--ui-dir` | 从这个目录发界面，替换掉编译进去的那份 |
| `--headless` | 一张界面都不发 —— 纯 RPC 节点 |
| `--profile` | 一份 profile：场景、provider、界面、传输拓扑。命令行参数覆盖它 |

</details>

## 插件

插件整件事都是 AttaCore 的——manifest、能力门控、沙箱、披露、生命周期。给 Nest 写插件就是
给 AttaCore 写插件，Nest 既不读一个包，也不跑一个包。这一侧再实现一遍，同一件事就有两处
真相，而两处里只有一处真的拦得住。

Nest 补的是引擎有意不做的那一步：`plugin.install` 自己去取 URL，没有上传通道——包已经在
跑引擎那台机器上时够用，在你笔记本上时就没有路。所以设置面板收一个 `.zip`，走大负载旁路
送上去，再把落盘路径交给引擎。其余全部转手：列举、启停、卸载，以及引擎装完回的那份披露；
只多做一步——Nest 在服务每个包的 `ui/` 目录，所以改变"装了什么"的调用之后要重读一遍。

**出厂的那个二进制就能装包。** 包方案——manifest、下载、校验、解包、披露、生命周期——不与
任何载体互斥，默认就在构建里；花二十兆的是 WebAssembly 载体，插件构建拿脚本载体去换的
也是它。一个不带包方案的构建会回 `PLUGINS_DISABLED`，界面就如实这么说，而不是显示成一个
空列表——"这个构建没有插件子系统"和"一个都没装"是两件不同的事。

## 目录

两个，只有两个：

- **引擎目录** `--atta-dir`（默认 `~/.atta`）—— 配置、transcript、记忆、技能、录像。与
  `attacored` / AttaCode 共用。
- **项目目录** `--data-dir`（默认 `~/Documents`）—— 选择器从这里开始，「新建项目」也建在这里。
  是默认位置不是围栏：`$HOME` 下别处的项目照样能打开。

```sh
nest --atta-dir /srv/atta --data-dir /srv/projects
```

安装物是这一个二进制，加上可选的界面产物目录。运行时不从安装目录读任何东西，所以升级就是换掉
那个文件。Nest 自己的账本（工作区、标题、视图偏好、token、上传）也是数据，放在项目目录里的
`.nest/`。

## 结构

内核是四件事 —— 装配、中枢、传输、授权 —— 它们之间的依赖是单向的。这条规则不是写在文档里，
是 `crates/app/tests/layering.rs` 断言出来的。

```
crates/app        bin `nest`：profile、装配顺序、授权表
crates/transport  通道语义 + 拓扑：帧、握手、静态面、大负载旁路
crates/authz      这个进程唯一的准入点：主体 × 方法，默认拒绝，可审计
crates/hub        会话中枢：订阅、重放、seq、turn 所有权、队列
crates/assembly   照 profile 把 AttaCore 引擎在进程内建起来
crates/contrib    界面的接缝：由代码生成的目录，与注册表
crates/builtin    Nest 自己的方法与界面部件，走的就是那个注册表
crates/contract   上面这些层互相递交的类型，仅此而已

ui/               界面，编译进二进制：runtime/、builtin/、shell/、styles/
core/             AttaCore（submodule）
```

## 文档

[docs/concept_and_architecture.md](docs/concept_and_architecture.md) 是设计 —— Nest 是什么、
内核是哪四件事、为什么它们一件都不可插拔、五种通道语义与它们映射到的三种拓扑、插件模型，
以及明确不做的事。

[docs/contribution_points.md](docs/contribution_points.md) 是贡献点目录 —— 九个点，各自给什么、
什么时候求值。它那张表由代码生成，对不上就有测试失败。

## 测试

```sh
cargo clippy --workspace
# 只跑我们的。被吸收进来的 AttaCore crate 里有测试假定 Core 自己是 workspace 根。
cargo test -p nest -p nest-hub -p nest-transport -p nest-authz \
           -p nest-assembly -p nest-contrib \
           -p nest-builtin -p nest-contract

node tests/style-lint.mjs                        # 样式静态检查（图标尺寸、令牌、id）
node tests/contrib-smoke.mjs                     # 贡献点，以及一次被拒绝的握手
node tests/budget.mjs                            # 性能预算，对着 release 构建
node tests/reducer-smoke.mjs                     # 前端逻辑，离线，最快
node tests/i18n-smoke.mjs                        # 语言包体检
node tests/readme-pairing.mjs                    # 两份 README 是一起改的
node tests/ui-smoke.mjs   <port> <token>         # 真引擎 + 真模型
node tests/tool-smoke.mjs <port> <token>         # 真工具调用
# 上面两个要后端带 `--scenes chat` 起；拓扑对比那个要后端同时服务两种拓扑：
#   nest --scenes chat --profile <一份两种拓扑都列上的 profile>

node tests/api/run.mjs                            # 后端，走它自己的 API
node tests/api/run.mjs --live                     # …改成对着真模型跑
node tests/api/run.mjs --topology split_streams   # 同一批用例走另一种拓扑
node tests/topology-parity.mjs <port> <token>     # 两种拓扑，同样的答案
node tests/remote-smoke.mjs <port> <token> <code> # 配对、连接、吊销，走 TLS

# 真浏览器。上面那些只要 node；这一层做的是假 DOM 做不到的事 —— 布局、主题，
# 以及到底有没有渲染出来。
npm install && npx playwright install chromium
npx playwright test
# 一个插件包，端到端 —— 从磁盘上的 zip 到屏幕上的一行，跑的就是出厂那个二进制。
node tests/package-e2e.mjs

# 对着真模型重录一份重放 fixture（需要 .env）。
node tests/api/record-fixture.mjs <name> "<提示词>"
```

`<token>` 从 `nest` 启动时打印的 token 文件里读（`<data-dir>/.nest/token`）。

**不要用 `cargo test --workspace`**：它会连带跑被吸收进来的 AttaCore crate，而 Core 有两条测试
假定自己是 workspace 根（从测试二进制往上找 `bridges/`），在我们这里必然失败。Core 的测试在
Core 里跑：`cd core && cargo test --workspace`。

## 许可

[Apache-2.0](LICENSE)。
