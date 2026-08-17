# M08-A Windows Visio MCP Sidecar 设计

## 1. 目标与边界

M08-A 将 `visio-mcp` 构建为 Windows x64 客户端可直接启动的本地 Sidecar，并完成源码目录、Electron 安装包和 Release CI 三层校验。

完成后：

- 开发环境的 `bundled` 模式从 `vendor/visio-mcp/win32-x64/visio-mcp.exe` 启动。
- 安装包从 `resources/visio-mcp/win32-x64/visio-mcp.exe` 启动。
- 用户不需要安装 Python、uv 或全局 `visio-mcp`。
- Sidecar 只使用 stdio MCP；stdout 不输出日志，stderr 交给现有 `VisioMcpService`。
- 第一版只支持 Windows x64；macOS 不构建、不携带 Sidecar。

M08-A 不恢复 Analytics，不执行必须依赖 Microsoft Visio 的完整绘图验收；它们分别属于 M08-B 和 M08-C。

## 2. 已核实的上游基线

### 2.1 固定输入

- `visio-mcp==0.1.2`
- 官方 wheel：`visio_mcp-0.1.2-py3-none-any.whl`
- wheel SHA256：`c6720716de0decd6d5a79651af28ce3760434bb6a7606305c834e2afee939f46`
- Python：`>=3.14`
- 直接依赖：`mcp[cli]>=1.27.0`、`pywin32>=311`
- 许可证：MIT
- 启动入口：`visio_mcp.__main__`，内部执行 `mcp.run(transport="stdio")`

PyPI 元数据给出的 GitHub 仓库当前不可访问。Release 构建只信任官方 PyPI wheel、固定 URL 和 SHA256，不从 GitHub 分支临时构建。

### 2.2 首轮候选工具链

- CPython `3.14.6` Windows x64 常规 GIL 构建
- PyInstaller `6.22.1`
- pyinstaller-hooks-contrib `2026.6`
- MCP SDK `1.27.0`
- pywin32 `311`

这些是冻结 spike 的候选，不是最终锁定。只有真实 `initialize`、`ping`、`listTools`、无 COM 工具调用和关闭无残留验证通过后，才写入正式 lock、manifest 和 CI。正式实现阶段不得临时追随最新版。

## 3. 构建架构

```text
官方 wheel + 固定 SHA256
        ↓
隔离 Python 3.14.6 环境 + 全量哈希锁
        ↓
PyInstaller onefile / console / stdio / no UPX
        ↓
staging 内完成协议、哈希、许可证和进程校验
        ↓
vendor/visio-mcp/win32-x64/
        ↓
electron-builder extraResources
        ↓
resources/visio-mcp/win32-x64/
```

必须使用 console 模式，不能使用 windowed 模式。MCP 依赖 stdin/stdout；单文件参数固定为 `--onefile --console --noupx`，包装入口不能向 stdout 写提示。

## 4. 文件级方案

### 4.1 构建输入

```text
client/sidecar/visio-mcp/
  entrypoint.py
  visio-mcp.spec
  requirements.in
  requirements.lock
  required-tools.json
```

- `entrypoint.py` 只启动上游 stdio MCP，不放业务逻辑。
- `visio-mcp.spec` 固定 onefile、console、no UPX、x64 和 spike 验证后的 hidden imports。
- `requirements.lock` 固定完整传递依赖、wheel URL 和 SHA256；安装启用 `--require-hashes`。
- `required-tools.json` 保存易标绘图必须存在的工具子集，不能只检查工具数量。

### 4.2 Node 脚本

```text
client/scripts/
  prepare-visio-mcp.cjs
  verify-visio-mcp.cjs
  verify-packaged-visio-mcp.cjs
```

- `prepare-visio-mcp.cjs`：检查平台与 Python，建立隔离环境，校验 wheel，按 lock 安装、冻结、生成元数据，并在校验成功后原子发布。
- `verify-visio-mcp.cjs`：校验源码侧 vendor，并通过现有 MCP SDK 对 exe 做真实 stdio 自检。
- `verify-packaged-visio-mcp.cjs`：校验 `win-unpacked/resources`；macOS 模式只断言 `resources/visio-mcp` 不存在。

### 4.3 Vendor 契约

```text
client/vendor/visio-mcp/win32-x64/
  visio-mcp.exe
  VERSION
  manifest.json
  SHA256SUMS
  THIRD_PARTY_NOTICES.md
  licenses/
    visio-mcp-LICENSE.txt
    Python-LICENSE.txt
    PyInstaller-COPYING.txt
    ...实际分发依赖的许可证
```

`manifest.json` 至少记录：

- schema 版本
- 上游版本、wheel 文件名、URL 和 SHA256
- Python、PyInstaller、hooks 版本
- `platform=win32`、`arch=x64`、`transport=stdio`
- exe 文件名、大小和 SHA256
- 完整依赖名称、版本、wheel SHA256 和许可证
- 必需工具、实际工具和工具数量

`SHA256SUMS` 至少覆盖 exe、manifest、notice 和许可证。

## 5. 准备流程

1. 只允许 Windows x64，拒绝交叉构建。
2. 检查 Python 等于最终锁定的 3.14.x，且不是 free-threaded 构建。
3. 在 `client/.tmp-visio-mcp-build/` 建立隔离环境，不写用户全局 Python。
4. 从固定 PyPI URL 下载 wheel并先校验 SHA256。
5. 按 `requirements.lock --require-hashes` 安装，不现场重新解析最新版。
6. 执行 spec，生成单文件 `visio-mcp.exe`。
7. 收集依赖、版本和许可证，写入 staging。
8. staging 通过完整 verifier 后，旧 vendor 改名为 backup，staging 改名为正式目录；失败则恢复旧目录。
9. 成功或失败都清理临时环境、PyInstaller work 和 backup。

不得先删除正式产物；构建失败必须保留上一份可用 Sidecar。

## 6. 验证契约

### 6.1 静态验证

- 只允许 `win32-x64`，文件集合与 manifest 一致。
- exe 非空且 PE 架构为 x64；SHA256 与 manifest、`SHA256SUMS` 一致。
- wheel、Python、PyInstaller、hooks 和依赖版本与 lock 一致。
- MIT、Python、PyInstaller/bootloader exception 及实际运行依赖声明齐全。
- 开发路径与 `visioMcpRuntime.cjs` 的解析结果完全一致。

### 6.2 无 Visio 的 MCP 冒烟

1. 启动 exe，60 秒内完成 initialize。
2. 执行 ping 和分页 listTools。
3. 必需工具子集全部存在，完整清单与 manifest 一致。
4. 调用不触发 COM 的 `list_diagram_types`，确认返回 22 类标准图。
5. 关闭 transport 后 5 秒内退出，没有同一路径残留进程。
6. stdout 只含 MCP 帧，诊断只进入 stderr。

CI 不调用 `create_document`、绘图、保存或导出；这些属于 M08-C 的 Visio 实机验收。

## 7. Electron 与 CI 接入

`client/package.json` 增加：

```text
prepare-visio-mcp
verify-visio-mcp
verify-packaged-visio-mcp
```

Windows `extraResources`：

```text
from: vendor/visio-mcp/win32-<arch>
to:   visio-mcp/win32-<arch>
```

它与现有 packaged 路径 `process.resourcesPath/visio-mcp/win32-x64/visio-mcp.exe` 一致。macOS 不增加该资源，并在打包后显式验证不存在。

Windows Release job 顺序：

1. Setup Node 22 和最终锁定的 CPython 3.14.x x64。
2. `npm ci`。
3. `npm run prepare-visio-mcp`。
4. `npm run verify-visio-mcp`。
5. 执行既有 Agent Tools、native smoke、版本同步和 renderer build。
6. 构建 NSIS、ZIP、MSI。
7. 执行 packaged verifier。
8. 任一失败即禁止上传 Release 资产。

## 8. 实施与提交边界

1. 冻结 spike：确认最终工具链和 stdio 生命周期，不发布 vendor。
2. 固化 lock、spec、入口和许可证生成。
3. 完成 prepare 和源码 verifier。
4. 原子发布 vendor，并验证 bundled 自检。
5. 接入 package.json、extraResources 和 packaged verifier。
6. 接入 Windows CI 与 macOS absent 校验。
7. 运行 M01-M08-A 回归、`npm run build` 和 Electron bundled 自检。
8. 更新 TODO，仅暂存 M08-A 文件并创建独立提交。

完成证据必须包含：最终版本锁、exe SHA256、协议工具清单、源码与安装包校验、macOS absent、回归测试和提交哈希。手工复制一个 exe 不视为完成。

## 9. 当前结论

设计已具备直接开工条件。下一步是冻结技术 spike；候选版本通过前，不修改正式 vendor、package.json 或 Release CI。

## 10. 参考依据

- [visio-mcp 0.1.2（PyPI）](https://pypi.org/project/visio-mcp/0.1.2/)
- [visio-mcp 0.1.2 官方元数据与文件哈希](https://pypi.org/pypi/visio-mcp/0.1.2/json)
- [Python 3.14.6 官方发布页](https://www.python.org/downloads/release/python-3146/)
- [PyInstaller 官方包信息](https://pypi.org/project/pyinstaller/)
- [PyInstaller 官方变更记录](https://pyinstaller.org/en/stable/CHANGES.html)
- [PyInstaller 官方安装与 hooks 同步说明](https://pyinstaller.org/en/stable/installation.html)
