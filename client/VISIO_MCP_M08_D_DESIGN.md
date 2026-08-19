# M08-D Visio 大规模图表自适应布局设计

## 1. 目标与问题基线

M08-D 解决节点数量增加后图形彼此覆盖的问题，并保持现有 `DiagramPlan -> 确定性布局 -> Visio MCP -> VSDX/PNG` 架构不变。

当前 `visioDiagramLayout.cjs` 始终使用固定 A4 横向或纵向画布：节点中心点按最大行列数平均分配，默认节点尺寸保持 `1.8 × 0.8` 英寸。节点越多，中心点间距越小；当间距小于节点宽高时，布局必然重叠。现有 Sidecar 的 40 个上游工具只提供页面增删、切换和摘要，没有设置页面尺寸或适应绘图的工具，因此仅修改 Prompt、缩小字体或依赖模板 Auto Size 都不能形成稳定保证。

目标：

- 任意合法 `DiagramPlan` 的节点中心间距不再为了塞入固定纸张而无限缩小。
- 根据节点实际宽高、行列轨道和安全间距计算动态绘图画布。
- 绘制完成后让 Visio 页面覆盖全部节点和连接线，VSDX 保持可编辑。
- 小图继续至少使用用户选择方向对应的 A4 基础画布，避免少量节点生成异常狭小页面。
- 对大量节点、宽节点、深层级和显式行列提供可重复的自动化回归与真实 Visio 验收。

## 2. 范围与非目标

本模块包含：

- Main 侧确定性布局算法改造。
- 易标 Sidecar 本地扩展工具 `fit_page_to_drawing`。
- Renderer 调用顺序、能力检查、日志和 manifest 页面信息的必要同步。
- Sidecar 重新构建、源码/安装包校验以及真实 Visio 大图验收。

本模块不包含：

- 不要求模型输出最终 Visio 坐标，也不通过 Prompt 限制节点数量来规避问题。
- 不缩小节点或字体强行塞入单张 A4。
- 不自动拆成多页，不设计跨页连接线；多页拆分若有业务需求另立模块。
- 不改变 M07 计划编辑页面，不新增纸张尺寸、节点间距等前端配置项。
- 不修改 `DiagramPlan` v1 Schema；已有 `page.orientation` 继续表示基础画布方向。
- 不修改或替换已锁定的 `visio-mcp==0.1.2` 官方 wheel。

## 3. 根因与修复边界

当前流程为：

```text
DiagramPlan
  -> assignGrid 分配 row/column
  -> 固定 A4 可用宽高平均计算 step
  -> 固定宽高节点
  -> batch_draw_shapes / batch_connect_shapes
  -> save / export
```

问题发生在两个相邻边界：

1. 布局边界：平均 `horizontalStep` / `verticalStep` 没有最小值，也不考虑同一行、列中节点的实际最大尺寸。
2. 页面边界：即使 JS 生成了更宽、更高的坐标，当前 MCP 工具也不能确定性地扩展 Visio 绘图页面。

因此必须同时改造布局和页面适配，不能只做其中一层。

## 4. 动态轨道布局

### 4.1 网格分配保持不变

`calculateLayers()`、拓扑层级、横向图类型和显式 `row/column` 的优先级保持现状，先通过 `assignGrid()` 得到确定性的网格位置。M08-D 不改变节点之间的语义顺序。

### 4.2 行列轨道尺寸

对网格中的每一列和每一行分别计算轨道尺寸：

- `columnWidth[column]`：该列所有节点宽度的最大值。
- `rowHeight[row]`：该行所有节点高度的最大值。
- 未显式给出尺寸的节点继续使用 `DEFAULT_NODE_WIDTH` 和 `DEFAULT_NODE_HEIGHT`。
- 相邻列之间保留固定最小横向间距；相邻行之间保留固定最小纵向间距。
- 间距使用 Main 侧常量统一维护，不交给模型，也不在不同图表类型中散落重复值。

节点中心坐标按轨道累计计算：

```text
x = 左边距 + 前序列宽之和 + 前序列间距之和 + 当前列宽 / 2
y = 页面高度 - 上边距 - 前序行高之和 - 前序行间距之和 - 当前行高 / 2
```

这样节点数量增加时扩展画布，而不是压缩既有节点间距。显式宽高节点也会进入轨道最大值计算，不会侵占相邻轨道。

### 4.3 页面需求尺寸

布局输出增加计算后的页面需求，但不改变持久化的 `DiagramPlan`：

```text
requiredWidth  = 左右边距 + 所有列宽 + 所有列间距
requiredHeight = 上下边距 + 所有行高 + 所有行间距
pageWidth      = max(方向对应的 A4 基础宽度, requiredWidth)
pageHeight     = max(方向对应的 A4 基础高度, requiredHeight)
```

`layout.page.width/height` 表示本次实际绘图画布，`plan.page.orientation` 仍是用户编辑和持久化的语义字段。小图保持现有基础页面，大图只沿需要的方向扩展。

### 4.4 重叠诊断

布局模块提供纯函数级矩形边界检查，至少覆盖节点与节点的相交情况。它用于专项测试和渲染前布局故障日志，不对 Renderer 或 IPC 增加重复输入校验。

若程序自身生成的布局仍发生相交，渲染任务应在调用 MCP 绘图前失败，并记录发生冲突的节点 ID，避免生成表面成功但不可用的 VSDX。连接线交叉不属于节点重叠，不在本模块判为失败。

## 5. Sidecar 页面适配工具

### 5.1 本地扩展方式

保留 M08-A 的官方 wheel、版本和 SHA256。新增易标本地 Python 扩展模块，由 `client/sidecar/visio-mcp/entrypoint.py` 在启动上游 `mcp` 前注册 `fit_page_to_drawing` 工具：

```text
官方 visio-mcp 0.1.2 wheel
  + yibiao 本地页面扩展工具
  -> 既有 PyInstaller spec
  -> 新 visio-mcp.exe
```

这样不直接修改 site-packages、不在构建时对 wheel 做隐式 monkeypatch，也不改变上游哈希。manifest 必须记录扩展工具及新的 EXE SHA256。

### 5.2 工具契约

`fit_page_to_drawing` 参数：

- `doc_name`：当前文档名。
- `page`：目标页面，空值沿用当前页语义。
- `minimum_width` / `minimum_height`：布局计算出的最小画布尺寸，单位英寸。
- `margin`：绘图边界外的保留空间，单位英寸。

工具在全部节点、连接线和连线文字完成后执行：

1. 获取目标页面和实际图形边界。
2. 计算能覆盖实际边界、布局最小尺寸及保留边距的页面宽高。
3. 优先使用 Visio `Page.AutoSizeDrawing` 完成适应绘图。
4. 如果页面打印缩放配置导致 `AutoSizeDrawing` 不可用，则通过 PageSheet 的 `PageWidth` / `PageHeight` 写入计算结果作为确定性回退。
5. 返回页面名、调整前后尺寸、实际图形边界和采用的策略，供日志与验收使用。

工具只处理当前本地受信文档，不增加 Renderer 到 Main 各层之间的重复安全校验。COM 异常按现有 MCP 错误模型返回，不吞掉错误。

## 6. Renderer 调用顺序

渲染顺序调整为：

```text
create_diagram
  -> layoutDiagramPlan
  -> 布局重叠诊断
  -> batch_draw_shapes
  -> batch_connect_shapes
  -> set_shape_text（存在连线标签时）
  -> fit_page_to_drawing
  -> save_document_as
  -> export_page_as_image / get_page_summary
  -> close_document
```

`fit_page_to_drawing` 成为 Renderer 必需能力；bundled 与 custom Runtime 都必须在工具发现阶段提供它。旧 custom Runtime 缺少该工具时直接显示现有的能力缺失错误，不静默退回不可靠的固定页面布局。

调整失败时沿用现有临时修订目录和失败清理逻辑：不发布半成品，不覆盖上一版活动产物，并关闭当前 Visio 文档。

## 7. 测试与验收

### 7.1 纯函数与模拟 MCP

- 单行/单列大量节点：相邻矩形间距不小于设定值。
- 多分支深层级：拓扑方向和同层节点顺序保持确定。
- 显式宽高节点：轨道随最大节点扩展，邻接节点不相交。
- 显式 `row/column` 冲突消解后仍不重叠。
- 横向、纵向和交叉职能图类型均覆盖。
- 小图仍使用方向对应的 A4 基础尺寸。
- 大图返回扩展后的 `layout.page.width/height`。
- Renderer 在保存前调用 `fit_page_to_drawing`，并传入布局最小尺寸。
- 页面适配失败时不发布临时产物，上一版活动产物不受影响。
- capability 测试确认缺少新工具时给出明确错误。

### 7.2 Sidecar 与安装包

- Python 扩展工具单元测试覆盖 AutoSize 成功和 PageSheet 回退。
- `npm run prepare-visio-mcp` 生成新的 EXE、manifest 和哈希。
- `npm run verify-visio-mcp` 发现原 40 个上游工具及 `fit_page_to_drawing`。
- packaged verifier 确认 NSIS、ZIP、MSI 携带同一扩展版 Sidecar。
- macOS 继续不携带 Visio Sidecar。

### 7.3 Windows Visio 实机

至少准备以下固定夹具：

- 30 节点多分支流程图。
- 40 节点三层组织结构图。
- 含长中文文字和显式宽节点的块图。
- 横向层级较深的网络图。

逐项确认：

- VSDX 和 PNG 均非空，节点数、连线数与 manifest 一致。
- 节点矩形无相交，文字没有因节点重叠被遮挡。
- 页面完整包含所有节点和连接线，PNG 不裁切边缘内容。
- VSDX 打开后节点、连接线和文字仍可编辑。
- 成功、失败、取消和退出后无遗留文档或 Sidecar 进程。
- Windows 中文输出路径正常。

## 8. 实施、Git 与 TODO 边界

实施顺序固定为：

1. 布局纯函数、重叠诊断和专项测试。
2. Sidecar 本地扩展工具及 Python 测试。
3. Renderer 能力检查与调用顺序接入。
4. 重建并验证 bundled Sidecar 和安装包资源。
5. Windows Visio 大图实机验收。
6. 运行相关 CJS/Python 检查、M01-M08 回归和 `npm run build`。
7. 更新 `VISIO_MCP_TODO.md` 的 M08-D 验证记录并勾选。
8. 仅暂存 M08-D 文件，创建独立 Git 提交。

本设计文档提交只确认开发方案，不代表 M08-D 已实现；在代码、Sidecar、安装包和实机验收全部完成前，TODO 保持未勾选。

## 9. 参考依据

- [Microsoft Visio Page.AutoSizeDrawing](https://learn.microsoft.com/en-us/office/vba/api/visio.page.autosizedrawing)
- [Microsoft Visio 页面自动调整与适应绘图](https://support.microsoft.com/en-us/visio/change-the-page-setup-by-using-auto-size-or-selecting-size-and-orientation)
- [visio-mcp 0.1.2 工具清单](https://pypi.org/project/visio-mcp/0.1.2/)
