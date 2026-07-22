# MXXY 离线单人版交接总览

```yaml
project: mxxy-offline-single-player
last_verified: 2026-07-22
phase: implementation-readiness-audit
overall_status: partial
buildable_apk: false
authoritative_input_sha256: d520f56c541cb2400f7cf0048a66f328a91355f292425f3afba532c568bd0543
```

## 一、最终目标

基于用户拥有并授权的 `kktkky-MXXY_M-1.563.apk`，最大限度复用现有宠物、人物、场景、UI、动画和特效，做成不访问任何第三方服务、数据仅保存在本机的单人 APK。核心体验为：

- 宠物模型、材质、动作、头像和技能图标正确显示。
- 抽奖概率、卡池和保底可本地配置，结果事务性写入本地存档。
- 合宠公式、资质/技能继承和随机规则可自定义，结果可展示、战斗和持久化。
- 能完成固定敌人开始的个人回合战斗闭环，并逐步扩充技能、AI 和地图。
- 商城不调用真实支付，本地价格为零或使用无限本地货币，购买与背包更新是同一事务。
- 活动仅保留可单人化部分，使用本地日历和静态配置。

“视觉和主要单人交互尽量一致”是可验证目标；实时运营、跨服、排行榜、官方账号资产和远程活动状态不属于离线一致性承诺。

## 二、当前结论

当前不能直接打包离线 APK。已证明客户端携带大量可复用资源，核心 DEX 可在受控环境恢复，Messiah 本地渲染管线可以离线初始化；但宠物资源映射和若干 `shapeconfig` 补丁仍未恢复，服务器权威的玩法数据层也尚未本地化。

| 要求 | 状态 | 当前证据 | 缺口 |
|---|---|---|---|
| 资源容器可读 | verified | 21 IDX、36 WPK、153,400 条边界全部验证 | RC4/XXH 语义和路径 ID 未解 |
| 补丁目录可枚举 | verified | 194 THI/THX、604,222 条固定记录 | 记录字段语义/ID 映射未解 |
| 核心 DEX 可恢复 | verified | 标准 DEX 8,763,836 bytes，JADX 得到 3,141 Java 文件 | 少量反编译错误；核心玩法多在 native/脚本 |
| 本地渲染引擎启动 | verified | 断网启动 `libGame.so`，生成本地 shader cache | 尚未进入可控宠物场景 |
| 宠物资源存在 | partial | `repository`、`res_shape`、`shapeconfig`、技能图标等清单 | 宠物 ID—模型—材质—动作链未闭合；部分补丁在远端 |
| 抽奖可离线实现 | partial | UI、图标、JSON/脚本候选存在 | 卡池/动画调用链和本地事务未实现 |
| 合宠可离线实现 | partial | 宠物形状与技能资源存在 | 原对象格式、展示入口、公式事务未实现 |
| 个人战斗可离线实现 | partial | 战斗特效、杂项、地图/引擎资源存在 | 状态机、AI、伤害和奖励边界未本地化 |
| 本地存档 | unknown | 尚无实现 | 需要 schema、迁移、校验、原子提交和恢复测试 |
| 可构建安装 APK | unknown | 尚无 Gradle/重打包实现 | 必须先通过下述实现门槛 |

## 三、已完成工作与证据

### 3.1 样本和保护层

- 样本约 1.92 GiB，包名 `com.netease.my`，内部 `versionName=1.555.0`、`versionCode=15550`，文件名标称 1.563。
- ARM64 与 armeabi-v7a 原生库同时存在；应用由 NetEase StubApp/UniSec/UniFix 保护。
- `_ntcfgss.dat` 会被复制为私有目录 `.unzip/classes.dex`，初始内容不是标准 DEX。
- 动态 DEX 扫描在进程内导出 48 个标准 DEX（总计 119,663,024 bytes）；核心标准 DEX SHA-256 为 `62de0096...debc`。
- 核心类包括 `PatchListCore`、`PatchListProxy`、`MessiahNativeActivity`、`SdkController`。

### 3.2 WPK/IDX 资源

- IDX：36-byte `SKPW` header + `count * 28-byte` records。
- 每条记录含 12-byte opaque path ID、stored size、offset、从 1 开始的 WPK part 和 32-bit check/hash。
- 21 个 IDX、36 个 WPK、153,400 个条目；所有物理边界通过校验。
- 存储 payload 合计 1,837,237,235 bytes：RC4 35,917、image 24,405、Messiah 2,247、other g18xxh 23,199、texture 67,632。
- 已从仓库资源恢复部分路径字符串，例如 `3dshapes/0004/07/chibang`、`3dshapes/4085/weapon1.gim`、`3dshapes\\6006\\6006.mesh` 及 `/npc/...`。
- 72,869 条可读路径候选扩展成 617,905 变体，对 MD5/SHA1/SHA256/XXH3-128/多种 64+32 组合做过匹配，命中为零。不要重复无种子的通用哈希穷举。

### 3.3 THI/THX 补丁目录

- THI：`THDX` + 12-byte tail + N × 12-byte opaque records。
- THX：`THDO` + 72-byte tail + N × 28-byte opaque records。
- 194 个文件，604,222 条记录。
- 关键计数：`shapeconfig.thx=38,138`、`res_shape.thx=19,415`、`res_item.thx=11,311`、`res_skillicon.thx=1,700`、`res_fight_misc.thx=60`、`Json.thx=24,566`、`script.thx=12,522`、`repository.thx=60,184`。
- 多数 THX 清单条目多于 APK 中 WPK 条目，证明基础包不等于完整远程补丁集。

### 3.4 隔离动态实验

- Apple Silicon 主机、Android 11/API 30 ARM64 rootable AVD；安装后立即启用飞行模式并关闭 Wi-Fi/移动数据。
- Frida host/server 17.16.4 匹配，APK 安装并启动成功。
- 修复过一次追踪器自致问题：替换 `System.loadLibrary` 改变调用者 ClassLoader 语义，导致 `libGame.so not found`；删除该 Java 替换后原生库正常加载。
- `libunisec.so` 的核心 JNI 注册偏移已经记录在 `docs/DYNAMIC_AUDIT_LOG.md`。
- 使用 Java `performClick()` 本地接受隐私页面后，断网进入补丁失败页面；未访问第三方服务。
- 本地引擎成功装载 `libGame.so`、注册 Skeleton/Material/Scene 等类型、初始化渲染并生成大量 ES3 shader cache，证明离线渲染基础存在。
- 观察到三个远程 `shapeconfig` 对象请求；这直接证明宠物/形状配置至少部分不在基础 APK 中。路径摘要见动态日志，不要主动请求对应域名。
- 最新资源追踪器已通过延迟 read/compare hook 避免 Android `perfetto_hprof` 崩溃，但尚未捕获 HashRes 数据访问。推测使用 APK ZIP/mmap 或自定义归档路径。

## 四、已遇问题、处理和结论

| 问题 | 已做处理 | 结果/后续 |
|---|---|---|
| 保护层隐藏核心 DEX | 进程内扫描标准 DEX magic/size 并导出 | 核心 DEX 已恢复；继续以 native/脚本为主 |
| Hook `System.loadLibrary` 后主库找不到 | 移除 Java 替换，仅保留 native dlopen 日志 | 已解决，是追踪器副作用，不是 APK 缺库 |
| read/memcmp Hook 导致系统线程崩溃 | 路径/AAsset open 立即挂钩，数据和比较 hook 延迟 1.5/2.5 秒 | 启动稳定，但仍没有资源事件 |
| 路径哈希常见算法零命中 | 记录完整候选与算法范围后停止盲猜 | 转向运行时函数、解密后索引或 URL 构造调用链 |
| Rizin 全量分析没有 URL xref | 停止重复 `aaaa` | 写定向 ARM64 ADRP+ADD 扫描器或动态监控目标 RVA |
| 模拟器不支持 ASTC | 保留逻辑/追踪用途 | 最终视觉验收改用支持 ASTC 的 ARM64 实机或兼容环境 |
| 离线启动卡补丁失败 | 记录缺失 shapeconfig 和本地文件 | 找补丁成功/失败边界，做本地资源适配，不伪造网络响应 |
| GitHub 远端匿名/SSH不可访问 | 本地建立完整 Git 基线 | 需要有仓库权限的 GitHub 凭据后推送 |

## 五、当前最优下一步

按顺序执行，不并行扩大范围：

1. 扩充 `kktkky-resource-trace.js`：跟踪 `mmap`、`AAssetManager_openFileDescriptor`、minizip/zlib 和 APK ZIP offset，把 base.apk 内的访问对应回具体 HashRes 条目。
2. 对 `libGame.so` 的已知 static/dynamic URL RVA 做 ARM64 ADRP+ADD 定向引用扫描；从 URL 拼接/下载回调反向定位 path ID 和 shapeconfig 解析函数。
3. Hook shapeconfig 解析成功/失败边界，记录输入 buffer、逻辑名、12-byte ID、输出对象和调用栈；优先尝试基础包已有 `shapeconfig.thx` 的真实加载路径。
4. 从第一个 WPK marker 回溯定位 `_g18xxh_`/`_g18RC4_2` 解析入口，在返回点导出解密后的 buffer，验证封装格式，不继续盲猜密钥。
5. 用恢复的一个宠物链做最小展示探针：模型、材质、动作、头像、技能图标全部能绑定并渲染。
6. 只有第 5 步通过后，建立 Android 离线壳、本地 schema 和玩法事务；顺序为存档 → 免费商店/抽奖 → 合宠 → 固定敌人战斗。

## 六、进入实现阶段的硬门槛

必须用运行证据逐项通过：

1. 至少一个宠物 ID 的模型、材质、动作、头像和技能图标资源链完整，且测试进程正确渲染。
2. 能构造宠物对象并从本地存档退出重进恢复。
3. 离线抽奖一次，随机记录、保底状态、奖励和库存同一事务提交。
4. 离线合宠一次，自定义公式生成的新宠物能展示、保存和重新加载。
5. 固定敌人个人战斗完成进入、行动、结算、奖励和存档闭环。
6. 全部真实支付入口和第三方地址不可达；应用使用独立包名、签名和离线标识。

门槛 1 之前只做审计/探针，不搭建假成功 UI。门槛 1–5 全部通过后，才可称为“可玩离线 APK”。

## 七、仓库与私有制品

Git 中只保存脱敏文档、脚本、测试、构建配置和 SHA-256 清单。以下内容不进入普通 Git：原 APK、解包树、WPK/IDX、THI/THX、DEX/SO、AVD、截图和原始日志。新设备按照 `docs/GIT_AND_MIGRATION.md` 从授权私有存储补齐，或按 `docs/ENVIRONMENT_RUNBOOK.md` 再生。

关键逻辑制品及哈希见 `artifacts/manifests/source-artifacts.sha256`。任何哈希不一致都应视为新样本，不能沿用本报告结论。

## 八、专项文档索引

- `docs/ENVIRONMENT_RUNBOOK.md`：环境、变量、工具和复现命令。
- `docs/DYNAMIC_AUDIT_LOG.md`：动态时间线、JNI 偏移和故障证据。
- `docs/OFFLINE_RESOURCE_AUDIT.md`：资源结构与玩法依赖。
- `docs/IMPLEMENTATION_SPEC.md`：离线数据模型、事务和功能验收规格。
- `docs/GIT_AND_MIGRATION.md`：分支、提交、制品、备份和换机步骤。
- `docs/STATIC_ANALYSIS.md`：初始静态审计。
- `docs/LEGACY_SERVER_ROADMAP.md`：已停用的联网私服思路，仅供历史分析。
