# Nest

AttaCore 在浏览器里。一个 Rust 二进制：引擎、Web 服务器和前端都在里面，没有子进程、
没有 socket、没有 npm。

```sh
export ANTHROPIC_AUTH_TOKEN=...        # 或 ANTHROPIC_API_KEY；ANTHROPIC_BASE_URL 可选
cargo build --release
./target/release/nest                  # → http://127.0.0.1:4080/
```

```
nest --port 4080 --scene coding --scenes chat,research --model claude-sonnet-5
```

| 参数 | 说明 |
|---|---|
| `--port` / `--host` | 默认 `4080` / `127.0.0.1`（3080 是 DSH 的默认端口，让开）。`--host` 只接受回环地址；给的是 IPv4 回环时会**同时监听 `[::1]`**，因为浏览器把 `localhost` 先解析成 `::1` |
| `--scene` / `--scenes` | 默认场景与额外激活的场景（`coding` `chat` `research` `demo`） |
| `--model` / `--max-tokens` | 新会话的模型；settings 三层仍然优先于它，与 `attacored` 一致 |
| `--session-cap` / `--session-idle-timeout` | 会话上限与空闲回收 |
| `--permission-prompt-timeout` | 权限提问多久没人答就按拒绝处理（默认 300 秒，UI 上是倒计时） |
| `--atta-dir` | 引擎目录：配置、transcript、记忆、技能。默认 `$ATTA_CONFIG_HOME`，再默认 `~/.atta`（与 attacored / AttaCode 共用） |
| `--data-dir` | 项目目录：选择器从这里开始，新建项目也建在这里。默认 `$NEST_DATA_DIR`，再默认 `~/Documents` |

## 目录

两个可配置目录：

- **引擎目录** `--atta-dir`（默认 `~/.atta`）—— 配置、transcript、记忆、技能、录像。与
  `attacored` / AttaCode 共用，所以在 TUI 里跑过的会话在这里能直接打开。
- **项目目录** `--data-dir`（默认 `~/Documents`）—— 选择器从这里开始，「新建项目」也建在
  这里。是默认位置不是围栏：`$HOME` 下别处的项目照样能打开。

```sh
nest --atta-dir /srv/atta --data-dir /srv/projects
```

安装物只有这个二进制（网页应用编译在内，运行时不从安装目录读任何东西；`--assets-dir` 是
开发时的例外）。Nest 自己的账本（工作区分组、会话标题、视图偏好、token、上传）也是数据，
放在项目目录里的 `.nest/`，跟着 `--data-dir` 一起走（`NEST_STATE_DIR` 可单独移）。

## 第一次运行

不需要任何环境变量：

```sh
nest                      # 打开 http://127.0.0.1:4080/
```

没有模型凭据时，到**设置 → 模型与凭据 → 添加 provider**填 base URL 与 API key 即可开跑；
凭据写进 settings.json，不进浏览器也不进日志。也可以照旧用 `ANTHROPIC_AUTH_TOKEN`
（加上可选的 `ANTHROPIC_BASE_URL`）。两者都没有时启动会明确报错说这件事。

## 界面

三栏，形态参照 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：
左侧会话列表（按项目分组），中间对话流（流式 markdown、工具卡片、权限卡片、压缩标记、
子 Agent），右侧详情栏（工具的完整输入与输出）。

- Enter 发送，Shift+Enter 换行；`/` 唤起命令补全（来自引擎的实时命令表）
- ⌘K / Ctrl+K 新建会话；右键会话行 → 关闭 / 分叉 / 删除
- 左侧按**项目分组**：折叠、每组默认 5 条、拖拽排序、重命名、归档；输入框内过滤标题，回车进内容搜索
- 底部进**设置**：外观、语言（中/英）、引擎设置（模型、单轮 token、权限模式…，可选写进
  全局/场景/项目哪一层）、provider 与凭据、场景、MCP、插件、诊断
- 输入框：`/` 唤起命令，`@` 引用项目文件（走 .gitignore），图片可粘贴/拖放，附件是 64px 缩略图
- 每次请求带给模型的**信封**（装配好的 system 块、完整工具表、调用配置）在流里占一行，
  展开看全文，每块与每个工具都说得出自己来自哪（scene / skills / memory / MCP / plugin）。
  来自引擎的录像（`<atta-dir>/recordings/`），所以刷新、重开、换个进程都还在；删会话时一并删
- 有 turn 在跑时发送会**排队**，上一轮结束自动发出；停止按钮同时清空队列
- 关掉 tab 或刷新不会打断 turn，重开自动追赶上（包括跑到一半的那一轮）

## 结构

```
crates/app      bin `nest`
crates/web      axum：静态面、/ws、/upload、Origin + token + CSP
crates/hub      会话中枢：唯一的引擎连接、事件重放、发送队列、方法白名单
crates/engine   AttaCore 装配
assets/         无构建的 SPA：index.html + styles/*.css + src/**.js（含 i18n 语言包，编译进二进制）
core/           AttaCore（submodule）
```

前端是原生 ES 模块，没有 npm 也没有打包步骤。开发时：

```sh
nest --assets-dir ./assets     # 静态面改从磁盘读：改完刷新即可，不必重编
```

设计与取舍见 [docs/architecture.md](docs/architecture.md) —— 特别是为什么浏览器不直连
引擎（§3）、追赶与重放怎么保证刷新不丢内容（§5）、哪些方法不对浏览器开放（§4.1）。

## 测试

```sh
cargo clippy --workspace
cargo test -p nest -p nest-hub -p nest-engine -p nest-web   # 我们的 Rust 测试
node tests/style-lint.mjs                        # 样式静态检查（图标尺寸、令牌、id）
node tests/reducer-smoke.mjs                     # 前端逻辑，离线，最快
node tests/i18n-smoke.mjs                        # 语言包体检
node tests/ui-smoke.mjs   <port> <token>         # 真引擎 + 真模型
node tests/tool-smoke.mjs <port> <token>         # 真工具调用
```

`<token>` 从 `nest` 启动时打印的 token 文件里读（`<data-dir>/.nest/token`）。

**不要用 `cargo test --workspace`**：它会连带跑被吸收进来的 AttaCore crate，而 Core 有两条
测试假定自己是 workspace 根（从测试二进制往上找 `bridges/` 的副本），在我们这里必然失败。
Core 的测试在 Core 里跑：`cd core && cargo test --workspace`。
