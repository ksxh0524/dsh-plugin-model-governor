/**
 * Commitlint 配置 - 强制 Conventional Commits（scope 按「模块/位置」组织，agent 从改动文件路径机械推导）。
 *
 * scope → 路径映射：
 *   cordis        → src/cordis.ts（服务注册 / Remote 契约 / 宿主接线）
 *   limiter       → src/limiter.ts（RPM/TPM/并发令牌桶与排队）
 *   sessionheader → src/session-header.ts（OpenCode x-opencode-session 兼容头）
 *   thinking      → src/thinking.ts（思考档位读出与覆盖写）
 *   errors        → src/errors.ts（错误翻译与可行动文案）
 *   config        → src/config.ts（配置类型/缺省/归一化/校验）
 *   client        → lib/client.js（浏览器半：Models 页 provider-card 扩展 + footer）
 *   tests         → tests/（仅测试改动时）
 *   infra         → 仓库工具链（.husky/、.github/、commitlint/prettier/tsconfig、package.json 的 scripts/devDeps）
 *   deps          → 依赖升级（pnpm-lock.yaml、dependencies 字段）
 *
 * 推导规则：
 *   - 特性跨模块 → 选主要 scope（契约类改动通常落 cordis）；只改 src 的其余文件按文件名选。
 *   - 多 scope / 无法判断 → 省略 scope。
 *   - 纯文档（README 双语、注释外文稿）→ type=docs 且省略 scope。
 *
 * subject 中英皆可（header ≤100，body 单行 ≤160）。
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 160],
    "scope-enum": [2, "always", ["cordis", "limiter", "sessionheader", "thinking", "errors", "config", "client", "tests", "infra", "deps"]],
    "scope-case": [2, "always", "lower-case"],
    // 中文 subject 常见，且允许 AI/API/SRC/GUI 等缩写开头：关掉大小写启发式。
    "subject-case": [0],
  },
};
