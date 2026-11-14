# 讨论树 · Discussion Tree

本地 stdio MCP App：采集项目内的新问答，由模型判断节点关系，在会话侧栏显示讨论树。当前版本为 0.4.1。

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

重启桌面应用，审核启用项目 Hooks。在本项目会话中打开讨论树，将应用卡片通过“在标签页中打开应用”放到侧栏。入口工具为 `open_thread_panel_probe`，需绑定当前会话的 `session_id`。

## 数据与模型使用

仅采集启用后的 UserPromptSubmit、Stop、Interrupt 事件，不回填旧会话，不读取隐藏推理、工具输出或附件字节。采集范围限定为构建时绑定的项目。

本地数据位于被 Git 忽略的 `.probe/`：`events/` 保存原始问答，`trees/` 保存归类状态，`qa/` 保存完整问答文件。

节点归类通过已登录的 Codex CLI 调用模型，问答及候选摘要会发送给模型服务并使用账号额度。查看本地问答文件不调用模型。分类失败不会无限自动重试。

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
