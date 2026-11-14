# 讨论树 · Discussion Tree

本地 stdio MCP App：采集项目内的新问答，由模型判断节点关系，在会话侧栏显示讨论树。当前版本为 0.6.0。

## 功能

- 每轮问答一个节点，支持缩放、折叠、展开和增量更新。
- 模型生成标题、摘要及父子关系；待归类节点使用虚线，失败后可手动重试。
- 点击节点打开本地完整问答文件，不发送聊天消息，不额外调用模型。同一节点使用固定文件路径，交给宿主复用文件标签页。
- 问答直接保留 Markdown，交给宿主 Markdown 预览渲染代码、图片、表格和公式，不再把整轮内容包成文本代码块。代码语言标签和原始缩进完整保留。
- 远程图片由预览器按原地址加载，需要网络；采集不包含附件字节。不可访问的图片地址不会自动修复。若文件默认显示源码，请切换到宿主预览模式；具体公式及高亮支持取决于宿主预览器。

## 安装

需要 Node.js 20+、npm、支持 MCP Apps 和文件打开扩展的 Codex 桌面应用，以及已登录的 Codex CLI。

在项目根目录执行：

```sh
npm ci
npm run build
codex plugin marketplace add .
codex plugin add thread-panel-probe@tree-panel-lab
```

构建会将当前项目路径写入本机构建产物，移动项目后需要重新构建和安装。构建产物不提交到 Git。

将 `config/config.example.toml` 和 `config/hooks.example.json` 分别复制到本地 `.codex/config.toml`、`.codex/hooks.json`，替换 Hooks 中的路径占位符。已有配置请合并而非覆盖。使用 WSL 时，普通 `command` 应指向 WSL 可访问的路径。

重启桌面应用，审核启用项目 Hooks。在当前会话的侧面板应用入口中选择“讨论树”。插件仅声明 thread 入口，不再注册离开会话的全局入口。打开操作直接调用本地工具，无需发送消息或调用模型。优先使用宿主请求元数据中的当前会话 ID，显式 session_id 与宿主 ID 冲突时拒绝加载。

当前客户端资源确认存在会话面板入口，但实际入口位置及其是否传递会话 ID 仍需桌面验收。如果宿主没有传递 ID，面板明确显示无法自动绑定，并提供折叠的手动选择作为兼容方式；不会用最近活跃会话冒充当前会话。

## 数据与模型使用

Hooks 自动采集启用后的 UserPromptSubmit、Stop、Interrupt 事件。旧会话可使用下方历史导入功能补录。不会导入隐藏推理、工具输出、开发者指令或附件字节。采集和导入范围限定为构建时绑定的项目。

本地数据位于被 Git 忽略的 `.probe/`：`events/` 保存 Hooks 问答，`history/` 保存导入问答，`trees/` 保存归类状态，`qa/` 保存完整问答文件。

## 导入已有会话并重建

在绑定当前会话的讨论树面板点击“导入当前会话历史并重建（不调用模型）”。插件从本机 `CODEX_HOME`（默认用户目录下的 `.codex`）的 `sessions/` 或 `archived_sessions/` 查找精确匹配该会话 ID 的历史文件，同时校验文件内 ID 和项目路径。不会修改原始历史。云端或另一台机器上的历史需先在本机可用；找不到时会显示错误。

读取用户消息和最终回答，保留文字里的 Markdown，以原始轮次 ID 合并 Hooks 数据、按原始时间排序。重复导入不产生重复节点，也不把压缩摘要当成新问答。不完整的文件末行会跳过并提示再次导入；中间记录损坏时拒绝导入，保留上次结果。当前支持本地 JSONL 中的 UserMessage/最终 AgentMessage 完成事件，以及 user_message、task_complete、turn_aborted 事件。没有这些事件的历史格式会明确报错。图片只保留消息文字中已有的引用，不导入独立附件内容。

导入前暂停此服务中该会话的自动归类。若已有模型请求正在执行，待它结束后再点击导入。导入、节点重建、查看问答不调用模型；已有内容未变的归类结果保留，新节点显示待归类。需要判断关系时手动点击“启用模型归类（消耗额度）”。

如果宿主没有提供当前会话 ID，可在面板中手动填写该会话 ID，再导入；尚未采集的会话无需先出现在本地列表。不会自动猜测当前会话。

打开面板、选择会话、轮询新节点及打开问答均不会启动模型。只有点击“启用模型归类（消耗额度）”或“重试失败节点”后，才在服务存活期间自动归类选定会话的新节点；重启服务后需重新启用。节点归类通过已登录的 Codex CLI 调用模型，问答及候选摘要会发送给模型服务并使用账号额度。查看本地问答文件不调用模型。分类失败不会无限自动重试。

- `TREE_CODEX_CLI`：可选的 Codex CLI JavaScript 入口路径。Windows 默认使用当前用户的 npm 全局安装位置。
- `TREE_MODEL`：可选分类模型；未设置时使用 CLI 默认模型。
- `TREE_MODEL_DISABLED=1`：禁用后台归类，供测试使用。
- `PROBE_PROJECT_ROOT`：覆盖项目数据根目录，供测试或定制部署使用。

分类子进程使用临时目录，不加载用户配置，关闭 Hooks 及工具相关功能，并复用本机登录认证。程序校验模型选择的父节点，避免自引用和循环。

## 开发与验证

```sh
npm run build
npm test
```

测试覆盖事件去重、会话隔离、归类重试、树形布局、长问答、稳定文件路径及文件打开协议。测试数据在临时目录生成。

只读预览：`node scripts/dev-preview.mjs`，访问 `http://127.0.0.1:4329/?session=<session-id>`。它不是实际桌面宿主，不提供原生文件标签页接口，也不调用分类模型。

宿主必须声明 `experimental["openai/files"]` 才能打开问答标签页。不支持时显示错误，不回退到模型。实际侧栏显示和同文件标签页复用仍需在目标桌面版本验收。

源码位于 `src/`，构建脚本位于 `scripts/`，插件清单位于 `plugins/thread-panel-probe/`，marketplace 位于 `.agents/plugins/marketplace.json`。修改后重新构建、安装并重载客户端。

## 卸载

```sh
codex plugin remove thread-panel-probe@tree-panel-lab
codex plugin marketplace remove tree-panel-lab
```

另行禁用本地项目 Hooks。问答数据不会自动删除。

## 参考

- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
