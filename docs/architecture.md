# Nest 架构设计

Nest 是 AttaCore 引擎的 Web 前端：**一个进程**，里面既跑引擎也跑 Web 服务器，对外
提供一个网页应用与一条 WebSocket。它本身不含 agent 引擎逻辑 —— 与
[AttaCode](https://github.com/openatta/AttaCode) 同一条原则：**引擎实现一律在
AttaCore，这里只做装配、传输与界面。**

界面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）
的 Web 应用看齐：三栏（会话列表 / 对话流 / 详情），流式正文、24px 工具行、权限卡、
斜杠命令、附件；设计令牌与几何直接取自它的主题包（§8）。

```
浏览器 (无构建的 SPA：assets/index.html + ES 模块 + CSS)
   │  WebSocket /ws   ── JSON-RPC 2.0，一条 text 消息 = 一帧
   │  HTTP  静态面、/upload      ── 页面与模块、大附件旁路
   ▼
nest（一个二进制，一个进程）
   ├─ crates/web      axum：静态面 + /ws + /upload + Origin/token/CSP
   ├─ crates/hub      会话中枢：唯一的引擎连接、事件重放缓冲、发送队列、扇出、方法白名单
   └─ crates/engine   装配 AttaCore：场景、三层 settings、模型客户端、SessionPool
   │  进程内 dispatch  ── DaemonServer::dispatch_public，不过 socket
   ▼
AttaCore 引擎（core/ 里的 crate，作为库链接进来）
```

没有 socket、没有 token 握手、没有子进程管理、没有端口分配：浏览器面到引擎之间只有
一次函数调用和一个 `FrameSink`。

---

## 1. 结论：可行，但要挑着抄

AttaCore daemon 的 WebSocket 传输是**为浏览器写的**（`core/daemon/src/ws.rs` 的模块
注释原话：存在的理由是让浏览器直接跟 daemon 说话），协议里为多连接观看同一会话准备的
东西已经齐了：会话订阅与连接解耦、`last_seq` 水位、`pending_prompts` 重放、断线只丢
订阅不动 turn、权限提问广播且先答者生效。做一个 DSH 形态的网页应用，缺的不是引擎能力，
是**中间那层状态**。

DSH 的哪些决定可以直接借，哪些不能：

| DSH 的做法 | 我们 | 为什么 |
|---|---|---|
| 一条 `/api` 做 unary + 两条只下行 WS（`events.mux` / `events.host`） | **一条双向 WS 全包** | AttaCore 的协议本来就是双向的：权限回答（`session.respondToPrompt`）是对 daemon 发起的提问的应答，DSH 为此专门开了 `POST /api/respond` 与 `ClientResponse` 象限；我们不需要这个补丁 |
| 整值事件（state-carrying 事件带完整状态，不带增量），消费方 last-wins | **借** | 队列、daemon 健康、会话列表这类推送一律整值快照，前端不做增量合并 |
| Session projection 子系统（宿主折叠事件流成 todo / plan / goal / jobs 的整值） | **不借** | AttaCore 没有等价物，也不该为了一个 UI 在协议层长出一个投影子系统。todo / plan 这类东西从工具结果里在前端派生 |
| Typert：从 Host 的 TypeScript 方法签名生成客户端契约与 schema | **不借** | 那是为 40 多个客户端插件包共享类型准备的。我们只有一页 JS，契约就是 AttaCore 的协议文档 |
| 设计令牌与几何（偏蓝中性色阶、748px 会话列、22px 气泡、胶囊按钮、24px 工具行） | **抄实数** | 见 §8。视觉像不像 DSH，取决于这些数字，不取决于用什么框架 |
| 前端是 vite + React + 运行期插件 bundle（`window.__DSH_BOOT__` 注入 boot manifest） | **不借** | 见 §8：我们要的是原生 ES 模块、无构建 |
| 分层 `remotes → gateway → connection → webserver`，webserver 不认识 harness 概念 | **借** | `crates/web` 不认识会话，`crates/hub` 不认识 HTTP，`crates/engine` 不认识浏览器面协议 |

一句话：**协议照 AttaCore，形态照 DSH，中间层自己写。**

---

## 2. 引擎怎么跑：内嵌，不起子进程

`daemon` 是个 lib（`core/daemon/src/lib.rs`），需要的三个入口都是 public：

```rust
let client = server.accept_connection(sink);            // sink: Arc<dyn FrameSink>
let resp   = server.dispatch_public(req, client).await; // 一次 JSON-RPC
server.drop_connection(client.id()).await;
```

`crates/hub` 就是照这三行写的：实现一个 `FrameSink`（一个 async `send_json`），
让引擎推出来的 `session.event` / `daemon.event` 帧落进中枢的路由函数，浏览器的每条请求
变成一次 `dispatch_public`。**省掉的是**：socket 与端口、`daemon.auth` 握手、Origin
两套判断、子进程健康检查与重启、discovery 文件与实例名冲突。

代价，按实际付出的顺序：

| 代价 | 现状 |
|---|---|
| **装配是复制的** | `crates/engine` 复刻了 `daemon/src/main.rs` 的装配段：场景解析、`load_daemon_config` 三层 settings、多 provider `TaskRouter`、模型客户端、memory store、history store 迁移、`SessionPool::new`、`activate_scene`、插件组件加载、MCP 后台连接、janitor。**这是 Nest 里唯一会随 Core 漂移的文件**；upstream 若长出 `daemon::bootstrap::build(config)`，这个文件就退化成一次调用 |
| **workspace 要镜像** | path 依赖会把 core crate 吸收成本 workspace 的成员，它们的 `xxx = { workspace = true }` 由 Nest 的根 `Cargo.toml` 解析，所以那张第三方依赖表必须跟 Core 的一致。Core 加依赖，这里要同步加 |
| **feature 要按住** | 根 `Cargo.toml` 里 `daemon = { path = "core/daemon", default-features = false }`。默认 feature 会把插件宿主与 wasmtime AOT 编译器链进来，而 cargo 的 feature 统一是"任一成员打开就全打开"——所以 `default-features = false` 写在 workspace 表里，不写在成员上（成员继承 workspace 依赖时关不掉默认 feature） |
| **崩溃不隔离** | 引擎 panic 带走 Web 服务器。可接受：已落盘的 transcript 在，重启即恢复 |
| **不能共用别人的实例** | 放弃了 attach 到 `~/.atta/daemon/instances.d/*.json` 的能力 |

不写 discovery/lock 文件：没有 socket，也就没有可被发现的东西。同机跑第二个 `nest` 由
端口占用挡住（`could not bind …`）。

---

## 3. 为什么中间要有个有状态的中枢

把引擎的 WS 传输直接开给浏览器（Core 的 `ws.rs` 正是为它写的）是最省代码的形态。
否掉它的是三条**代码事实**，不是洁癖：

1. **`session.history` 读磁盘，而磁盘一个 turn 只写一次。**
   `SessionPool::session_history` 的注释写明它读的是 on-disk log，
   `SessionManager::persist` 每个 turn 跑一次 —— **正在跑的 turn 在 history 里看不见。**
2. **重连不补发帧。** 协议 §5.6 明确"仍然没有续接流"，追赶靠历史。
3. **断线只丢订阅，turn 照跑。** `SessionPool::drop_connection` 的实现就是这一件事。

三条合起来：turn 跑到一半刷新页面，浏览器订阅上去只能接到**后半段**，前半段既不在
history 里也不会重放，直到 turn 结束落盘才补齐。刷新是网页最基本的动作，这个洞不能留给
用户。（`tests/` 里有一条测试专门盯这件事，见 §12。）

其余三条是顺带收益：`config.setProvider` 这类能改 `api_key`/`base_url` 的方法有地方拦
（引擎对能到达它 dispatch 的调用方是完全信任的，在这个构建里那就是我们）；`run_turn`
不再挂在某条浏览器连接上，关掉 tab 不会丢最终响应；目录选择、附件上传这些引擎没有的
东西落在同一条连接上，前端不用同时说两种协议。

代价是中枢有状态、大约一千行。**这就是 `crates/hub` 存在的理由**，不是附带复杂度。

---

## 4. 浏览器面协议

帧格式与 AttaCore 一致：JSON-RPC 2.0，**一条 WebSocket text 消息 = 一帧**，UTF-8，
单帧上限 16 MiB。方法名与参数**原样沿用 AttaCore v2**，前端写的就是一个 AttaCore
客户端；Nest 只加一个 `nest.*` 命名空间和几条推送帧。协议文档就是
`core/docs/daemon_rpc_protocol.md`，本仓库不复制一份会过期的副本。

### 4.1 透传白名单

透传是**白名单**，不是黑名单 —— daemon 对连上来的人是完全信任的，我们这一层是它唯一的
授权点。

| 放行 | 方法 |
|---|---|
| 会话 | `session.create`※ `list` `get` `history` `fork` `resume` `respondToPrompt`，以及被拦下加工的 `interrupt` / `close` / `delete` |
| 场景 | `scene.list` `describe` `activate` |
| 目录 | `commands.list` `mcp.status` `plugin.list` `daemon.status` `daemon.ping` `daemon.doctor` |

※ `session.create` 是透传的，但响应会被看一眼：它是**最后一处**能知道这个会话的
`project_root` 的地方（见 §11），中枢把它记下来。

不放行，且不是"未实现"而是**明确拒绝**（错误信息里写原因，浏览器能显示）：
`config.setProvider` / `config.set*`（改 provider 凭据与 base_url = 把模型流量指到别处）、
`plugin.install` / `uninstall` / `enable` / `disable`、`mcp.addServer`（等价于装一个能跑
子进程的工具）、`import.run` / `import.list`、`daemon.shutdown`。

`session.run_turn` 与 `session.subscribe` / `unsubscribe` / `daemon.subscribeEvents`
也拒绝 —— 它们由中枢代持，见 §5、§6。

### 4.2 `nest.*`

| 方法 | 作用 |
|---|---|
| `nest.hello` | 引导：协议版本、引擎状态与模型名、场景表（含 `requires_project`/`supports_team` 能力位）、命令表、能力位（单帧上限、上传上限、重放缓冲容量）、cwd |
| `nest.sessions` | 会话列表，补上 `session.list` 不带的 `scene` / `project_root` / `running`，以及 Nest 自己的 `workspace_id` / `archived` / 用户改过的标题（见 §11），另附工作区表与视图偏好 |
| `nest.workspaces.list / create / update / reorder / remove` | 工作区（= 项目分组）。引擎没有这个概念，全部落在 Nest 的状态目录里 |
| `nest.sessions.rename {session_id, title}` | 会话标题覆盖层 —— 引擎没有 `session.rename` |
| `nest.sessions.archive {session_id, archived}` | 只影响侧栏是否显示，不动会话与历史 |
| `nest.prefs.set {key, value}` | 视图偏好（分组方式、排序、展开态），跨 tab 一致 |
| `nest.search {query, limit?}` | 跨会话内容搜索：进程内线性扫 transcript，双重上限（扫 150 个会话、回 30 条命中） |
| `nest.requestHeaders {session_id}` | 这次运行的请求信封时间线：读 `<atta-dir>/recordings/<session_id>/`，只看 turn 调用（compact / memory / title 各有各的信封，混进来只会一直"变了"），按 blob id 折成变化点。没录像回 `recording:false` 而不是报错 —— 还没说过话的会话本来就没有 |
| `nest.attach {session_id}` | 打开会话：订阅（必要时先 resume）+ 追赶快照。替代 `session.subscribe`，见 §5 |
| `nest.detach {session_id}` | 关闭观看，不动会话 |
| `nest.send {session_id, message, attachments?, on_busy}` | 发送。`on_busy: "queue"｜"reject"`；`queue` 时返回 `{queued:true,item}`。**发送即观看**：没 attach 过的浏览器也会被登记，否则它既收不到事件也收不到结束通知 |
| `nest.queue.remove {session_id, item_id}` | 撤销未发出的排队项 |
| `nest.listDirectory {path?}` | 目录选择器一层：`{path, home, entries:[{name,hidden}], breadcrumbs}`。只列目录，锚在 `$HOME`，越界拒绝 |
| `nest.recentProjects` | 从 `session.list` 汇总出用过的项目根 + cwd，新建会话时选 `project_root` 用 |
| `nest.upload.begin {name, bytes}` | 换一个一次性 `/upload?token=` URL；落盘到进程运行目录，回一个绝对路径给 `attachments:[{kind:"file",path}]` 用 |

### 4.3 推送帧（server → client 通知）

| 方法 | 载荷 |
|---|---|
| `nest.event` | `{session_id, seq, turn_id, event}` —— 包住引擎的 `session.event`，`seq` 由中枢分配，是重放的锚。另有一个合成 kind：`user_message`（引擎不为用户消息发事件，而每个 tab 都得看见它） |
| `nest.turn_settled` | `{session_id, turn_id, result?, error?}` —— `run_turn` 的最终响应，广播给该会话所有观看者 |
| `nest.queue` | `{session_id, items:[…]}` —— **整值**快照 |
| `nest.daemon_event` | 透传 `daemon.event`（会话被驱逐、配置重载、MCP 断连、场景降级） |

### 4.4 并发

在进程内不需要 id 映射：`dispatch_public` 是调用即返回，响应不走帧通道，浏览器的 `id`
原样回给它。要按住的只有并发数 —— 引擎单连接在途上限 64 且**超限是拒绝不是排队**，而
所有浏览器共用中枢这一条连接，所以每个浏览器连接在 `crates/web` 里配 16 个信号量许可，
每条请求一个 task（长请求不能挡住读循环）。

---

## 5. 追赶与重放：这一层的核心不变量

> **中枢永远比浏览器先订阅。**

会话第一次被打开时中枢立刻 `session.subscribe` 并开始缓冲，此后浏览器的追赶**只在中枢
的缓冲区里进行**，不依赖引擎的水位。这条不变量把 §3 的三个事实一次性抵消掉。

`nest.attach` 做三件事，顺序不能换：

```
1. session.get         —— 读 transcript，冷会话也答得出，并给出 resume 需要的 scene
2. session.subscribe   —— 若返回 SESSION_NOT_FOUND：先 session.resume 再订阅（见下）
3. 在同一把锁里：拍 replay 快照 + 把这个浏览器登记为 watcher
```

应答与前端的追赶顺序：

```
  → { session,                        // session.get 的结果（scene / turn_state / …）
      history_total,                  // session.history {limit:0} 的 total，一次廉价探底
      replay: [{seq, turn_id, event}],// 缓冲区里的活帧（可能为空）
      pending_prompts: [ … ],         // 未答的权限提问，prompt_id 原值
      truncated, running_turn, queue, seq }

1. session.history {offset, limit}  分页读到 history_total（渲染顶部往下）
2. 接上 replay 里的帧
3. 转入实时（seq ≤ 已见即丢弃）
```

**冷会话必须先 resume。** `SessionPool::subscribe_session` 只认内存里的会话，磁盘上的
会话订阅会拿到 `SESSION_NOT_FOUND` —— 而"打开一段历史对话"是最基本的动作。所以
`nest.attach` 在这一步失败时用 `session.get` 拿到的 `scene`（加上中枢记得的
`project_root`，见 §11）先 `session.resume` 再重试订阅。代价是打开历史会话会建起运行体，
和 DSH 一样（它的 README 也把这条记作已知限制：*history resumes an unattached session*）。

**为什么不用协议 §5.6 写的那套（`session.subscribe` 拿 `last_seq` → `session.history
{before_seq: last_seq}`）**：`session.history` 的实参是 `offset`/`limit` 且分页单位是
**投影后的消息**，而 `last_seq` 是 **transcript 条目数**，两个坐标系不同（一次压缩会让
消息数掉下去而条目数继续涨），`before_seq` 这个参数在代码里也不存在。以 `total` 为界、
以中枢缓冲为接缝，两个坐标系不需要对齐。

**缓冲区**：每会话一个环，`(seq, turn_id, event)`。写入前把连续 `text_delta` 合并进上一
帧，单帧到 4 KiB 为止（一个 turn 几百上千个 delta 帧，合并后是几十个）。上限 8 MiB /
20 000 帧，超限丢最旧并置 `truncated`。

**什么时候丢缓冲**：turn 开始时清上一轮，turn 结束时**先看 transcript 是否已经涨了**
（`session.history {limit:0}` 的 `total` 与开跑前比），涨了才清 —— 否则一个已结束但还没
落盘的 turn 会两头都不在。同理，`nest.attach` 只在"turn 在跑"或"transcript 还没涨"时给
replay，避免同一段内容既在 history 里又在 replay 里被渲染两遍。

`truncated` 的前端降级：横幅提示"本轮前段无法回放"，turn 结束后由 history 补齐。

---

## 6. turn 的所有权与发送队列

**`run_turn` 由中枢发起，不由浏览器连接发起。** 直接后果：

- 关掉/刷新 tab 不影响 turn，也不丢最终响应 —— 响应回到中枢，中枢广播
  `nest.turn_settled`。浏览器直连时这条响应会随连接一起消失，前端只能靠
  `turn_complete` 事件猜。
- 一个会话同时刻只能有一个 turn（第二个 `run_turn` 立刻 `SESSION_BUSY`，不排队不抢占）。
  这条约束不该原样漏给用户：**排队在中枢**。有 turn 在跑时 `nest.send` 进队列，上一个
  turn 结束后 FIFO 自动发出；队列可撤销，整值快照推给所有 tab。这是 DSH `session/queue`
  语义的最小版。
- `turn_id` 由中枢生成，前端不需要造。
- 一个 turn 的生命周期跑在一个 task 的**循环**里（结束 → 有排队项就接着开下一个），
  不是递归调用：`start_turn → settle → start_turn` 那种写法在 Rust 里连 `Send` 都推不出来。
- `session.interrupt` 被拦下加工：中断是对整个会话的决定，所以顺手清空队列并广播新快照 ——
  否则用户按了停止，下一条排队消息立刻又开始跑。

斜杠命令**不需要额外接口**：`/compact`、`/help`、`/skills`、`/mcp__server__prompt` 由
引擎在 turn 循环里拦截（`core/crates/runtime/src/turn.rs`），把 `/xxx` 原样放进
`nest.send` 的 `message` 即可。补全弹窗的候选来自 `commands.list`（skill + 内置 + 插件 +
MCP prompt），加上纯前端的本地命令。

---

## 7. 权限提问

直通，不加工：

- `session.event{kind:"prompt"}` 广播给该会话所有观看者，任一 tab 都能答，**先答者生效**，
  第二个回答是静默成功。
- 中途打开的 tab 从 `nest.attach` 的 `pending_prompts` 拿到悬着的提问，`prompt_id` 是原值。
- 默认 300 秒不答按拒绝处理，turn 带一条 error `tool_result` 继续。**UI 必须显示倒计时** ——
  否则用户会认为会话卡住了，而实际上是在走向一次静默拒绝。
- 四种回答形态：`permit` / `deny{reason}` / `permit_always{scope:"session"}` /
  `permit_always{scope:"local"}`（后者会写 `settings.local.json`，UI 要说清这一点）。

---

## 8. 前端：无构建的 SPA

一组原生 ES 模块 + 一组 CSS，`include_dir!` 整目录编译进二进制。**没有 npm、没有打包
步骤、没有 CDN**：浏览器加载的就是仓库里的源文件，改一行 CSS 刷新即见（`--assets-dir`
指到 `assets/` 时连重编都省了）。

这是与 DSH 借与不借的分界：**借它的视觉与信息结构，不借它的工程规模**。DSH 是 vite +
React + 40 多个客户端插件包 + 运行期 bundle 加载 + Typert 生成的客户端契约；那套东西是
为"任何人都能装一个插件改 UI"准备的，我们没有这个需求。

```
assets/
├── index.html            静态骨架：三栏容器 + 一个 <meta name="nest-token">
├── styles/
│   ├── tokens.css        设计令牌（见下）
│   ├── base.css          reset、排版、滚动条、按钮/胶囊等共享控件
│   ├── layout.css        AppFrame 三栏栅格、rail、会话头
│   ├── sidebar.css       会话列表
│   ├── conversation.css  气泡、助手正文、24px 行、权限卡、markdown
│   ├── composer.css      悬浮输入卡、队列、附件、命令菜单
│   └── panels.css        详情栏、模态框
└── src/
    ├── main.js           引导与全局快捷键
    ├── rpc.js            WS 传输：id 关联、通知分发、退避重连
    ├── state.js          store：一个对象 + 合并到微任务的变更广播
    ├── session.js        会话动作 + reducer（history/事件 → flow blocks）
    ├── markdown.js       小型 markdown
    ├── theme.js          明暗主题
    ├── i18n/             语言包：index.js（t/setLocale）+ zh-CN.js + en.js
    ├── dom.js / icons.js  DOM 助手、内联图标
    └── views/            sidebar / conversation / composer / details / modals / settings
```

**界面上没有任何硬编码文案。** 视图只写 key，`t(key, vars)` 从当前语言包取值：
`assets/src/i18n/zh-CN.js` 与 `en.js`（220 个 key，两边一一对应，`tests/i18n-smoke.mjs`
盯着这个对应关系）。缺 key 时先回落到英文包，再回落到 key 本身 —— 屏幕上出现
`sidebar.search` 是一份 bug 报告，空字符串则是一个谜。语言选择是浏览器本地的（跟随系统
/中文/English），切换即重绘：视图本来就从 store 渲染，换语言只是让它们再渲染一次。

**几何也抄实数**：侧栏 6/12 内边距、38px 描边式新建按钮（r12，不是品牌实心胶囊 —— 强调色
留给发送键）、28px 圆形图标控件（rail 内 36px）、34px 项目行（hover 时文件夹图标换成折叠
箭头）、32px 会话行（时间在 hover 时让位给操作）、22px 缩进步长、折叠三段动画
（原地淡出 150ms → 落到 rail → 控件带 49px 位移淡入 150ms，列宽 300ms）、指针离开 2s 后
安静下来的滚动条。

**设计令牌抄的是 DSH 的实数**（`packages/client/ui-theme/src/styles/design-platform.css`
的静态刻度与语义别名）：偏蓝的中性色阶、`bg-bubble` = deepseek-50 / neutral-850、边框
`rgba(0,0,0,.04/.1/.12)`、主按钮在浅色下是近黑、深色下是近白。几何也照抄：会话列 748px、
块间距 16px、用户气泡 22px 圆角 / 10-16 内距 / 16-24 字号并上限 525px、助手正文 16/28、
胶囊按钮 h36-r18（紧凑 h28-r14）、输入卡 22px 圆角悬浮在中轴上。

**一个工具调用是一行，不是一张卡片。** DSH 的工具行是 24px 单行
`[16 图标] gap6 [标题 14/24] gap8 [分隔点] gap8 [摘要 truncate]`，运行中不是转圈而是一道
**扫光**从行上掠过。我们照做，并让"注入上下文""上下文已压缩"复用同一种行 —— 它们都是
"发生了一件事，需要时再展开看"。

**明确不做**：语法高亮（shiki 的全量语法表）、KaTeX、增量 markdown 渲染器、虚拟滚动
（用只取尾部若干页 + 长块折叠替代）、CSS Modules/构建期作用域（选择器靠命名约定）。
引入其中任何一个都意味着引入构建步骤，那应该是一次显式决策。

**状态模型**：`state.js` 是唯一的可变状态，`session.js` 是纯 reducer
（`(blocks, event) → blocks`），与 AttaCode `crates/bridge/src/reducer.rs` 同构。每个 block
带一个 `key` 和一个 `rev`：视图只重渲染 `rev` 变过的 block，所以一轮里几百个
`text_delta` 只动一个节点。两条硬规则：

- **工具块按 `tool_use_id` 配对，绝不按数组下标。** 并发安全的工具并行执行，
  `tool_result` 按**完成**顺序发出，而 `session.history` 里又被还原成**提交**顺序 ——
  按下标配对的客户端在事件流里必错。
- 子 Agent 事件裹在 `subagent_progress` 里、与父事件在同一条流上交错，按 `agent_id` 归属，
  聚成一个虚线块而不是散进主流。
- **请求信封是拉来的，不是推来的。** 协议里没有这一帧：Core 把每次调用完整写进**录像**
  （`core/docs/recorder_design.md`），`nest.requestHeaders` 折成"变化点"，前端在两个它可能
  动过的时刻去取 —— 打开会话、一轮结束。落成一行"请求信封"并记进 `state.request`，它对
  **此后每一次调用**都成立，直到下一份。变化分类（初始／系统提示词变／工具表变／调用配置
  变）仍是前端对比出来的，与 DSH 的 `RequestPromptChange` 同构。
  读文件而不是收帧，换来的正是刷新之后还在：**上一个进程跑的那些轮，信封照样读得到** ——
  这是 `session.history` 给不了的（信封不是消息）。边界在"本次运行"：resume 后的第一次调用
  会重开一份录像，所以 §9 那一行按**位置**比对已渲染的信封而不是数个数。

**布局**：三栏（DSH 的 AppFrame）。sidebar 折叠后保留 **56px 控制栏**而不是消失，details
关到零宽；窗口变窄时先让 details 让位。sidebar（会话按项目分组，`daemon.event` 驱动"某个
会话在跑"的指示）/ conversation（流式正文、工具行、压缩行、权限卡、悬浮输入卡 + 队列）/
details（一次工具调用的完整输入与输出）。sidebar 靠 `daemon.event` 就够，不必为了看一个
会话去接收全部会话的流量 —— 这是协议把 `daemon.event` 与会话订阅分成两层的用意。

**附件**：`session.run_turn` 收 base64 图片，但单帧 16 MiB 是硬上限，图片走 WS 会顶到它。
所以走旁路：`nest.upload.begin` → `POST /upload` → 落盘 → 在 `nest.send` 里以
`{kind:"file", path}` 引用（daemon 与我们同机，路径就是最省的传法）。

---

## 9. 仓库结构与构建

```
Nest/
├── core/                  AttaCore（与 AttaCode 同一份；当前是指向 ../Core 的符号链接，
│                          进 git 时换成 submodule —— 见下）
├── crates/
│   ├── app/               bin `nest`：CLI、装配顺序、优雅关闭
│   ├── web/               axum：静态面、/ws、/upload、Origin + token + CSP
│   ├── hub/               会话中枢，按关注点分文件：lib（分发/重放/attach）、
│   │                      turns（发送/turn 循环/队列）、workspaces（分组/标题/搜索）、
│   │                      files（目录/项目/上传）、store（Nest 自己的状态）
│   └── engine/            AttaCore 装配（复刻自 daemon/src/main.rs，§2）
├── assets/                前端（见 §8；include_dir! 进二进制）
├── tests/                 前端的无浏览器测试（§12）
├── 3rds/                  第三方参考代码（DSH 源码，gitignore）
├── docs/architecture.md   本文
└── Cargo.toml             workspace: app + web + hub + engine + 镜像 Core 的依赖表
```

边界，任一层可单独替换/测试：

| crate | 不许依赖 |
|---|---|
| `web` | 会话概念（它只搬帧、认 token、算 CSP） |
| `hub` | axum / http 类型 |
| `engine` | 浏览器面协议（它只造引擎） |

依赖 Core 的方式与 AttaCode 一致：**path 依赖 `core/` 里的 crate**，它们被 cargo 吸收成
本 workspace 的成员，所以根 `Cargo.toml` 的 `[workspace.dependencies]` 镜像了 Core 的那张
第三方依赖表（Core 加一个依赖，这里同步加一个）。`daemon` 那条额外写
`default-features = false`，理由见 §2。

```sh
# core/ 当前是符号链接，直接构建即可
cargo build --release          # → target/release/nest（单个二进制，前端在里面）
cargo clippy --workspace       # 会连带检查被吸收的 core crate
./target/release/nest --port 4080 --scene coding --scenes chat,research
```

**进 git 之前把 `core/` 换成 submodule**（`git submodule add -b main
https://github.com/openatta/AttaCore.git core`）。符号链接指向工作副本、跟着它的未提交
改动一起变，方便开发但不可复现。submodule 不钉版本、跟 `origin/main`，bump 单独提交：
`Nest: bump AttaCore to <sha>`。提交前缀 `Nest:`。AttaCore 本身不在本仓库改，要改就进
`core/` 切分支提 PR。

---

## 10. 安全姿态

- 只绑回环，`--host` 传非回环地址直接启动失败。**回环是两个地址**：`127.0.0.1` 与
  `[::1]` 都监听 —— 浏览器把 `localhost` 先解析成 `::1`，只绑 v4 的服务能回应 `curl`
  却打不开页面（v6 那次绑定失败只警告，不影响启动）。非回环需要一层真正的认证，那不在 v1
  范围内 —— DSH 同样把 `--host 0.0.0.0` 定为"在认证层落地前不支持"。
- `/ws` 升级照 Core `ws.rs` 的判断做 Origin 校验：缺失放行（非浏览器客户端）、
  `localhost`/`127.0.0.1`/`[::1]` 任意端口放行、其它 403。端口不校验（前端跑在哪个端口是
  部署细节）。
- 一个进程随机 token，注入首页、`/ws?token=` 校验 —— 挡同机其它页面：绑定回环挡不住
  网页，WebSocket 不受同源策略约束。首页本身不要 token（跨源读不到响应体），token 只
  管连接。
- CSP 不留外部源，也不留内联：`default-src 'none'; script-src 'self'; style-src 'self';
  connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`。页面里没有任何内联 script/style，所以既不需要
  `'unsafe-inline'` 也不需要维护一串哈希 —— token 走 `<meta>`，不走脚本。
- 静态面只认 `assets/` 下的相对路径，含 `..` 的请求直接回落到 `index.html`。
- **两个可配置目录**（`crates/app/src/paths.rs`），因为用户真正会搬的就这两个：
  `--atta-dir` 是**引擎目录**（配置、transcript、记忆、技能；默认 `$ATTA_CONFIG_HOME`
  再默认 `~/.atta`，与 attacored / AttaCode 共用），`--data-dir` 是**项目目录**
  （选择器从这里开始、新建项目建在这里；默认 `$NEST_DATA_DIR` 再默认 `~/Documents`）。
  安装物只有这个二进制 —— 网页应用编译在内，运行时不从安装目录读任何东西
  （`--assets-dir` 是开发时的唯一例外）。
- Nest 自己的账本（工作区、标题、偏好、token、上传）**也是数据**，只是程序自己的：它在
  `<data-dir>/.nest`，跟着项目目录一起搬（`NEST_STATE_DIR` 可单独移，但不给 flag ——
  没人会特意去选它）。
- 引擎的根**显式传进去**（`StaticDaemonPaths`），不改本进程的环境变量：那样一个进程就
  不可能服务两个根，状态也会藏在调用者看不见的地方。
- 目录选择器开在项目目录上，围栏是 `$HOME` **或**项目目录 —— 运维显式指定的根即使在
  home 之外也可信（项目放在另一块盘是常态）；其它一律拒绝。
- 方法白名单（§4.1）是这个进程里唯一的授权点，加方法时默认拒绝。
- **录像的敏感级别等同 transcript，因为它就是同一批内容加上系统提示词**：Core 明写
  录像不过脱敏（那样会废掉它的价值）。Nest 默认开录像（`session.create` / `resume` 带
  `options.recorder`，信封那一行就靠它），落在 `<atta-dir>/recordings/<session_id>/`，
  与 transcript 同一个引擎目录、同一套权限。Core 不做保留策略并明说清理归上层，所以
  **`session.delete` 连带删掉录像目录**；`session.close` 不删 —— 会话还能重开，信封也
  该还在。

---

## 11. 能力对照：缺什么，谁来补

DSH Web 的方法面（`packages/host/apiproxy`）对着 AttaCore 协议看：

| DSH | AttaCore | Nest |
|---|---|---|
| `session.prompt` / `cancel` / `list` / `fork` / `create` | `run_turn` / `interrupt` / `list` / `fork` / `create` | 直通（`run_turn` 由 hub 代持） |
| 会话列表带 workspace 与标题 | `session.list` 的 `SessionInfo` **不带 `scene`、不带 `project_root`**，且 `scene`/`project_root`/`status`/`limit`/`cursor` 这些入参 dispatch 根本没读 | `nest.sessions`：中枢在 `session.create` 的响应和 `nest.attach` 的 `session.get` 里记下这两项再合回列表。没打开过的会话分到"未打开过"组，不猜 |
| `session.history`（游标分页 + projections） | `history`（offset/limit，投影后消息） | 直通；进行中的 turn 靠重放缓冲补 |
| 注入上下文与用户消息分开记 | 记忆召回等注入内容以 **user 角色**落进 transcript（`<system-reminder>…`） | 前端按前缀识别，渲染成可展开的"注入上下文"卡片，不是第二个用户气泡 |
| 权限提问 | `prompt` 帧 + `respondToPrompt` + `pending_prompts` | 直通 |
| `command.list` / `skill.list` | `commands.list` | 直通；调用即普通 `run_turn` |
| `session.rename` | **无** | 缺口 → 给 Core 提 `session.rename`。（`create` 能给 `name`，`run_turn` 会回自动生成的 `name`） |
| `session.models` / `selectModel` | **无**（模型来自 settings 三层与场景） | 缺口 → 给 Core 提 `session.setModel`；此前只能改配置层 + 重建会话 |
| `session/queue` + `updateQueue` | **无**（`SESSION_BUSY`） | Nest 侧实现（§6） |
| `host.listDirectory` / `pickDirectory` | **无** | `nest.listDirectory` / `nest.recentProjects` |
| `session.export`（ZIP） | **无** | `nest.export`：直接打包 transcript 目录 |
| `session.search` | **无** | v2：扫 transcript |
| projections（todo / plan / goal / jobs） | **无** | 前端从工具结果派生，不进协议 |
| Trajectory 的 Input（每次请求模型看到的输入） | 协议里**无**；Core 把每次调用写进录像（recorder），含每个 system 块与每个工具的来源标注 | hub 开录像（`session.create` / `resume` 带 `options.recorder`），`nest.requestHeaders` 折成变化点；流里一行"请求信封"+ 详情栏全文（§9）。消息侧不重复传：前端本来就有 |
| 子 Agent / 团队面板 | `subagent_progress` 事件 + `session.list{parent_session_id}` + 侧链 history（`agent.*`/`team.*` 未实现，调用返回 `METHOD_NOT_FOUND`） | 详情栏用事件 + 侧链会话；不等 RPC |
| 附件 | `run_turn` 收 base64 / 文件路径 | 旁路上传 + 路径引用（§8） |

**在 `config.reload` 上发现的一处**：`SessionPool::settings_for_project` 按
`(project_root, scene)` 记忆化，而 `apply_reloaded_settings` 只换掉进程自己那一对 ——
其它对的 `config.get {tier:"effective"}` 会一直返回 reload 之前的值。所以 Nest 的设置页
自己按三层文件算生效值，并把引擎的答案作为 `engine` 一并回传，两者不一致时如实说明
"引擎里还是旧值，新建会话时生效"。修法很短：reload 时清掉那个缓存。

值得给 AttaCore 提的（按价值排）：
1. `SessionInfo` 补 `scene` + `project_root`（现在每个宿主都得自己记一份，见上）
2. `daemon::bootstrap::build(config)` —— 把 `main.rs` 的装配抽出来，`crates/engine` 就不用
   复制它（§2 唯一的漂移源）
3. `session.rename`
4. `session.setModel` + `session.models`
5. `session.subscribe` 对冷会话自动 resume（现在每个客户端都要自己实现 §5 那段回退）
6. `session.history` 的 `before_seq`，与协议 §5.6 的写法对齐
7. `daemon.status` 落地 `protocol_version` + `features[]`

---

## 12. 测试

前端是一页无构建的 JS，它的失败方式（错的元素 id、热路径上的笔误、reducer 漏一种事件
kind、一个从来没被换进 DOM 的节点）在 Rust 测试里看不见，而人是最后才发现的。
`tests/` 里有一个够用的假 DOM（`dom.mjs`）把**真页面的模块**跑起来 —— 装好
`document`/`location`/`WebSocket` 等全局，然后 `import('assets/src/main.js')`，跑的就是
浏览器加载的同一份代码：

| 测试 | 跑什么 | 需要引擎 |
|---|---|---|
| `tests/reducer-smoke.mjs` | 假 socket，脚本化地喂事件：流式 markdown、权限卡片（含倒计时与回答上线的 `decision`）、乱序 `tool_result` 按 id 配对、失败工具行的展开、详情栏、子 Agent、压缩行、队列、用量、驱逐横幅、命令补全、history 渲染（含注入上下文与跨消息的 `tool_result`）、请求信封（三份信封的变化分类、按来源标注的 system 块与工具、重读同一份录像不重复出行、重录之后出新行） | 否，离线且免费 |
| `tests/style-lint.mjs` | 样式的静态不变量：每个 `icon()` 至少有一个带宽度的类（不然 SVG 会撑满行 —— 真出过）、无 `text-transform: uppercase`（对中文只会把字撑散）、feature 样式只用令牌不写死颜色、代码里 `$("x")` 的 id 确实存在 | 否 |
| `tests/i18n-smoke.mjs` | 语言包：两包 key 一一对应、占位符一致、无空值；以 en 加载时界面确实是英文；切两次语言不泄漏订阅 | 否，离线且免费 |
| `tests/ui-smoke.mjs` | 真引擎、真模型：连接 → 建会话 → 发送 → 看回答流进来 → 请求信封那一行与它的详情 → 从侧栏重开走 history 路径，信封仍在（transcript 里没有它，只能来自录像） | 是 |
| `tests/tool-smoke.mjs` | 真引擎的 `coding` 场景：真工具调用、工具卡片状态流转、展开、详情栏 | 是 |

测试断言不写字面文案，从同一份 `zh-CN.js` 里取 —— 改文案不会假失败，删 key 会真失败。

```sh
node tests/style-lint.mjs                       # 静态检查，秒回
node tests/reducer-smoke.mjs                    # 先跑这个，它最快也最全
node tests/i18n-smoke.mjs                       # 语言包体检
node tests/ui-smoke.mjs   <port> "$(cat $TMPDIR/nest-<pid>/token)"
node tests/tool-smoke.mjs <port> <token> [project_root]
```

前端开发时用 `nest --assets-dir ./assets`：静态面改从磁盘读，改完刷新即可，不必重编。

Rust 侧用 `cargo test -p nest -p nest-hub -p nest-engine -p nest-web`，**不要 `--workspace`**：
被吸收进来的 AttaCore crate 里有两条测试假定 Core 自己是 workspace 根（从测试二进制往上
找 `bridges/` 的副本），在我们的根下必然失败。Core 的测试在 `core/` 里跑。

假 DOM 不渲染也不排版 —— **它不替代在真浏览器里打开一次**。它替代的是"改完不知道有没有
坏"。（`updateBlock` 那个把新节点替换成自己、导致流式文本永不刷新的 bug 就是它抓出来的。）

---

## 13. 写客户端时以代码为准的三处

`core/docs/daemon_rpc_protocol.md` 与实现有三处不一致，都落在客户端会踩的地方：

| 文档 | 代码 |
|---|---|
| §5.6 / §6.3：`session.history {before_seq}` / `{cursor}` | 实参是 `{offset, limit}`，返回 `{total, has_more, entry_count, active}`（`server.rs::method_session_history`） |
| §6.3 `run_turn`："客户端在 turn 中途断开：daemon 立即取消该会话的 turn" | 断线只丢订阅（`session_pool.rs::drop_connection`）。§5.6 的描述才是现行行为 |
| §5.7：`daemon.status` 返回 `protocol_version` + `features[]` | 实际返回 `{version, uptime_secs, sessions}`；`protocol_version` 在 `daemon.ping` 里 |

前两条影响 §5 的追赶设计，第三条影响能力探测 —— 探测走 `daemon.ping`，别等 `features[]`。
（`session.list` 的入参与字段也不符，已单列在 §11。）

---

## 14. 现状与下一步

**已经能用的**：单进程启动、会话列表与新建（场景 + 权限模式 + 项目选择/浏览）、流式对话
与 markdown、工具卡片与详情栏、权限卡片（四种回答 + 倒计时）、斜杠命令补全、附件上传、
发送队列、中断、fork、关闭、删除、冷会话打开、刷新与多 tab 追赶、注入上下文折叠、
驱逐/MCP/降级横幅。

**已经能用的（续）**：工作区分组的侧栏（折叠、5 条分页、拖拽排序、重命名、归档、标题过滤 +
回车进内容搜索）、设置面板（外观、语言、引擎设置按层写入、provider 与凭据、场景、MCP、
插件、诊断、关于）、中英语言包、`@` 文件提及与图片粘贴/拖放/缩略图轨、**无环境变量的
首次运行**（配好 provider 即可跑）。

**没做的，按该做的顺序**：

1. 模型/权限的**运行中**切换（引擎无接口，见 §11）
2. 导出 ZIP、子 Agent 侧链视图、diff 视图
3. 子 Agent 侧链的独立视图（现在只有事件流汇总）
4. diff 视图（`Edit`/`Write` 的结果目前是纯文本）
5. 虚拟滚动 —— 超长会话现在靠 history 只取尾部若干页顶着
6. 真浏览器里的自动化（Playwright），补上假 DOM 覆盖不到的渲染与布局

**已知的粗糙处**：会话没有标题时侧栏显示"未命名会话"（Core 自动命名要跑过几轮才有）；
`turn_state` 事件在实测中没出现过，运行态由 `nest.send` 与 `nest.turn_settled` 推动；
一次观察到模型请求长时间无响应（上游 SSE 卡住），UI 上表现为一直"运行中"，用停止按钮
可以脱出。
