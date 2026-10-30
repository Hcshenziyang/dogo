# 参与约定

先阅读 AGENTS.md、PRODUCT.md、ARCHITECTURE.md、PLAN.md 和 STATUS.md。

当前优先实现 Python 后端，使用 FastAPI、SQLite 和 uv。未确认场景不得写成已批准需求，未验证接口不得写成已可用能力。

旧工程保存在仓库外及 Git 历史中，不恢复旧依赖、旧协议或历史兼容代码作为新实现的默认起点。需要参考或迁回代码时，保留仍适用的 `note-szy:` 人工笔记。

在 `server/` 执行 `uv sync --locked`、`uv run pytest -q`、`uv run ruff check src tests` 和 `uv run ruff format --check src tests`。真实配置、凭据、运行数据、虚拟环境和构建产物不得提交。DSH、手机和线上验证需单独记录，不能由服务端测试替代。
