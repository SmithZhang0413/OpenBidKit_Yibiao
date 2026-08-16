# VisioMcpService 开发清单

本文档记录 yibiao 原生 Visio MCP 能力的实施顺序、模块边界和验收结果。模块只有在代码检查、专项验证和独立 Git 提交均完成后才能勾选。

## 固定实施原则

- 顺序固定为：独立功能验证、Electron Main 后端接入、Renderer 前端接入。
- Electron Main 与 preload 使用 CommonJS，Renderer 使用 ESM TypeScript。
- Renderer 只通过 `window.yibiao` 使用本地能力，IPC 只注册通道和转发参数。
- MCP 通信、图表计划转换和 Visio 调用均放在 Main 侧 Service，不在组件中实现业务逻辑。
- 模型只生成语义化 `DiagramPlan`；Visio MCP 工具名、图形模板、坐标和文件操作由程序确定性处理。
- Windows 中文路径和 UTF-8 是默认验证场景。
- 每个模块独立检查、暂存和提交，不混入用户已有改动或其他模块内容。

## 模块清单

- [x] M00：建立实施清单并确认 Git 基线
  - 基线：开始开发时工作树干净，分支为 `main`，与 `origin/main` 对齐。
  - 已完整阅读 `client/开发说明.md`。
  - 已确认模块顺序、Git 提交规则和验证门槛。

- [x] M01：独立 VisioMcpService 与 MCP 生命周期管理
  - 能解析 bundled/custom 两类运行时配置。
  - 能通过 STDIO 建立 MCP 会话、初始化、发现工具和调用工具。
  - 具备串行调用、超时、取消、进程退出、重启和释放能力。
  - Renderer 和现有 IPC 暂不接入。
  - 验证：4 个 CJS 文件通过 `node --check`；3 项真实 STDIO MCP 协议测试通过；`npm run build` 通过。
  - 依赖：固定使用 `@modelcontextprotocol/sdk@1.30.0`；`npm audit` 报告 32 个仓库依赖问题，未发现该 SDK 引入的直接公告项，不在本模块执行破坏性升级。

- [x] M02：DiagramPlan、布局转换与独立 VSDX/PNG 生成功能
  - 定义版本化 DiagramPlan Schema 和单次输出边界校验。
  - 将语义节点、分组和连线转换为确定性的 Visio 绘图命令。
  - 通过批量绘图、批量连线、保存和导出完成独立生成流程。
  - 使用临时版本目录，全部成功后再发布产物。
  - 提供不依赖 Renderer、IPC、SQLite 的独立运行入口和模拟测试。
  - 验证：6 个 M02 CJS 文件通过 `node --check`；M01/M02 共 9 项测试通过；`npm run build` 通过。
  - 真实冒烟：Python 3.14.7 + visio-mcp 0.1.2 + Microsoft Visio 成功生成 6 节点、6 连线的中文流程图，产出 34,296 字节 VSDX 和 30,291 字节 PNG，完成后打开文档数为 0。

- [x] M03：VisioDiagramStore、SQLite 迁移与工作区产物管理
  - SQLite 升级到 v20，新增 Visio 单例状态与两类后台任务表，并同步目标 schema 文档。
  - Store 持久化需求、DiagramPlan、修订号、任务状态和活动产物索引。
  - 产物按修订保存在 workspace/visio-diagram/revisions/；计划变更仅使旧产物失效，显式重置才清理。
  - 验证：3 个 M03 CJS 文件通过 node --check；Electron 原生 SQLite v19→v20、状态恢复、修订失效与中文路径冒烟通过；M01/M02 共 9 项测试通过；npm run build 通过。
- [x] M04：taskService 后台任务、进度、取消与恢复
  - 新增 visio-plan-generation 与 visio-rendering 两类互斥后台任务，持续持久化进度、日志和统计信息。
  - 计划生成经 AI Service 输出并校验 DiagramPlan；绘制任务只在 Renderer 全部成功后发布新活动产物。
  - AbortSignal 同时覆盖 AI 排队/在途请求和 Visio MCP 绘制；取消状态可区分，上一版有效产物保持不变。
  - 应用中断后，残留 running 任务恢复为可重试 error；支持取消任务和重置前等待异步清理。
  - 验证：4 个 M04 CJS 文件通过 node --check；5 项 M04 专项测试和 M01/M02 共 14 项回归测试通过；M03 Electron SQLite 冒烟通过；npm run build 通过。
- [x] M05：IPC、preload、共享类型与组件自检接口
  - Main 原生装配 VisioMcpService、Renderer、Store 与 taskService，并在退出时关闭 MCP 子进程。
  - 新增工作区、计划、步骤、产物打开、组件状态/自检/重启以及两类任务启动/取消 IPC。
  - preload 与 window.yibiao 类型同步，新增 DiagramPlan、任务、产物、组件状态和 Runtime 配置共享类型。
  - user_config.json 支持 bundled/custom Visio MCP Runtime 配置，设置页保存其他配置时会完整保留。
  - 验证：6 个 M05 CJS 文件通过 node --check；4 项 M05 专项测试及 M01-M05 共 18 项回归通过；Electron SQLite 冒烟及 npm run build 通过。
- [ ] M06：菜单、路由和 Visio 三步式前端页面
- [ ] M07：计划编辑、预览、工具条、Toast 与设置状态卡
- [ ] M08：Windows Sidecar 打包、Analytics 映射和端到端验收

## 提交记录规则

每个模块提交前执行：

1. `git status --short` 检查工作树。
2. 对新增或修改的 `.cjs` 执行 `node --check`。
3. 在 `client/` 下执行该模块专项验证。
4. 在 `client/` 下执行 `npm run build`。
5. 仅暂存当前模块文件，检查 staged diff 后提交。
6. 提交完成后，在会话中报告提交哈希和验证结果。
