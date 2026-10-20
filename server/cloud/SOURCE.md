# 独立备用后端来源

`lib/gateway.ts` 与 `lib/feedback.ts` 复制自现有 `zonghe-ai-gateway` 项目的同名文件，来源提交为 `609f3eb362669904d311990ec3528db5dd190a8a`（短 SHA：`609f3eb`）。复制范围仅限这两个纯 HTTP 处理器；未从来源项目复制环境文件、密钥、Sites 配置或页面源码。

`gateway.ts` 仍为原样副本。`feedback.ts` 在副本中增加了可选 `rateLimits` 配置及其正整数校验、可覆盖的票据/提交额度，以及独立于 IP 限流 Map 的全局提交桶。未提供配置时仍沿用原来的每 IP 20 次票据/10 分钟、6 次提交/10 分钟、60 次管理读取/分钟，且没有全局提交桶限制。票据签名与有效期、Origin/UUID 绑定、管理口令、GitHub 存储、请求体限制和原上游超时均保持不变；原 Sites 项目未被修改。

`adapter.mjs` 是本目录新增的 Node HTTP 入口。它直接调用本地处理器；不请求或代理 `chatgpt.site`。Node 22.18 及以上通过原生类型擦除加载 `.ts`，不安装 TypeScript 或其他运行依赖。启动命令：`node server/cloud/adapter.mjs`。本目录也可单独运行 `npm start` 与 `npm test`。

业务环境变量名称与原服务一致，Node 入口额外提供一个显式代理开关：

- 监听：`HOST` 默认 `0.0.0.0`，`PORT` 默认 `10000`。
- 网页来源：`ALLOWED_ORIGIN` 为逗号分隔的完整来源；不得包含路径、末尾斜杠或通配符。
- AI：`DEEPSEEK_API_KEY`、`DEMO_ACCESS_TOKEN`（至少 24 字符）、`DEEPSEEK_MODEL`（默认 `deepseek-chat`）。
- 反馈：`FEEDBACK_GITHUB_TOKEN`、`FEEDBACK_REPOSITORY`（`owner/repository`）、`FEEDBACK_ADMIN_TOKEN`（至少 24 字符）、`FEEDBACK_SIGNING_SECRET`（至少 32 字符）。反馈存储须使用启用 Issues 的私有仓库，令牌应只授权该仓库所需的读取与 Issues 读写权限。
- 代理：`TRUST_RENDER_EDGE=true` 仅用于本文约束下的 Render Free 公网 Web Service；其他值或省略均保持默认 socket 模式。不会因平台自动注入 `RENDER` 就启用信任。

`GET /` 提供适配手机的中文连接检查页；`GET /health` 只表示进程存活，均不显示配置值。健康检查成功不保证第三方服务凭据可用。AI 或反馈配置缺失时，由对应业务接口返回 503，不阻止另一个功能和健康页启动。

业务路由为 `/api/generate`、`/api/agent`、`/api/feedback`、`/api/feedback-ticket`。原处理器保留鉴权、精确 CORS、HMAC 票据、人工确认规划边界和字节流上限。Node 层补上请求超时、连接断开取消以及早期拒绝时可读取的 JSON 错误。默认请求体期限 20 秒、整个请求期限 60 秒；处理器中的 AI 45 秒和 GitHub 15 秒上游期限保持原样。

## 代理与反馈存储边界

默认模式使用实际 TCP 连接的 `socket.remoteAddress` 作为反馈限流身份，覆盖传给处理器的 `CF-Connecting-IP`，不信任客户端传入的任何代理 IP 头。若把默认模式放在共享反向代理后，多名用户可能共用限流桶。

显式设置 `TRUST_RENDER_EDGE=true` 时，仅对反馈路由采用 Render 公网边缘提供的 `CF-Connecting-IP`。依据为 Render 官方文章 [Host PocketBase on Render](https://render.com/articles/host-pocketbase-on-render) 的 “Making PocketBase see the real client IP” 段落：公网请求经过 Cloudflare 与 Render 负载均衡，Cloudflare 覆盖客户端传入的 `CF-Connecting-IP`；`X-Forwarded-For` 左侧值可由客户端伪造。Render 的 [Private Networking](https://render.com/docs/private-network) 文档另说明 Free Web Service 不能接收入站私网流量。基于这两个前提，此开关只允许用于 Render Free 公网 Web Service。

适配器只接受 `isIP` 验证通过的单值 `CF-Connecting-IP`；缺失、重复/逗号列表或无效值会让反馈接口返回明确的 503 `FEEDBACK_PROXY_MISCONFIGURED`，不会回落到其他头或 socket 地址。健康页与 AI 接口仍可使用。所有模式都不信任 `X-Forwarded-For`、`X-Real-IP` 或 `Forwarded`。这些 IP 仅作限流键，不证明用户身份，也不替代 HMAC 票据、Origin 校验或管理口令。

此 opt-in 是维护者对部署入口的明确确认，代码不能验证服务套餐或网络拓扑。它不适用于私网入口、可绕过 Render 边缘的直连、其他平台或本机对外部署；升级为可接收入站私网的套餐或改变入口后，须先关闭开关并重新评估可信来源。不要在这些环境仅因为存在一个名为 `CF-Connecting-IP` 的头就启用信任。

Render opt-in 模式为集体试用配置每个边缘 IP 120 次票据/10 分钟、60 次反馈提交/10 分钟，管理读取仍为 60 次/分钟。同一 Wi-Fi/NAT 的用户仍共享 IP，但不再受默认 6 次提交额度限制。另有独立的全局进程 200 次提交/10 分钟兜底，不会因 IP Map 达到容量而被淘汰。额度按通过 IP 限流的提交请求尝试计数，后续票据/内容校验失败也会计数；已被 IP 限额拒绝的请求不消耗全局额度。达到全局额度后，即使换 IP 也不能继续提交，健康页、票据和管理读取仍独立可用。

调用 GitHub Issues 前，适配器用同一个令牌读取固定仓库的 metadata，仅允许 `private: true` 且仓库全名匹配；明确禁用 Issues 的仓库也会被拒绝。成功校验只在当前进程缓存 60 秒，所有请求使用 `redirect: manual`，不跟随重定向、不把令牌转发到其他地址。仓库改成公开后，缓存到期前存在至多 60 秒的检测延迟，因此部署后仍应保持仓库私有。

原反馈处理器的限流、锁和去重缓存均只在当前进程有效。重启会清空缓存，多实例无法保证全局限流或严格幂等；最近 100 条 Issue 检查仅提供尽力去重。此版本适合参赛与小规模内测，建议单实例。用户反馈只写入配置的私有 GitHub Issues，普通提交结果不会返回仓库链接。

测试命令：`node --test server/cloud/tests/*.test.mjs`。测试只使用本机临时端口与注入的假上游，不读取环境文件，不调用真实 DeepSeek 或 GitHub。
