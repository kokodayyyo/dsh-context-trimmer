# 上下文修剪器 · dsh-context-trimmer

在 DeepSeek Harness 里**手动、逐轮地修剪会话上下文**：把某轮中间的几十次工具调用与结果从「模型下一轮读到的内容」里移除，只保留提问和最终回答；也可以整轮移除，或者清掉某一轮的系统注入上下文。

- 只改 **surface**（模型可见的派生消息），**不删日志**——聊天记录仍可完整回看。
- 每次修剪写成一个 **DSH 原生 compaction 事务**（`compaction/start → summary → compact-checkpoint → end`），不是自定义标记。
- 面板的每个按钮都由 **Host 亲自预判**；不可能点的按钮会禁用并在 tooltip 里说明原因。
- 支持 fork / 子会话，也支持「刚被自动压缩过」的会话。

当前版本 `2.1.0`，Host 构建号 `b17-structured-identity`。

---

## 它解决什么问题

长会话里，一轮问答往往夹着几十次 `read` / `grep` / `bash`：文件内容、命令输出、重试记录全都还在上下文里。你只希望模型记得「我问了什么、它答了什么」，不希望它每轮重读那几十次中间过程。

自动压缩（compaction）解决的是「上下文快满了」，而这里解决的是「我想现在就删掉这一段，而且我知道我要删哪一段」。

---

## 安装

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半部分：注册 `/trim_context`，写 surface 压缩事务 |
| `client.js` | Web 半部分：右侧栏面板、输入框按钮、降级面板、命令卡 |
| `cordis.patch.yml` | 启动时把插件插入插件树（`dsh.bundle.patch`） |
| `locale/zh.json`、`locale/en.json` | 插件元数据 |

安装/替换后**必须重启 DSH**（Host 半部分只在进程启动时加载）。面板 bundle 是否需要另行重载，取决于你的加载方式。

### 确认装对了版本

1. `/trim_context {"action":"build"}` → `Host 构建版本：b17-structured-identity`
2. 面板头部徽章 → `全量 · b17-structured-identity`

---

## 使用

### 打开面板

- 右侧栏 ✂️ 标签页「上下文修剪」；
- 或输入框右侧的 ✂️ 按钮；
- 若右侧栏不可用，会自动降级到输入框下方的面板。

### 面板里能看到什么

| 元素 | 含义 |
| --- | --- |
| `第 N 轮` | 按**表面顺序**编号；被移除的轮次保留占位行，后面的编号不会前移 |
| `122 次工具调用` / `原 122 次工具调用 · 现 0 次` | 未修剪显示表面计数；修剪后同时给出「原 / 现」 |
| `系统注入 3 条（持久 1）` | harness 注入的条数；括号里是需要慎重清除的部分 |
| `【已修剪】` / `【注入已清】` / `【已移除】` / `【进行中】` | 该轮状态 |
| `224 个节点` | 该轮在表面上占用的节点数 |
| `不可修剪：…` / `不可清除：…` | Host 明确拒绝时的原因（按钮同时置灰） |

### 三个动作

| 按钮 | 做了什么 | 模型下一轮读到 |
| --- | --- | --- |
| ✂️ **只留问答** | 折叠「本轮第一个含 `tool-call` 的 assistant」到「最后一个工具节点」 | **真实的最终 assistant 回答保留在检查点之后**；检查点只放一句说明。若该轮最后一条 assistant 本身带工具调用（没有纯文本回答），则回答文本被搬进检查点 |
| 🧽 **清注入** | 清掉本轮的一次性注入（`time-context` 等） | `（已清除的系统注入上下文）` |
| 🧽 **清持久注入** | 只在只剩持久注入时可用，二次确认后清除 | 同上 |
| 🗑 **删除本轮** | 整轮（含提问）替换 | `（原第 N 轮问答已由用户手动移除，内容已从上下文中移除）` |

按钮是否可用由 Host 计算（`canTrim` / `canDelete` / `canStrip` / `canStripDurable` + `trimReason` 等），面板只渲染结论，因此不会出现「点了必失败」的按钮。

> 注：修剪**不保留** `reasoning` 块，且预览与折叠都只取 `text` 块——reasoning 既不该进 user 消息，也不该出现在「回复」预览里。

### 命令行等价形式

```
/trim_context {"action":"list"}
/trim_context {"action":"list_json"}
/trim_context {"action":"trim_tools","turn":2}
/trim_context {"action":"delete_turn","turn":2}
/trim_context {"action":"strip_injected","turn":2}                      ← 只清瞬时注入
/trim_context {"action":"strip_injected","turn":2,"includeDurable":true} ← 清持久注入
/trim_context {"action":"repair"}                                       ← 闭合本插件遗留的未闭合事务
/trim_context {"action":"build"}
```

定位一轮：`label`（面板编号）→ `userSeq`（提问的日志序号，最稳）→ `startSeq`。三者**精确匹配**：给了 `userSeq` 却对不上（例如压缩后过期）会直接报「请刷新」，不会退化成猜。

---

## 原理：一次修剪 = 一个压缩事务

```
compaction/start    { compactionId, sourceCommandId, turn: null | N }
compaction/summary  { compactionId, summary: [{type:'text', text:'[context-trimmer v1 mode=… label=…] …'}],
                      shadowedRange: {start, end}, shadowedSeqs: [...],
                      shadowedTokenCount, provider, model,
                      trimmer: { mode, label, userSeq } }
user/message        source: { kind: 'compact-checkpoint', compactionId }
                    surfaceOp: { op:'replace', startSeq, endSeq }
                    sourceEventSeqs: [startSeq, summarySeq, ...被折叠的表面节点]
compaction/end      { compactionId, turn }
```

为什么是这个形状：

1. **`@deepseek-ai/dsh-compaction` 的实时不变量会校验每次 append**：括号不能嵌套、`turn` 必须与打开的 turn 一致、`shadowedSeqs` 必须等于当时表面的那一段、检查点必须落在匹配事务里、失败必须写 `error` 的 end。写错立刻失败，而不是留在日志里等重启时炸。
2. **token 计量与聊天渲染都认它**：`shadowedTokenCount` 让占用统计正确。
3. **身份只认结构化字段**：`summary.trimmer`。摘要正文由模型生成（后续压缩可能复述它，提示注入也能塑造它），所以「能不能折叠 / 能不能 repair」只由 `trimmer` 决定，正文一律不参与安全判断。若将来某个校验器丢掉了这个附加字段，保守结果是本插件自己的检查点被当成外部——那一轮不可修剪，而不是护栏悄悄放宽。
4. **与真实 compaction 互斥**：日志里有未闭合的 `compaction/start` 时本插件拒绝写入；`repair` 只肯闭合「summary 带结构化 `trimmer` 标记」的事务（不要求检查点已写入——检查点写失败正是它要救的状态）。
5. **外部检查点是边界**：本插件不认识的 `compact-checkpoint`（自动压缩留下的）不属于任何一轮，也不会被并进下一轮——所以「刚压缩完的会话」里第一轮仍然可以删除/修剪。
6. **失败也收尾**：`compaction/end`（成功的那条）同样在 try 内；任何一步抛错都会补一条带 `error` 的 end，括号不会悬挂。

坐标系只有一个：**替换事件的 `seq` 在日志尾部、位置却在表面中间**，所以所有范围都按 `session.surface.nodes` 的**下标**计算，只在两端换回 seq；`shadowedSeqs` 就是那段的切片。

### 兼容旧数据

1.x 写下的三种 `context-trimmer-*` 标记仍会被识别（显示【已修剪】/【已移除】/【注入已清】），但插件不再写入它们。

---

## 安全边界：什么时候会拒绝

| 拒绝原因 | 为什么 |
| --- | --- |
| 另一个压缩事务未结束 | 嵌套括号会让日志进入非法状态；可用 `repair` 收尾 |
| 第 N 轮还在进行中 | 后续内容会落在标记之后，等于没修剪 |
| 还有工具调用未返回结果 | 删掉声明会让随后返回的 `tool/result` 变成孤儿，provider 直接 400 |
| 工具调用跨越相邻提问 / 卷进上一个提问 | 折叠会把用户 typed 的另一条提问一起删掉 |
| 外部压缩检查点落在目标轮内部 | 会把别人的整段摘要吃掉（正常情况下它自己就是边界，不会落在轮内） |
| 只剩持久注入却未确认 | 宿主不会自动补发 |
| 参数非法 / 会话不在内存 / 未知 action | 命令层错误 |

工具调用与结果**永远不会被拆开**：跨度会双向扩张直到每一对 `tool-call` ↔ `tool/result` 都落在同一段里。

---

## 注入分两档：瞬时 vs 持久

| 档位 | kinds | 语义 |
| --- | --- | --- |
| **瞬时**（默认清除） | `time-context` | 每轮重发，删掉无副作用 |
| **持久**（需二次确认） | `runtime-context`、`skill-catalog`、`skill-invocation`、`model-selection`、`working-directory`、`user-approval`、`tmux-context` | 宿主**只在其内容/状态变化时**重发；清除后本次会话可能永久失去这段说明 |

**绝不触碰**：`compact-checkpoint`、`user-question-reply`、`goal`、`team-message`、`agent-message`、`agent-instructions`，以及任何未知 kind。

---

## fork / 子会话

- **读**：统计使用整条日志（含 fork 继承的前缀）。只用 `ownEvents()` 会把继承历史的工具调用数读成 0。
- **写**：压缩事务只追加到子会话的日志；父会话不受影响。
- 继承来的轮次同样是当前表面节点，可以正常修剪。

---

## 排查

| 现象 | 处理 |
| --- | --- |
| 头部显示 `本地` / `窗口内` 而不是 `全量 · b17-…` | Host 没返回轮次：确认 Host 半部分已加载，点「刷新」 |
| 警告「命令已发送，但…上下文表面没有变化」 | 看它下面有没有「Host 拒绝了本次操作：…」，那才是真实原因 |
| 「另一个压缩事务尚未结束」 | 本插件或压缩插件留下的未闭合括号。先等真正在跑的压缩结束；若是本插件失败遗留，执行 `{"action":"repair"}` |
| 按钮置灰 | 悬停看 tooltip，或看行下的「不可修剪/不可清除」原因 |
| 面板里某轮删不掉但按钮可点 | 说明 Host 与面板版本不一致：确认 build 号一致后重装 |
| 头部的 build 号不是 `b17-structured-identity` | 对应的半部分还是旧代码：重装并重启 |
| 「右上角的占用圈」没变 | 上下文占用在**下次发送消息后**才重算 |

---

## 开发

```
index.js             Host：命令注册、表面折叠、压缩事务、动作预判
client.js            Web：面板、slot 注册、Host 往返、命令卡
test-synthetic.mjs   合成会话 + surface/compaction 不变量复刻
cordis.patch.yml     插件插入补丁
locale/*.json        元数据
```

### 测试

```bash
npm test                                       # node test-synthetic.mjs
TRIMMER_LOG=<session.v4.jsonl.zstd> npm test    # 额外回放真实会话并执行一次修剪
```

内置的 `FakeSession` 复刻 `dsh-session` 的 surface fold **以及** `dsh-compaction` 的实时不变量（括号、owner、`shadowedSeqs` 必须是当前表面切片、检查点必须落在匹配事务里、失败必须写 error end）。35 个用例覆盖：

- 三个动作的事务形状、字段、配对完整性，以及失败时的 error end；
- **外部压缩检查点是边界**：不被并入下一轮、不被折叠、前一轮仍可操作；压缩后遗留的 retained tail 不被误算进下一轮；
- 修剪后保留真实 assistant 回答、删除/修剪互不阻塞；
- 进行中 / 已结束但工具未返回 / 跨提问扩张 / 未闭合括号 / 持久注入二次确认；
- fork 继承前缀的统计与修剪；
- 面板与 Host 对同一日志（含外部检查点）**逐字段一致**；
- 成功判据（trim / strip / delete）；命令 id 与 provider/model 路由；token meter 路径；`repair`（含检查点没写成的场景）；命令卡只折叠 JSON、保留 `list` 的多行报告；文本冒充标签不会获得所有权；
- `reasoning` 不进入预览或折叠结果。

### 接口契约

| 半部分 | 依赖 | 注册 |
| --- | --- | --- |
| Host | `commands`、`sessions`（`tokenMeter` 可选，经 `ctx.get`） | `commands.register({name:'trim_context', handler})`，返回 `{kind:'success'|'error', text}` |
| Web | `slots`、`remote` | `sidebar.right.pane.tab` / `.title`、`conversation.input.right`、`conversation.composer.dock`、`conversation.chat.commandview`，以及 `ctx.inject(['sidebarRight','sidebarRightTabs'])` |

改这个插件时最容易踩的三个坑：**范围必须用表面下标**、**写入必须是一个完整的压缩事务**、**不属于本轮的表面节点不能借 `pending` 混进下一轮**。

---

## 已知限制

- 只能在**已加载到内存**的会话上操作；闲置被回收的会话会返回「不在内存中」。
- 只把 `source.kind === 'user'` 的 message 当作提问边界。
- 一轮内的 `reasoning` 不保留；没有纯文本回答的轮次会得到一个占位说明。
- 折叠后不会立刻重算上下文占用，需等下一次发送。
- **面板数据通道**：每次刷新/操作仍会通过 `command/done` 的文本携带一次完整行数据（1000 轮约 485KB），因而会写进会话日志。已在聊天区用 `conversation.chat.commandview` 把 **JSON 数据**折叠成一行（`list` 的多行报告仍原样显示），但真正的解法是给面板单独注册一个 remote 端点；这需要改动 Host/Web 两半的传输层，留作下一轮。
- 文件体量：`index.js` ~1500 行、`client.js` ~1780 行。拆分（`surface` / `compaction` / `actions` / `command`、`turns` / `host-turns` / `view`）需要先确认这个 loader 的多模块 bundle 行为，未在真实 GUI 验证前不做。
- 压缩事务要求写入时**没有其他未闭合的压缩事务**；正在自动压缩时请稍后重试或用 `repair`。
