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
- [x] M06：菜单、路由和 Visio 三步式前端页面
  - 新增 Visio 绘图主菜单、独立侧栏图标和 AppRouter 页面入口。
  - 三步工作流覆盖需求输入、图表计划核对和 VSDX 结果打开；任务进度、取消、错误与成功提示均通过现有 bridge/Toast 接入。
  - 工作区状态以 Main 持久化结果为权威，支持后台任务事件恢复；重新生成计划失败时保留已有计划，需求变更才清空旧结果。
  - 样式复用现有设计令牌和按钮体系，页面根固定高度，长表单、节点和连线列表均在页面内部滚动。
  - 验证：Electron 临时 userData 运行时验证需求页和计划页，4 节点/3 连线及步骤切换正确；M01-M05 共 18 项回归测试、Electron SQLite 中文路径冒烟及 npm run build 通过。
- [ ] M07：计划编辑、预览、工具条、Toast 与设置状态卡
  - [ ] 计划编辑器：可编辑标题、图表类型、页面方向、分组、节点和连线；节点、分组和连线 ID 由程序维护并只读展示。
  - [ ] 编辑联动：删除节点时同步删除关联连线；删除分组时解除节点归属；端点、分组、类型和必填文本只在 Renderer 用户输入层校验。
  - [ ] 保存语义：采用显式保存，不自动保存；保存成功后调用现有 `savePlan()` 生成新计划修订，并按 Store 既有语义使旧活动产物失效。
  - [ ] 离开保护：计划存在未保存修改时接入 AppRouter 既有 leave guard；任务运行期间禁用冲突的编辑、保存和步骤切换操作。
  - [ ] PNG 预览：扩展 `yibiao-asset`，新增 `visio-diagram` 资产根并映射到 `getVisioDiagramDir(app)`；相对路径逐段编码，Renderer 不读取本地文件或 Base64。
  - [ ] 预览交互：结果页显示当前页大图和多页切换入口；预览读取失败不影响 VSDX 打开与重新生成，不在本模块增加图片编辑能力。
  - [ ] 浮动工具条：复用 `shared/ui/FloatingToolbar`，按当前步骤提供重置、上一步/下一步、保存计划、重新生成计划、生成/重新生成 Visio、打开 VSDX。
  - [ ] Toast 边界：M06 已有任务成功/失败/取消提示；本模块只补计划保存、工作区重置、组件自检/重启和预览读取失败提示，避免重复通知。
  - [ ] 设置状态卡：放入“组件设置”，展示 bundled/custom、支持性、可用性、进程阶段、服务版本、工具数量和最后错误，并提供自检、重启操作。
  - [ ] Runtime 配置：状态卡支持选择 bundled/custom；custom 模式可编辑 command、args、cwd，env 继续保留既有值，不在普通表单展示或改写环境变量。
  - [ ] 状态同步：设置保存继续完整保留 `visio_mcp`；自检、重启和配置保存后刷新卡片，不在 Renderer 缓存第二份权威运行状态。
  - [ ] 专项验证：覆盖计划编辑联动、保存修订/产物失效、预览 URL 编码、状态卡状态映射和工具条禁用规则；Electron 临时 userData 验证中文路径、多页预览和离开保护。
  - [ ] 完成门槛：相关 TypeScript/CJS 检查、M01-M07 回归、Electron 冒烟和 `npm run build` 全部通过；更新本清单后独立 Git 提交。

- [ ] M08：Windows Sidecar 打包、Analytics 映射和端到端验收
  - [ ] M08-A：Windows Sidecar 构建、打包与发布
    - [ ] 固定上游输入：锁定 `visio-mcp==0.1.2`、Python 3.14.x 和官方 wheel SHA256 `c6720716de0decd6d5a79651af28ce3760434bb6a7606305c834e2afee939f46`。
    - [ ] 冻结技术验证：先完成 `fastmcp + pywin32 + stdio` 冻结冒烟，再固定已验证的 PyInstaller 与 hooks-contrib 版本；使用 console/stdio 模式生成单文件 `visio-mcp.exe`。
    - [ ] 构建元数据：记录版本、平台、架构、上游 URL、SHA256、构建工具版本和依赖清单；随产物保留 visio-mcp MIT 许可证及第三方声明。
    - [ ] 准备脚本：将构建结果原子发布到 `vendor/visio-mcp/win32-x64/visio-mcp.exe`，不复用用户全局 Python 环境作为运行依赖。
    - [ ] 源码侧校验：检查 EXE、VERSION、manifest、许可证和 SHA256，并通过真实 MCP initialize/listTools 自检 STDIO 协议。
    - [ ] 安装包校验：确认安装包只携带目标 `win32-x64` Sidecar，路径与 `visioMcpRuntime` 的 packaged 解析完全一致。
    - [ ] 客户端打包：在 `package.json` 增加准备/验证命令和 Windows `extraResources`；Windows 第一版只发布 x64，macOS 包不写入 Visio Sidecar。
    - [ ] Release CI：Windows job 使用固定 Python 3.14，在 electron-builder 前完成构建、哈希和协议校验，在 NSIS/ZIP/MSI 后执行 packaged verify；任一失败均阻止发布。
    - [ ] 平台边界：macOS job 保持现状并验证不包含 Visio Sidecar；macOS Renderer 明确展示“不支持 Microsoft Visio”。
    - [ ] 子模块提交：脚本、打包配置和 Release CI 验证全部通过后独立 Git 提交，再勾选 M08-A。
  - [ ] M08-B：恢复 Analytics 基线并增加 Visio 映射
    - [ ] 等价恢复客户端 `app_open`、`page_view`、`config_usage`、`ai_request`、`resource_click`、`agent_runtime` 采集调用，保持 Worker 现有允许事件、聚合字段和 Dashboard 展示能力。
    - [ ] 隐私边界：不采集图表需求正文、标题、DiagramPlan、文件路径、MCP 参数、API Key 或本地环境变量；埋点失败不影响绘图主流程。
    - [ ] 页面与配置映射：页面访问使用 `visio-diagram`；Runtime 配置仅统计 `visioMcpModes=bundled|custom`。
    - [ ] AI 请求映射：计划生成继续复用文本模型 `ai_request`，不新增重复 Token 事件；Visio MCP 绘制不计作 AI 请求。
    - [ ] 全链路同步：同步修改 Worker `CONFIG_USAGE_FIELDS`、统计聚合、Dashboard 配置用量分组和客户端映射，并补齐新增字段的聚合/查询验证。
    - [ ] 子模块提交：client、worker、dashboard 的等价恢复和 Visio 映射验证全部通过后独立 Git 提交，再勾选 M08-B。
  - [ ] M08-C：分层端到端验收
    - [ ] CI 层：运行 M01-M08 回归、Electron SQLite 冒烟、Sidecar MCP 初始化/工具发现、Renderer 构建和安装包资源校验，不依赖 GitHub Runner 安装 Microsoft Visio。
    - [ ] Visio 实机层：在安装 Microsoft Visio Desktop 的 Windows x64 上，从正式安装包完成组件自检、中文需求、计划编辑、PNG 预览、VSDX 生成/打开、重新生成和重启 Sidecar。
    - [ ] 产物层：校验 VSDX/PNG 非空、manifest 节点/连线/页面统计一致、中文路径可用、计划修订正确、失败时保留上一版活动产物。
    - [ ] 生命周期层：取消与退出后无残留 Visio MCP 子进程；成功和失败后无未关闭 Visio 文档；应用重启能恢复工作区且不会把旧 running 任务当作仍在执行。
    - [ ] 安装层：NSIS、ZIP、MSI 至少各验证 Sidecar 存在与可启动；无 Python 环境的新 Windows 用户只需已安装 Microsoft Visio 即可绘图。
    - [ ] 子模块提交：自动验收记录和 Visio 实机验收记录完成后独立 Git 提交，再勾选 M08-C。
  - [ ] 完成门槛：M08-A/M08-B/M08-C 均已勾选，Windows 安装包端到端通过，Analytics 等价能力保留，M01-M08 全回归通过；最后更新 M08 总项并提交验收记录。

## 提交记录规则

每个模块提交前执行：

1. `git status --short` 检查工作树。
2. 对新增或修改的 `.cjs` 执行 `node --check`。
3. 在 `client/` 下执行该模块专项验证。
4. 在 `client/` 下执行 `npm run build`。
5. 仅暂存当前模块文件，检查 staged diff 后提交。
6. 提交完成后，在会话中报告提交哈希和验证结果。
