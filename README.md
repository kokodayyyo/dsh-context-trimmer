# 上下文修剪器 · dsh-context-trimmer

在 DeepSeek Harness 里**手动、逐轮地修剪会话上下文**：把某轮中间的几十次工具调用与结果从「模型下一轮读到的内容」里移除，只保留提问和最终回答；也可以整轮移除，或者清掉某一轮的系统注入上下文。

- 只改 **surface**（模型可见的派生消息），**不删日志**——聊天记录仍可完整回看。
- 每次修剪写成一个 **DSH 原生的 compaction 事务**（`compaction/start → summary → compact-checkpoint → end`），不是自定义标记。
- 右侧栏面板 + `/trim_context` 命令双入口。
- 支持 fork / 子会话：继承来的历史照样能修剪，改动只写进子会话自己的日志。

当前版本 `2.0.0`，Host 构建号 `b15-answer-preview`。

---

## 它解决什么问题

长会话里，一轮问答往往夹着几十次 `read` / `grep` / `bash`：文件内容、命令输出、重试记录全都还在上下文里。你只希望模型记得「我问了什么、它答了什么」，不希望它每轮重读那几十次中间过程。

自动压缩（compaction）解决的是「上下文快满了」，而这里解决的是「我想现在就删掉这一段，而且我知道我要删哪一段」。

---

## 安装

包以 DSH 插件形式提供：

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半部分：注册 `/trim_context`，写 surface 压缩事务 |
| `client.js` | Web 半部分：右侧栏面板、输入框按钮、降级面板 |
| `cordis.patch.yml` | 启动时把插件插入插件树（`dsh.bundle.patch`） |
| `locale/zh.json`、`locale/en.json` | 插件元数据 |

安装/替换后**必须重启 DSH**（Host 半部分只在进程启动时加载）。面板 bundle 是否需要另行重载，取决于你的加载方式。

### 确认装对了版本

两个信号都直接可见，不用猜：

1. `/trim_context {"action":"build"}` → 返回 `Host 构建版本：b15-answer-preview`
2. 面板头部徽章 → `全量 · b15-answer-preview`

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
| `122 次工具调用` / `原 122 次工具调用 · 现 0 次` | 未修剪时显示表面计数；修剪后同时给出「原 / 现」 |
| `系统注入 3 条（持久 1）` | harness 注入的条数；括号里是需要慎重清除的部分 |
| `【已修剪】` / `【注入已清】` / `【已移除】` / `【进行中】` | 该轮当前状态 |
| `224 个节点` | 该轮在表面上占用的节点数 |

顶部徽章：`N 轮` 为总行数，`全量 · <build>` 表示数据来自 Host 的完整日志（与聊天区滚到哪无关）。

### 三个动作

| 按钮 | 做了什么 | 模型下一轮读到 |
| --- | --- | --- |
| ✂️ **只留问答** | 把「本轮第一个含 `tool-call` 的 assistant」到「本轮最后一个表面节点」整段折叠 | 一条 user 消息，内容是**最后那条 assistant 的 `text` 块**（没有文本时用占位符） |
| 🧽 **清注入** | 清掉本轮的一次性注入（`time-context` 等） | `（已清除的系统注入上下文）` |
| 🧽 **清持久注入** | 仅在只剩持久注入时出现，二次确认后清除 | 同上 |
| 🗑 **删除本轮** | 整轮（含提问）替换 | `（原第 N 轮问答已由用户手动移除，内容已从上下文中移除）` |

**按钮只有在该动作真的有事可做时才出现**：工具调用按**表面**计数（日志里还留着的旧调用不会让按钮复活），注入按当前表面剩余的条数判断。已修剪的轮次只保留「删除本轮」。

三个动作都会弹确认框；确认后只改变模型后续看到的内容，原始日志不动。

> 注：修剪**不保留** `reasoning` 块。替换物是 user 消息，而各 adapter 会丢弃 user 内容里的 reasoning，保留它只会得到一条空消息。

### 命令行等价形式

```
/trim_context {"action":"list"}
/trim_context {"action":"list_json"}
/trim_context {"action":"trim_tools","turn":2}
/trim_context {"action":"delete_turn","turn":2}
/trim_context {"action":"strip_injected","turn":2}                      ← 只清瞬时注入
/trim_context {"action":"strip_injected","turn":2,"includeDurable":true} ← 清持久注入
/trim_context {"action":"build"}
```

定位一轮的优先级：`label`（= `turn`，面板显示的编号）→ `userSeq`（该轮提问的日志序号，最稳）→ `startSeq`（该轮首节点）。面板一律用 `userSeq`。

---

## 原理：一次修剪 = 一个压缩事务

DSH 的会话是 append-only 日志 + 一层「表面折叠」。表面上的替换必须通过它自己的压缩契约完成：

```
compaction/start    { compactionId, turn: null | N }
compaction/summary  { compactionId, summary: ContentBlock[],
                      shadowedRange: {start, end}, shadowedSeqs: [...],
                      shadowedTokenCount, provider, model,
                      trimmer: { mode: 'trim'|'remove'|'strip', label, userSeq } }
user/message        source: { kind: 'compact-checkpoint', compactionId }
                    surfaceOp: { op:'replace', startSeq, endSeq }
                    sourceEventSeqs: [startSeq, summarySeq, ...被折叠的表面节点]
compaction/end      { compactionId, turn }
```

为什么必须是这个形状：

1. **`@deepseek-ai/dsh-compaction` 的实时不变量会校验每一次 append**：括号不能嵌套、`turn` 必须与当前打开的 turn 一致、`shadowedSeqs` 必须等于当时表面的那一段、`compact-checkpoint` 必须落在匹配的事务里。写错立刻报错，而不是留在日志里等重启时炸。
2. **token 计量与聊天渲染都认它**：`shadowedTokenCount` 让占用统计正确，检查点在聊天区显示为压缩节点。
3. **与真实 compaction 互斥**：只要日志里有未闭合的 `compaction/start`，本插件拒绝写入；本插件事务未闭合时，别的压缩也不会插进来。
4. **别人家的压缩检查点不能被折叠**：跨度里出现非本插件写的 `compact-checkpoint` 时直接拒绝，避免把整段摘要删掉。

`trimmer` 字段是本插件在 `compaction/summary` 上留下的身份标记。面板靠它区分「用户修剪的」和「harness 自动压缩的」——真实压缩检查点没有这个字段。

还有一个必须记住的坐标系问题：**替换事件的 `seq` 在日志尾部，位置却在表面中间**。所以所有范围都按 `session.surface.nodes` 的**下标**计算，只在两端换回 seq；`shadowedSeqs` 就是那段的切片。

### 兼容旧数据

1.x 写下的三种 `context-trimmer-*` 标记仍会被识别（显示【已修剪】/【已移除】/【注入已清】），但插件不再写入它们。新修剪一律走压缩事务。

---

## 安全边界：什么时候会拒绝

| 拒绝原因 | 为什么 |
| --- | --- |
| 另一个压缩事务未结束 | 嵌套括号会让日志进入非法状态 |
| 第 N 轮还在进行中 | 后续内容会落在标记之后，等于没修剪 |
| 还有工具调用未返回结果 | 删掉声明会让随后返回的 `tool/result` 变成孤儿，provider 直接 400 |
| 工具调用跨越相邻提问 / 卷进上一个提问 | 折叠会把用户 typed 的另一条提问一起删掉 |
| 范围内含系统压缩检查点 | 会把整段摘要吃掉 |
| 只剩持久注入却未确认 | 见下一节：宿主不会自动补发 |
| 参数非法 / 会话不在内存 / 未知 action | 命令层错误 |

工具调用与结果**永远不会被拆开**：跨度会双向扩张直到每一对 `tool-call` ↔ `tool/result` 都落在同一段里。

---

## 注入分两档：瞬时 vs 持久

判定用**允许列表**，并且按「宿主会不会再发一次」分成两档：

| 档位 | kinds | 语义 |
| --- | --- | --- |
| **瞬时**（默认清除） | `time-context` | 每轮重发，删掉无副作用 |
| **持久**（需二次确认） | `runtime-context`、`skill-catalog`、`skill-invocation`、`model-selection`、`working-directory`、`user-approval`、`tmux-context` | 宿主**只在其内容/状态变化时**重发；清除后本次会话可能永久失去这段说明 |

**绝不触碰**：`compact-checkpoint`（压缩摘要）、`user-question-reply`（用户回答）、`goal`、`team-message`、`agent-message`、`agent-instructions`，以及任何未知 kind。未知一律当作「不是注入」：看不见是安全的默认值。

---

## fork / 子会话

- **读**：统计使用整条日志（含 fork 继承的前缀）。只用 `ownEvents()` 会把继承历史的工具调用数读成 0。
- **写**：压缩事务只追加到子会话的日志；父会话不受影响。
- 继承来的轮次同样是当前表面节点，可以正常修剪。

---

## 排查

| 现象 | 处理 |
| --- | --- |
| 头部显示 `本地` / `窗口内` 而不是 `全量 · b15-…` | Host 没返回轮次：确认 Host 半部分已加载，点「刷新」 |
| 警告「命令已发送，但…上下文表面没有变化」 | 看它下面有没有「Host 拒绝了本次操作：…」，那才是真实原因 |
| 「另一个压缩事务尚未结束」 | 会话里有一段未闭合的 `compaction/start`（自动压缩进行中或上次写入失败）：稍后重试；反复出现请反馈日志 |
| 「范围内包含一条系统压缩检查点」 | 该轮里已有 harness 的压缩摘要，插件拒绝吞掉它；改成按轮删除或先手动确认 |
| 点了「清注入」却提示只有持久注入 | 这是设计行为：瞬时注入已清完，持久注入需要再点一次「清持久注入」并确认 |
| 头部的 build 号不是 `b15-answer-preview` | 对应的半部分还是旧代码：重装并重启 |
| 「右上角的占用圈」没变 | 上下文占用在**下次发送消息后**才重算 |

---

## 开发

```
index.js             Host：命令注册、表面折叠、压缩事务、三个动作
client.js            Web：面板、slot 注册、Host 往返
test-synthetic.mjs   合成会话 + surface/compaction 不变量复刻
cordis.patch.yml     插件插入补丁
locale/*.json        元数据
```

### 测试

```bash
npm test                                  # node test-synthetic.mjs
TRIMMER_LOG=<session.v4.jsonl.zstd> npm test   # 额外回放一份真实会话并执行一次修剪
```

测试不依赖真实日志：内置的 `FakeSession` 复刻了 `dsh-session` 的 surface fold **以及** `dsh-compaction` 的实时不变量（括号、owner、`shadowedSeqs` 必须是当前表面切片、检查点必须落在匹配事务里、失败必须写 error end）。覆盖：

- 三个动作的事务形状、字段与配对完整性；
- 事务中途失败时括号被正确关闭；
- 修剪后再删除、删除后再修剪、清注入后再修剪；
- 只清瞬时 / 持久注入需二次确认；
- 未闭合压缩事务阻止写入、外来检查点不被折叠；
- 进行中的轮次被拒绝、迟到的工具结果不会变孤儿；
- 跨提问扩张被拒绝；
- fork 继承前缀的统计与修剪；
- 面板与 Host 对同一日志**逐字段一致**；
- 成功判据（含「持久注入第二步」）。
- 可选：真实会话回放 + 一次真实修剪。

### 接口契约

| 半部分 | 依赖 | 注册 |
| --- | --- | --- |
| Host | `commands`、`sessions`（`tokenMeter` 可选，通过 `ctx.get` 读取） | `commands.register({name:'trim_context', handler})`，返回 `{kind:'success'|'error', text}` |
| Web | `slots`、`remote` | `sidebar.right.pane.tab` / `.title`、`conversation.input.right`、`conversation.composer.dock`，以及 `ctx.inject(['sidebarRight','sidebarRightTabs'])` |

改这个插件时最容易踩的两个坑：**范围必须用表面下标**，**写入必须是一个完整的压缩事务**。

---

## 已知限制

- 只能在**已加载到内存**的会话上操作；闲置被回收的会话会返回「不在内存中」。
- 只把 `source.kind === 'user'` 的 message 当作提问边界。
- 一轮内的 `reasoning` 不保留。
- 折叠后不会立刻重算上下文占用，需等下一次发送。
- `client.js` 仍偏大（~1650 行），后续可拆成 `turns` / `host-turns` / `view` 三个模块。
- 压缩事务要求写入时**没有其他未闭合的压缩事务**；如果会话正被自动 compaction 占用，请等它结束再操作。
