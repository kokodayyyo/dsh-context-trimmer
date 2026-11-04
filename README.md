# 上下文修剪器 · dsh-context-trimmer

在 DeepSeek Harness 里**手动、逐轮地修剪会话上下文**：把某轮中间的几十次工具调用与结果从「模型下一轮读到的内容」里移除，只保留提问和最终回答；也可以整轮移除，或者只清掉某一轮的系统注入上下文。

- 只改 **surface**（模型可见的派生消息），**不删日志**——聊天记录仍可完整回看。
- 右侧栏面板 + `/trim_context` 命令双入口。
- 支持 fork / 子会话：继承来的历史照样能修剪，改动只写进子会话自己的日志。

当前版本 `1.3.0`，Host 构建号 `b13-fork-history`。

---

## 它解决什么问题

长会话里，一轮问答往往夹着几十次 `read` / `grep` / `bash`：文件内容、命令输出、重试记录全都还在上下文里。你只希望模型记得「我问了什么、它答了什么」，不希望它每轮重读那几十次中间过程。

自动压缩（compaction）解决的是「上下文快满了」，而这里解决的是「我想现在就删掉这一段，而且我知道我要删哪一段」。

---

## 安装

包以 DSH 插件形式提供：

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半部分：注册 `/trim_context` 命令，读写会话 surface |
| `client.js` | Web 半部分：右侧栏面板、输入框按钮、降级面板 |
| `cordis.patch.yml` | 启动时把插件插入插件树（`dsh.bundle.patch`） |
| `locale/zh.json`、`locale/en.json` | 插件元数据 |

安装/替换后**必须重启 DSH**（Host 半部分只在进程启动时加载）。面板 bundle 是否需要另行重载，取决于你的加载方式。

### 确认装对了版本

两个信号都直接可见，不用猜：

1. `/trim_context {"action":"build"}` → 返回 `Host 构建版本：b13-fork-history`
2. 面板头部徽章 → `全量 · b13-fork-history`

只要其中一个显示旧号，就说明对应的半部分还是旧代码。

---

## 使用

### 打开面板

- 右侧栏 ✂️ 标签页「上下文修剪」；
- 或输入框右侧的 ✂️ 按钮；
- 若右侧栏不可用，会自动降级到输入框下方的面板（顶部有「重试右侧栏」）。

### 面板里能看到什么

每一轮一张卡片：

| 元素 | 含义 |
| --- | --- |
| `第 N 轮` | 按**表面顺序**编号；被移除的轮次保留占位行，因此后面的编号不会前移 |
| `122 次工具调用` | 该轮工具调用的数量（日志侧与表面侧取其大者） |
| `系统注入 3 条 · ~3.9k 字符` | harness 注入的上下文条数与字符数 |
| `【已修剪】` / `【注入已清】` / `【已移除】` / `【进行中】` | 该轮当前状态 |
| `224 个节点` | 该轮在表面上占用的节点数 |
| 提问 / 回复预览 | 提问取真实 user 消息，回复取最后一条 assistant 文本 |

顶部徽章：`N 轮` 为总轮数，`全量 · <build>` 表示数据来自 Host 的完整日志（与聊天区滚到哪无关）。

### 三个动作

| 按钮 | 做了什么 | 模型下一轮读到 |
| --- | --- | --- |
| ✂️ **只留问答** | 把「本轮第一个含 `tool-call` 的 assistant」到「本轮最后一个表面节点」整段折叠 | 一条 user 消息，内容是**最后那条 assistant 的 `text` 块**（没有文本时用占位符） |
| 🧽 **清注入** | 把本轮 harness 注入的每一段连续节点各自替换 | `（已清除的系统注入上下文）` |
| 🗑 **删除本轮** | 整轮（含提问）替换 | `（原第 N 轮问答已由用户手动移除，内容已从上下文中移除）` |

三个动作都会弹确认框；确认后只改变模型后续看到的内容，原始日志不动。

> 注：修剪**不保留** `reasoning` 块。替换物是 user 消息，而各 adapter 会丢弃 user 内容里的 reasoning，保留它只会得到一条空消息。

### 命令行等价形式

面板做的每件事都能用命令完成（面板实际就是通过会话命令通道调用的）：

```
/trim_context {"action":"list"}
/trim_context {"action":"list_json"}
/trim_context {"action":"trim_tools","turn":2}
/trim_context {"action":"delete_turn","turn":2}
/trim_context {"action":"strip_injected","turn":2}
/trim_context {"action":"build"}
```

定位一轮的优先级：`label`（= `turn`，面板显示的编号）→ `userSeq`（该轮提问的日志序号，最稳）→ `startSeq`（该轮首节点）。面板一律用 `userSeq`，因为窗口分页编号可能与真实编号不一致。

---

## 原理：只改 surface，不改日志

DSH 的会话是 append-only 日志 + 一层「表面折叠」：

```
日志（全部保留）           表面（模型实际读到的）
seq 1  user   Q1     ──▶  Q1
seq 2  asst   tool…  ──▶  [被 shadow]
seq 3  tool/call     ──▶  （本就不在表面）
seq 4  result  …     ──▶  [被 shadow]
seq 5  asst   A1     ──▶  A1
seq 6  user   Q2     ──▶  Q2
seq 7  user   MARKER ──▶  MARKER      ← 替换事件：seq 在尾部，位置在原处
```

每次修剪就是追加一条 `user/message`，带 `surfaceOp: {op:'replace', startSeq, endSeq}`：它**原位替换**表面上的那一段，自己落在被替换的起点。

这带来两个必须小心的点，也是本插件最核心的实现约束：

1. **替换事件的 `seq` 在日志尾部，位置却在中间。** 所以任何范围都必须按 `session.surface.nodes` 的**下标**计算，绝不能拿 seq 大小相比。否则「修剪过一次的轮次」会永久无法再删除。
2. **`sourceEventSeqs` 必须是「被 shadow 的表面节点」这一切片**，与 `@deepseek-ai/dsh-session`（`surface.js` 的 `state.nodes.slice`）和官方 compaction 的写法一致。引用整段日志会漏掉原位插入的标记，被 harness 直接拒绝。

---

## 安全边界：什么时候会拒绝

这些不是 bug，是为了不把会话改坏：

| 拒绝原因 | 为什么 |
| --- | --- |
| 第 N 轮还在进行中（模型仍在生成） | 后续内容会落在标记之后，等于没修剪 |
| 还有工具调用未返回结果 | 删掉声明会让随后返回的 `tool/result` 变成孤儿，provider 直接 400 |
| 工具调用跨越到相邻提问之外 | 折叠会把用户 typed 的另一条提问一起卷进去 |
| 本轮里有更早提问的工具结果（提问发出时上一轮还在跑） | 折叠会把上一轮的调用声明卷进来，配对被破坏 |
| 该轮已移除 / 没有可修剪的工具调用 / 没有注入上下文 | 无事可做 |
| 参数不是合法 JSON、未知 action、会话不在内存中 | 命令层错误 |

工具调用与结果**永远不会被拆开**：跨度会双向扩张直到每一对 `tool-call` ↔ `tool/result` 都落在同一段里（这也是 provider 的硬要求）。

---

## 哪些「注入」会被清理

判定用**允许列表**，不是「`source.kind !== 'user'`」。因为同一个 `user/message` 槽位里还塞着别的东西：

**可以清（都是 harness `agent.inject()` 的通知）**

`runtime-context`、`time-context`、`skill-catalog`、`skill-invocation`、`model-selection`、`working-directory`、`user-approval`、`tmux-context`

**绝不触碰**

`compact-checkpoint`（压缩摘要，替换了整段历史）、`user-question-reply`（用户在 `ask_user_question` 里的回答）、`goal`、`team-message`、`agent-message`、`agent-instructions`，以及任何未知 kind。

未知 kind 一律当作「不是注入」：看不见是安全的默认值。

---

## 写进日志的三个标记

| `source.kind` | 由谁写入 | 说明 |
| --- | --- | --- |
| `context-trimmer-summary` | 只留问答 | 内容是保留下来的回答文本 |
| `context-trimmer-removed` | 删除本轮 | 额外带 `userSeq` / `label`，用于保留该行的编号与身份 |
| `context-trimmer-stripped` | 清注入 | 每个连续注入段一条 |

三条都是合法的 `user/message`：带 `id`、`role: 'user'`、`source.kind` 与 `content` 数组。少任一项，会话重启时会因为「lacks an identified message」整个加载失败。

---

## fork / 子会话

- **读**：统计使用整条日志（含 fork 继承的前缀）。只用 `ownEvents()` 会把继承历史的工具调用数读成 0，面板就会显示「无工具调用」并藏掉修剪按钮。
- **写**：替换事件只追加到子会话的日志；父会话不受影响。
- 继承来的轮次同样是当前表面节点，可以正常修剪。

---

## 排查

| 现象 | 处理 |
| --- | --- |
| 头部显示 `窗口内` 而不是 `全量` | Host 没返回轮次列表：确认 Host 半部分已加载，点「刷新」 |
| 警告「命令已发送，但…上下文表面没有变化」 | 看它下面有没有「Host 拒绝了本次操作：…」，那才是真实原因 |
| 某轮显示「无工具调用」但明明跑了很多工具 | 该轮可能还在进行中，或数据来自窗口局部；点「刷新」拉全量 |
| 头部的 build 号不是 `b13-fork-history` | 对应的半部分还是旧代码：重装并重启 |
| 「右上角的占用圈」没变 | 上下文占用在**下次发送消息后**才重算 |

---

## 开发

```
index.js             Host：命令注册、表面折叠、三个动作
client.js            Web：面板、slot 注册、Host 往返
test-synthetic.mjs   合成会话 + surface 折叠复刻，16 个用例
cordis.patch.yml     插件插入补丁
locale/*.json        元数据
```

### 测试

```bash
npm test        # node test-synthetic.mjs
```

测试不依赖任何真实会话日志：它内置了一份与 `dsh-session` 的 surface fold 语义一致的 `FakeSession`（原位 splice、`sourceEventSeqs` 覆盖校验、消息 id/role/source/content 校验），因此能在本地复现「harness 会拒绝什么」，覆盖：

- 三个动作的正向行为与配对完整性；
- 修剪后再删除、删除后再修剪、清注入后再修剪；
- 进行中的轮次被拒绝、迟到的工具结果不会变孤儿；
- 跨提问扩张被拒绝；
- fork 继承前缀的统计与修剪；
- 面板与 Host 对同一日志**逐字段一致**；
- 客户端 bundle 能被 `__ModuleLoader__` 正确加载并注册 slot。

### 接口契约

| 半部分 | 依赖 | 注册 |
| --- | --- | --- |
| Host | `commands`、`sessions` | `commands.register({name:'trim_context', handler})`，返回 `{kind:'success'|'error', text}` |
| Web | `slots`、`remote` | `sidebar.right.pane.tab` / `.title`、`conversation.input.right`、`conversation.composer.dock`，以及 `ctx.inject(['sidebarRight','sidebarRightTabs'])` |

Host 里所有「范围」都是 `session.surface.nodes` 的下标；所有「日志扫描」都走 `snapshotEvents()`（含继承前缀）。这两条是改这个插件时最容易踩的坑。

---

## 已知限制

- 只能在**已加载到内存**的会话上操作；闲置被回收的会话会返回「不在内存中」。
- 只把 `source.kind === 'user'` 的 message 当作提问边界。
- 一轮内的 `reasoning` 不保留（见上文说明）。
- 折叠后不会立刻重算上下文占用，需等下一次发送。
- `client.js` 目前是单文件；后续若继续增长，建议拆成 `turns` / `host-turns` / `view` 三个模块（需先确认该 loader 支持多模块 bundle）。
