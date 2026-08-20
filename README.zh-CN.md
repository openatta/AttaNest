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

- **前端没有构建步骤。** `nest --assets-dir ./assets` 让 SPA 从磁盘读而不是从二进制读：改完
  刷新就行。

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
| `--assets-dir` | 前端从磁盘读而不是从二进制读 —— 开发时用 |

</details>

## 目录

两个，只有两个：

- **引擎目录** `--atta-dir`（默认 `~/.atta`）—— 配置、transcript、记忆、技能、录像。与
  `attacored` / AttaCode 共用。
- **项目目录** `--data-dir`（默认 `~/Documents`）—— 选择器从这里开始，「新建项目」也建在这里。
  是默认位置不是围栏：`$HOME` 下别处的项目照样能打开。

```sh
nest --atta-dir /srv/atta --data-dir /srv/projects
```

安装物只有这一个二进制。网页应用编译在里面，运行时不从安装目录读任何东西。Nest 自己的账本
（工作区、标题、视图偏好、token、上传）也是数据，放在项目目录里的 `.nest/`。

## 结构

```
crates/app      bin `nest`
crates/web      axum：静态面、/ws、/upload、Origin + token + CSP
crates/hub      会话中枢：唯一的引擎连接、事件重放、发送队列、方法白名单
crates/engine   AttaCore 装配
assets/         无构建的 SPA：index.html + styles/*.css + src/**.js，编译进二进制
core/           AttaCore（submodule）
```

## 文档

[docs/architecture.md](docs/architecture.md) 是设计记录 —— 为什么浏览器不直连引擎（§3）、追赶
与重放怎么保证刷新不丢内容（§5）、哪些方法不对浏览器开放（§4.1）、引擎跑在进程内的取舍
（§2）。

## 测试

```sh
cargo clippy --workspace
cargo test -p nest -p nest-hub -p nest-engine -p nest-web   # 我们的 Rust 测试

node tests/style-lint.mjs                        # 样式静态检查（图标尺寸、令牌、id）
node tests/reducer-smoke.mjs                     # 前端逻辑，离线，最快
node tests/i18n-smoke.mjs                        # 语言包体检
node tests/readme-pairing.mjs                    # 两份 README 是一起改的
node tests/ui-smoke.mjs   <port> <token>         # 真引擎 + 真模型
node tests/tool-smoke.mjs <port> <token>         # 真工具调用
```

`<token>` 从 `nest` 启动时打印的 token 文件里读（`<data-dir>/.nest/token`）。

**不要用 `cargo test --workspace`**：它会连带跑被吸收进来的 AttaCore crate，而 Core 有两条测试
假定自己是 workspace 根（从测试二进制往上找 `bridges/`），在我们这里必然失败。Core 的测试在
Core 里跑：`cd core && cargo test --workspace`。

## 许可

[Apache-2.0](LICENSE)。
