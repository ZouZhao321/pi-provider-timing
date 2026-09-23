# Changelog

所有重要的版本变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

## [0.2.0] - 2026-09-23

### Added

- 新增诊断日志 `plugin.log`：默认记录扩展加载、会话开始、异常路径与写入失败
- 新增环境变量 `PI_PROVIDER_TIMING_DEBUG=1`，打开后追加逐事件、逐请求、逐增量的细节
- 写入 `requests.jsonl` 失败时先记一条 `write-failed` 再重新抛出原错误
- 跟踪器的异常路径（无活跃请求时收到增量、`reasoning` 大于 `output`）通过回调上报

## [0.1.0] - 2026-09-23

### Added

- 记录每次 provider 请求的首 token 延迟与输出速率，追加写入 JSONL
- 首 token 延迟拆分为 `ttftMs`（含网络与排队）与 `serverTtftMs`（服务端生成）
- 思考段与可见输出段分别统计生成时间与速率，交错流下互不重叠
- provider 未上报 `reasoning` 时给出整体速率
