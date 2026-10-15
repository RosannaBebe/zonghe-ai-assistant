# 综合管理 AI 智能助手

企业内部智能体搭建比赛的 Web 产品，聚焦经营管理赛道的降本增效。输入一个会务目标，由智能体规划步骤，再调用本地业务工具完成“会前准备 → 五类材料 → 会议纪要 → 人工审核 → 督办”，配套政务信息、公文助手和本地知识库。仓库使用虚构示例资料，不包含原始方案文件或真实企业数据。

代码仓库：<https://github.com/RosannaBebe/zonghe-ai-assistant>。GitHub Pages：<https://rosannabebe.github.io/zonghe-ai-assistant/>。

## 本地运行

需要 Node.js 20 或更新版本，在项目目录运行：

```sh
npm run dev
```

打开 <http://localhost:4173>。无需模型密钥即可演示页面流程；数据存储在当前浏览器 localStorage。运行检查：

```sh
npm test
```

## 演示能力

- 智能体：业务目标 → 工具计划 → 本地执行 → 人工确认 → 继续执行。连接真实服务时，由 DeepSeek 通过 function calling 选择工具；示例模式采用明确标识的本地计划。
- 会务：人员整理与排序确认、议程、会议室及圆桌席位，参会名单、议程、手册、名签和座位图材料。
- 纪要与督办：草稿编辑、人工审核、事项跟进；相关资料变化后需要重新确认。
- 政务信息：材料检查、人工核实、主任审阅、审核通过、导出报送材料包。
- 公文与知识库：文稿起草校对、模板与导出，以及当前浏览器中的资料搜索和维护。

示例模式的生成内容使用本地规则或示例，不能视为真实大模型输出。状态和角色用于演示业务流程，不提供真正的多用户权限、服务器审批或审计。导出材料包不等于报送石化通；二维码签到、预约会议室和 Pad 同步也未接入。

智能体只可使用查找人员、整理顺序、检查议程、生成材料、整理纪要、提取督办这六个工具。生成材料前须人工确认人员排序，提取督办前须人工审核纪要。模型返回的工具计划不代表工具已经执行；不支持的目标会提示调整，不伪造完成结果。

降本增效指标应通过同一任务的人工基线和辅助后实测进行比较。演示中的用时、节省工时或成本换算若没有真实样本，均应作为估算，不作为已取得的经营成果。

完整产品取舍与五分钟讲解见 [产品设计与参赛演示](docs/产品设计与参赛演示.md)。

## 可选：连接真实 DeepSeek

GitHub Pages 只能托管静态网页。需要真实模型时，将 `server/ai-proxy.mjs` 单独运行在本机或企业服务器上，网页通过这个服务调用 DeepSeek。

1. 将 `server/.env.example` 复制为 `server/.env`，填写 `DEEPSEEK_API_KEY`，设置随机的 `DEMO_ACCESS_TOKEN`（至少 24 个字符）。密钥只放在服务端，不提交 Git，不填入网页。
2. 使用 Node.js 20.6 或更新版本启动：

   ```sh
   npm run server
   ```

   此命令读取 `server/.env`。如果运行环境已注入这些环境变量，也可执行 `node server/ai-proxy.mjs`。
3. 在网页连接设置中填写完整接口地址 `http://127.0.0.1:8787/api/generate` 和上述访问口令。口令只保留在当前浏览器会话。
4. 本地网页须从 `http://localhost:4173` 打开。使用其他来源时，将该来源精确加入服务端 `ALLOWED_ORIGIN`，多个来源以逗号分隔，不含路径或末尾斜杠。

默认仅监听 `127.0.0.1`。对外部署时设置 `HOST=0.0.0.0`，配置 HTTPS 和访问口令，并把 `ALLOWED_ORIGIN` 设为网页来源，例如 `https://rosannabebe.github.io`。公开的 HTTPS 网页不能调用未加密的远程 HTTP 服务；网页设置中应填写部署后的 HTTPS 完整接口地址。

`GET /health` 返回服务存活状态，不会返回密钥。两类模型接口共用口令、来源限制与超时处理：

- `POST /api/generate`：接受 `task`（`minutes` / `draft` / `news-check`）、`input` 和可选对象 `context`，返回 `{text, mode: "deepseek", model}`。
- `POST /api/agent`：接受 `goal` 和 `context`（会议背景、基础参会信息、是否已有纪要），返回 `{summary, steps: [{tool, label, reason}], mode: "deepseek", model}`。通过真实 DeepSeek `tool_calls` 规划，服务端检验白名单、顺序与参数；网页实际执行本地工具。网页会根据生成接口地址自动找到同一服务的智能体接口。

启用访问口令后必须携带 `Authorization: Bearer <口令>`。单次生成材料上限 18,000 字符，智能体目标上限 4,000 字符，背景信息上限 8,000 字符，请求体上限 64 KiB。智能体规划仅接收会议与参会人员基础身份字段，不发送接待忌口等备注。服务不记录业务文字或密钥；模型无法联网验证新闻，也不会执行审批与报送。

连接真实模型时，请仅使用允许发送到该模型服务的材料。转发服务具备基础鉴权、来源限制和超时处理，仍是演示接入组件；正式共享使用需由企业补充账号权限和使用额度管理。

## 部署到 GitHub Pages

本项目为无需前端依赖的静态网页，可直接从仓库根目录部署。

1. 推送项目到 main 分支。
2. 在仓库 **Settings → Pages → Build and deployment** 选择 **Deploy from a branch**。
3. 选择 **main / (root)** 并保存，等待 GitHub Pages 构建完成。

可选的自定义 Actions 示例保存在 `docs/deployment/github-actions-example.yml`，需要时复制到 `.github/workflows/`。当前发布使用 GitHub 内置 Pages 构建，无需给访问令牌增加 workflow 权限。

Pages 不运行 `server/ai-proxy.mjs`。真实模型由单独部署的服务端处理。`.env`、本地口令文件和原始方案均不进入仓库。该展示页使用虚构数据，GitHub Pages 本身不是企业内网或企业身份验证方案。

## 在线模型连接

网页“模型与数据设置”已预填在线接口 `https://zhixing-agent-gateway.rosannabebe.chatgpt.site/api/generate`。填写参赛组访问口令并确认数据发送范围后，任务规划和文本生成使用真实 DeepSeek。口令只保存在当前浏览器会话，关闭会话后需重新输入。

访问口令单独保存在项目所有者本地的 `server/访问信息.local.txt`，该文件被 Git 忽略，不随仓库或静态网页发布。只向获准的参赛成员分享口令。未连接服务时，界面明确使用规则演示模式。

原方案中的“DeepSeek Harness”未提供可执行接口定义；本项目实现的是明确可配置的 DeepSeek API 转发，不宣称已接入未定义的 Harness、企业知识平台或生产工作流。
