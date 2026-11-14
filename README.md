# 讨论树 · Discussion Tree

本地 MCP App，版本 0.8.0。跨项目使用，以当前会话 ID 独立保存讨论树。用大纲组织学习主题，按需收录问答；采集和历史导入不会自动生成树节点。

## 使用

重启桌面应用，在当前会话的面板入口中打开“讨论树”。入口类型为 `thread`。宿主提供会话 ID 时直接绑定；未提供时可手动填写当前会话 ID 或选择本地会话。不会猜测最近活跃会话。实际入口位置和自动绑定支持取决于桌面版本。

### 大纲分类

展开“用大纲创建分类节点”，自行输入或粘贴已生成的大纲。创建按钮不调用模型。支持 Markdown 标题，或每层两个空格缩进的列表：

```text
- 学习主题
  - 基础概念
  - 实践应用
    - 常见问题
```

每行创建一个分类标签，不对应问答。层级不能跳级，标题最多 120 字，整棵树最多 300 个节点。默认追加到讨论起点；勾选“重建”后替换树内结构并取消等待节点，本地问答仍保留，可以重新收录。

### 先创建节点，再提问

右键分类节点、已收录问答节点或讨论起点，选择“创建空问答子节点，收录下一轮”。也可选中父节点后使用上方按钮。

每个会话同时只能有一个等待节点。创建后在当前会话发送新请求，插件绑定这一轮提问，捕获完整最终回复后填入原空节点。不会绑定创建前已有轮次或导入的旧问答。标题从提问截取，不调用模型。

中断后保留对该轮的等待，不会误收录后续另一轮；可以取消等待节点后重新创建。Hooks 启用时，即使面板关闭也能完成收录；轮询会补偿暂时的锁冲突。

### 智能收录已有问答

在“未收录问答”选择一轮，可先查看原文，再点击“智能收录（一次模型请求）”。只有完整的问答可智能收录。

插件通过已登录的 Codex CLI 发起一次独立后台请求，输入选中问答、大纲及已有节点摘要，输出标题、摘要和父节点 ID。父节点可以是分类或已有问答。原始完整问答保存在本地，不由模型重写。

此操作消耗模型额度，不创建 subagent、不向当前会话发送消息。请求使用临时 ephemeral 执行，禁用 Hooks、插件、工具和多代理。没有自动重试或持续归类；失败后由用户决定是否重试。归类输入中的提问和回答各截取最多 24000 字符，查看原文不截断。重复收录和非法父节点会被拒绝。

### 导入与查看

“导入历史到未收录列表”读取本机 `CODEX_HOME`（默认用户目录下 `.codex`）中 `sessions/` 或 `archived_sessions/` 的匹配历史。按当前会话 ID 精确查找并校验文件内 ID；不要求会话工作目录等于插件源码目录，也不要求旧工作目录仍然存在。只导入用户文字消息和最终回答，排除推理、工具输出和注入指令。不会修改原始历史。

支持 JSONL 的 UserMessage/最终 AgentMessage 完成事件，以及 user_message、task_complete、turn_aborted 事件。按原轮次 ID 与 Hooks 合并去重；重复导入不重复收录。末行未写完会跳过并提示，中间记录损坏则拒绝导入。

只支持本机可用历史，不下载云端历史或附件字节。图片保留文字中已有引用。读取、导入、创建分类、等待收录和打开问答都不调用模型。

点击已填充的问答节点，在原生文件标签页显示完整 Markdown。固定文件路径供宿主复用标签页；代码、图片、表格、公式由宿主预览器渲染。远程图片依赖网络，具体渲染能力取决于宿主。分类和空节点不会打开问答文件。

## 安装与更新

需要 Node.js 20+、npm 和支持 MCP Apps/文件打开扩展的桌面应用。仅智能收录需要已登录的 Codex CLI。

```sh
npm ci
npm run build
codex plugin marketplace add .
codex plugin add thread-panel-probe@tree-panel-lab
```

插件自带 `hooks/hooks.json`，在插件启用的会话中采集 UserPromptSubmit、Stop 和 Interrupt，不需要为每个项目复制 Hooks。重启桌面应用，在“Review hooks”或“Settings > Hooks”审核并信任新版插件 Hooks 后才会执行。这是宿主要求，安装插件本身不会自动信任 Hooks。若用户或管理员配置关闭了 Hooks，需先启用；`config/config.example.toml` 提供示例。

构建不再嵌入源码目录，MCP 与 Hooks 均在运行时选择相同的用户级存储目录。旧项目内 Hooks 可以暂时保留，同一事件按会话/轮次/内容去重；新插件 Hooks 信任并生效后，可禁用旧项目 Hooks，避免重复执行。`config/hooks.example.json` 仅作为不支持插件 Hooks 的客户端的用户级备用配置，需合并到用户 `.codex/hooks.json` 并替换安装目录占位符，不要覆盖其他 Hooks。

升级到 0.7.0 后旧自动树不再作为新树显示，旧问答和归类文件保留，可从未收录列表重新组织。重启客户端会停止旧版本尚存活的自动归类进程。

## 数据与配置

默认存储在 `<CODEX_HOME>/discussion-tree/.probe/`（未设置 CODEX_HOME 时为用户目录下 `.codex/discussion-tree/.probe/`），与会话 cwd、插件安装版本和源码位置无关。包含 `events/`（Hooks 问答）、`history/`（导入问答）、`curated/`（分类、收录节点和等待绑定）、`qa/`（展示文件）。各数据类别按会话 ID 分开；不同会话使用同一个轮次 ID 也不会互相覆盖。旧 `trees/` 数据保留，不自动转为新树。插件启用且 Hooks 已信任时，各项目的新问答均会在本机保存。

从 0.7.x 升级，可执行以下命令将旧项目 `.probe/` 中的问答和树复制到用户级目录：

```sh
node scripts/migrate-data.mjs <old-project-root>
```

迁移不删除源数据、不覆盖目标已有文件，可重复运行；跳过锁、临时文件和诊断文件。Windows 和 WSL 默认属于不同运行环境；请使用与桌面插件相同的 Node 环境执行迁移。若自定义数据目录，MCP 和 Hooks 必须设置相同环境变量。

- `TREE_CODEX_CLI`：可选 Codex CLI JavaScript 入口；Windows 默认使用用户 npm 全局安装位置。
- `TREE_MODEL`：可选智能收录模型，默认使用 CLI 默认模型。
- `TREE_MODEL_DISABLED=1`：拒绝智能收录请求，供测试使用。
- `TREE_DATA_ROOT`：覆盖用户级数据根目录，数据保存到该目录下的 `.probe/`；MCP 和 Hooks 必须保持一致。
- `PROBE_PROJECT_ROOT`：兼容旧版测试/部署的数据根目录覆盖，不再限制允许采集的 cwd；优先级低于 TREE_DATA_ROOT。

## 验证

```sh
npm run build
npm test
```

测试覆盖跨项目 MCP/Hooks 共用存储、相同轮次 ID 的会话隔离、跨目录历史导入、错误会话 ID 拒绝、旧数据迁移、Markdown、分类层级、面板关闭后的下一轮收录、中断、取消、重建、重复收录、父节点校验、单次后台请求以及面板右键/选择交互。模型测试使用模拟进程，不消耗实际模型额度。

只读预览：`node scripts/dev-preview.mjs`，访问 `http://127.0.0.1:4329/?session=<session-id>`。不提供写入和原生文件标签页，不调用模型。DOM 测试不代替桌面宿主的实际点击验收。

## 卸载

```sh
codex plugin remove thread-panel-probe@tree-panel-lab
codex plugin marketplace remove tree-panel-lab
```

若曾手动配置用户或项目 Hooks，另行禁用这些旧入口。卸载插件不会自动删除用户级问答数据。

## 参考

- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
