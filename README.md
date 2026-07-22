# MXXY 离线单人版研究与实现

本仓库用于在用户拥有并授权分析的 `kktkky-MXXY_M-1.563.apk` 基础上，研究并实现完全离线、仅本机存档的个人版本。目标玩法包括宠物展示、抽奖、合宠、个人战斗和本地免费商城。

当前状态：**实现前审计进行中，尚不能直接构建或安装离线 APK。** 已经恢复资源容器结构、核心运行时 DEX、部分补丁和资源依赖，并验证本地渲染引擎能在断网环境初始化；尚未恢复完整的宠物 ID—模型—动作映射，也尚未实现本地权威数据层。

新设备或新 Agent 的唯一入口是 [docs/HANDOFF.md](docs/HANDOFF.md)。它记录目标、证据、完成项、问题、决策、下一步和验收门槛。不要只根据某一份历史报告判断当前进度。

## 安全与授权边界

- 只分析用户提供并授权的 APK 和本地运行数据。
- 动态测试必须保持第三方服务器隔离，不探测、不登录、不写入第三方服务。
- 不伪造第三方支付结果，不修改第三方数据库。免费购买将作为离线世界的本地业务事务实现。
- 最终包必须使用独立包名、独立签名和清晰的“离线个人版”标识，并关闭真实支付和第三方地址。
- 原始 APK、资源包、DEX、SO、设备日志和标识符不进入普通 Git；仓库只保存代码、脱敏文档、校验和和可重复生成步骤。

## 仓库结构

```text
docs/
  HANDOFF.md                 当前状态的唯一权威入口
  ENVIRONMENT_RUNBOOK.md     新设备复现环境和审计步骤
  DYNAMIC_AUDIT_LOG.md       动态实验记录与故障处理
  IMPLEMENTATION_SPEC.md     离线功能、数据模型和验收规格
  GIT_AND_MIGRATION.md       Git、制品和换机续接规范
  STATIC_ANALYSIS.md         初始静态报告，持续校正
  OFFLINE_RESOURCE_AUDIT.md  资源审计报告
  LEGACY_SERVER_ROADMAP.md   历史方案，仅供证据回溯
scripts/android/             只读解析、Frida 抓取和追踪脚本
artifacts/manifests/         授权输入与派生产物的哈希清单
```

## 快速校验

```bash
make verify
```

有解包后的 `HashRes` 时，可运行：

```bash
make inventory HASHRES_DIR=/absolute/path/to/HashRes
```

`make verify` 只验证仓库工具，不表示 APK 已可构建。当前不存在 Android Gradle 工程和 `make apk` 目标；达到 [实现门槛](docs/IMPLEMENTATION_SPEC.md#进入实现阶段的门槛) 后才会建立可签名、可测试、可重复构建的 Android 工程。

## 换机继续

克隆本仓库后，按 [docs/GIT_AND_MIGRATION.md](docs/GIT_AND_MIGRATION.md) 准备 APK/私有派生产物，再执行 [docs/ENVIRONMENT_RUNBOOK.md](docs/ENVIRONMENT_RUNBOOK.md)。原 APK 必须匹配：

```text
d520f56c541cb2400f7cf0048a66f328a91355f292425f3afba532c568bd0543
```

项目远端目标为 `https://github.com/YizheDev/mxxy.git`。私有仓库需要在新设备配置有权限的 GitHub 凭据。
