# Changelog

所有重要的版本变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

## [0.1.0] - 2026-09-23

### Added

- 记录每次 provider 请求的首 token 延迟与输出速率，追加写入 JSONL
- 首 token 延迟拆分为 `ttftMs`（含网络与排队）与 `serverTtftMs`（服务端生成）
- 思考段与可见输出段分别统计生成时间与速率，交错流下互不重叠
- provider 未上报 `reasoning` 时给出整体速率
