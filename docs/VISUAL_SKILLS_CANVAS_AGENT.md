# 画布 Agent 视觉 Skill 接入说明

更新时间：2026-09-02

## 目标与边界

本次改动把视觉工作台中已经验证的视觉能力复刻到 HowCanvas 的“画布 Agent”中。改动对象是画布页面内的 **Skill + LLM** Agent，不是视觉工作台页面本身，也不要求用户离开画布去手动复制 Prompt。

视觉 Skill 负责提供任务拆解、Prompt 约束和路由策略；画布 Agent 的现有工具负责读取画布、创建节点、编排生成流程、提交生成和查询异步状态。Skill 本身不会绕过确认流程，也不会直接持有上游 API Key。

v0.12.5 同时把当前画布选区的安全摘要传入本地 Agent 和服务器 Skill + LLM 对话，并在输入区与已发送消息中显示节点类型图标。生产部署、回滚和未完成验收以 [2026-09-02 Canvas Agent 修改档案](CHANGE_ARCHIVE_2026-09-02_CANVAS_AGENT.md) 为准。

## 可用 Skill

| ID | 用途 |
| --- | --- |
| `visual-workbench-controller` | 视觉任务总控：在生成、优化和视觉建议之间路由，并要求先读取事实、再执行和复盘。 |
| `visual-prompt-optimizer` | 将用户约束、参考图事实和摄影策略编译为无冲突、可执行的 Prompt。 |
| `visual-image-generator` | 校验已定稿 Prompt、参考图、比例、张数和 Provider 参数后执行图像生成。 |
| `chinese-fairyland-suite` | 天宫、悬山、云海水境、东方巨物等中式仙境专项。 |
| `oscar-director-cinematography` | 将导演/类型片意图转译为叙事瞬间、调度、摄影、光色和有限色板。 |
| `fantasy-photo-utility` | 旧照片诗意修复、车窗/舷窗旅行风景、极简 Logo/符号三类明确模式。 |
| `fantasy-visual-studio-suite` | FANTASY Visual Studio 的 Portrait、Editorial、Cinematic、Cultural Poster、Fun Social、Photo Utility 六套工作流。 |

## 结构化提示词库

完整手册已整理为插件内的 [`prompt-library.json`](../plugins/infinite-canvas/skills/visual-workbench/prompt-library.json)。它同时承担两项职责：

- `agentContract`：任务模式、参考图规则、Prompt 编译顺序、冲突消解、输出契约和通用负面约束；
- `routes`：仙宫、Oscar 导演和 FANTASY 三类路由的字段、正向词池、世界/套件模板、负面词池和失败修复句。

Agent 不应整段照抄库文件，而应先选择一个主路由（FANTASY 再选择一个套件），按编译顺序组装最小 Prompt，并从对应 `repairPool` 追加不超过三条修复句。手册新增案例或词组时，先更新该 JSON 的结构化字段，再同步 Skill 说明。

## 实际调用入口

入口是发给 Agent LLM 的函数工具 `skill`，不是单独的前端按钮。模型可调用：

```json
{
  "name": "skill",
  "arguments": {
    "name": "visual-workbench-controller"
  }
}
```

执行成功后返回 `ok`、`loaded`、Skill ID、显示名称和执行说明。未在管理员配置中启用的 ID 会被拒绝；未知 ID 也会被拒绝。画布消息区会显示“加载视觉 Skill”和“已加载……”，便于审计本轮调用。

推荐调用顺序：

1. 先加载 `visual-workbench-controller`；
2. 根据任务最小化加载 `visual-prompt-optimizer`、`visual-image-generator` 或一个风格专项；
3. 调用 `canvas_get_state`/附件工具读取真实事实；
4. 使用 `canvas_create_generation_flow`、`canvas_run_generation` 等现有画布工具；
5. 使用 `generation_get_status` 查询真实异步状态，不能把“已提交”描述为“已完成”。

## 配置与工具白名单

Skill ID 在以下位置必须保持一致：

- `web/src/services/api/backend.ts`：`AgentSkillId` 类型；
- `web/src/lib/agent/agent-llm-skills.ts`：标签、指令、能力映射和 `skill` 工具定义；
- `web/src/components/canvas/canvas-local-agent-panel.tsx`：工具执行、确认和消息摘要；
- `web/src/pages/admin/index.tsx`：管理员配置选项；
- `server/index.mjs`：后端允许列表、默认值和保存时过滤。

视觉 Skill 通过能力映射复用既有的 `image-creation`、`video-creation`、`canvas-orchestration`、`quality-review` 工具，不重复实现生成接口。生产配置位于服务器 `server-data/settings.json`，应通过管理员后台维护，不要把运行时配置写入 Git。

## 新增或修改 Skill 的流程

1. 在 `AgentSkillId`、后端允许列表和管理员选项中增加 ID；
2. 在 `SKILL_PROMPTS` 写清边界、输入事实、输出契约和禁止行为；
3. 如需调用既有工具，在 `VISUAL_SKILL_CAPABILITIES` 中声明最小能力集合；
4. 只将需要的 ID 放入 `VISUAL_AGENT_SKILL_IDS`，让 `skill` 的 JSON Schema 自动限制可调用范围；
5. 更新 `plugins/infinite-canvas/skills/visual-workbench/SKILL.md` 与本文件；
6. 运行类型检查、前端构建和受影响测试，再部署并验证健康检查。

## 本地验证

```bash
cd web
npm run typecheck
npm run build

cd ..
npm run test:server
npm run test:agent
```

构建出现 Vite 动态导入或 chunk 大小提示不代表失败，必须以最终 `built` 和命令退出码为准。

## 安全与限制

- 画布写操作、触发生成、工作台生成和资产写入继续遵循用户确认；
- 前端不保存或暴露上游 API Key；
- 工具返回值是任务状态的唯一权威来源；
- 当前没有可视化 Skill 菜单，入口是 LLM 函数工具和消息审计记录；
- 七个视觉 Skill 是对工作台能力的画布侧精炼契约，不等同于把工作台目录中的全部文件动态挂载到浏览器；其中 `fantasy-visual-studio-suite` 使用结构化提示词库覆盖 FANTASY 六套工作流，`fantasy-photo-utility` 保留为旧配置兼容入口；
- `npm run test:agent` 在 Windows 上仍有一个既有的目录权限模式断言失败（`438 !== 448`），与本次画布 Skill 改动无关。
- 服务器“方案三：Skill + LLM”已与 `@basketikun/canvas-agent` 脱钩，选区上下文由主站前端直接传给服务器 AI 代理；`@basketikun/canvas-agent` 仅用于可选的本地 Codex/Claude 桥接模式，版本发布与本次服务器上线独立。
