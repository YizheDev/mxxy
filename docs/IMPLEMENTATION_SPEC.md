# 离线单人版实现规格

本文定义后续代码必须满足的行为。它不是当前完成声明；当前状态以 `HANDOFF.md` 为准。

## 设计原则

- 本地权威：所有账号、货币、背包、宠物、抽奖、合宠、战斗和活动状态由本机数据层决定。
- 完全隔离：应用不依赖第三方认证、网关、补丁、支付、分析或上报服务。
- 原子事务：显示成功之前，状态变化和审计事件必须一起持久化。
- 可重放：随机操作记录 seed/RNG 版本、配置版本和输入快照，便于复现与迁移。
- 明确分叉：独立包名、签名、存档目录和离线标识，不能覆盖或伪装成在线版本。
- 渐进兼容：先用一个宠物、一个卡池、一个合宠公式、一场战斗闭环证明架构，再扩资源覆盖。

## 模块边界

```text
原 UI / Messiah 渲染层
          |
          v
Offline Game Facade（替代登录、商城、玩法协议边界）
          |
  +-------+--------+----------+----------+
  |                |          |          |
Pet Catalog     Economy     Fusion     Battle
  |                |          |          |
  +----------------+----------+----------+
                   |
             Local Store
        snapshot + event journal
```

旧客户端若强依赖请求/响应对象，Facade 可在进程内提供同构 DTO，但不监听公网端口，也不模拟第三方支付。

## 本地数据模型草案

| 表/实体 | 关键字段 | 不变量 |
|---|---|---|
| `profile` | id, name, created_at, schema_version | 单机默认一个 profile；支持未来多存档 |
| `wallet_balance` | profile_id, currency, amount, revision | amount 不小于 0；免费模式可不扣除 |
| `inventory_stack` | profile_id, item_id, quantity, revision | 唯一键 profile+item；数量不小于 0 |
| `pet_instance` | uuid, species_id, level, stats_json, skills_json, appearance_id, revision | 结果快照完整、自包含、可迁移 |
| `gacha_state` | pool_id, pity_count, guarantee_flags, config_version | 每次抽奖与奖励同事务更新 |
| `battle_snapshot` | battle_id, turn, state_json, rng_state, status | 行动前后可恢复；结算最多一次 |
| `event_journal` | event_id, request_id, type, input_json, output_json, created_at | request_id 唯一，支持幂等/审计 |
| `save_meta` | schema_version, content_version, last_commit, checksum | 写入后校验；迁移可回滚 |

实现可使用 SQLite + WAL。关键事务完成后生成周期性快照；更新先写临时文件/事务，崩溃不得留下半个宠物或已显示成功但未发奖的状态。

## 宠物目录与展示

`PetCatalogEntry` 最小字段：

```text
species_id, display_name, model_ref, skeleton_ref, material_refs,
idle_action, attack_action, hit_action, death_action,
portrait_ref, skill_icon_refs, source_pack, coverage_status
```

覆盖状态必须逐宠物计算：`complete`、`missing_config`、`missing_model`、`missing_material`、`missing_action`、`missing_icon`。不能因为组名存在就标 complete。

验收：冷启动后从本地目录选择一个宠物，在目标设备上正确显示 idle、攻击、受击和死亡动作；重启后仍显示相同实例和技能。

## 抽奖

配置包括卡池、权重、稀有度、保底阈值、UP 规则、重复转换和版本。推荐确定性 PRNG，状态保存在 `gacha_state`。

单次事务：

1. 以唯一 `request_id` 读取卡池和保底状态。
2. 生成并记录 RNG 输入/输出。
3. 计算奖励与新保底状态。
4. 写宠物/背包、保底和 `event_journal`。
5. commit 后才调用原抽奖结果 UI。

重复 request 必须返回原结果，不重复发奖。

## 合宠

公式版本化；输入为两个不可变宠物快照，输出包含 species、外观、资质、成长、技能列表和 RNG 记录。最低规则可自定义为：

- 外观从父母候选与配置权重抽取。
- 基础资质按父母加权均值 + 有界扰动。
- 技能先去重，再按继承权重抽取，保留上下限。
- 稀有技能和必带技能由规则表控制。

事务必须验证父母仍存在且版本未变化；消费/保留父母、生成新宠物和日志一次提交。结果必须能直接传入相同宠物展示管线。

## 个人战斗

第一个里程碑只做：玩家单宠/角色对固定敌人，回合选择普通攻击/一个技能，敌人使用确定性 AI，结算经验和道具。

状态机：

```text
Created -> LoadingAssets -> PlayerTurn -> EnemyTurn
        -> (PlayerTurn | Victory | Defeat) -> RewardCommitted -> Closed
```

每个 action 写入 journal，伤害公式/技能配置/RNG 版本可追踪。`RewardCommitted` 只能发生一次，崩溃重进能从最后完整回合恢复或安全回滚。

## 免费商城

- 真实支付 SDK、订单页、回调和第三方地址全部禁用。
- UI 显示“免费领取”或价格 0，不显示伪造支付成功。
- 点击产生本地 `purchase` 事务：验证商品 → 写背包/宠物 → 写零金额事件 → commit → 刷新 UI。
- request_id 唯一，重复点击不重复发货。
- 可选无限货币模式仍必须保留库存事务和审计日志。

## 网络隔离要求

最终包：

- 删除 INTERNET 权限，或在必须保留本机 IPC 的技术约束下，用 Network Security Config/代码双重拒绝非 loopback；优先删除权限。
- 删除第三方域名、认证、资源补丁、统计和支付初始化。
- 禁止 WebView/SDK 间接联网；以代理/DNS 黑洞和系统网络统计做负向测试。
- 首次启动不需要隐私/登录/补丁网络步骤，直接进入本地 profile。

## 进入实现阶段的门槛

审计阶段进入 Android 实现前必须证明：

1. 一个 `PetCatalogEntry` 的所有引用可定位、解码并在 Messiah 管线渲染。
2. shapeconfig 缺失的实际范围可枚举，且有合法的本地补齐或兼容策略。
3. 已识别至少一个可替换的 UI→业务边界，不需要伪造远端返回。
4. 已确定构建路线：可维护的重打包/注入方案或独立 Android 外壳，并能重复签名安装。

随后按以下交付门槛推进：

| Gate | 必须通过的证据 |
|---|---|
| G1 宠物 | 完整资源链 + 实机/兼容环境动画录像/日志 |
| G2 存档 | 创建实例，杀进程/重启/升级 schema 后一致 |
| G3 抽奖 | 权重测试、保底边界、崩溃/重复请求事务测试 |
| G4 合宠 | 固定 seed 可复现，结果展示/战斗/重载一致 |
| G5 战斗 | 固定敌人从加载到奖励提交完整闭环 |
| G6 APK | 干净设备安装、离线启动、无第三方网络、独立签名 |

G1–G6 未全部通过，README 必须继续写“不可直接畅玩”。
