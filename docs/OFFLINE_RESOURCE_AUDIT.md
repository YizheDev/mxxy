# kktkky 离线单人版资源审计

审计对象：`kktkky-MXXY_M-1.563.apk`（SHA-256 见制品清单）
目标：确认宠物展示、抽奖、合宠和个人战斗能否在完全离线、本地存档的 APK 中实现。

> 状态说明：本文聚焦资源格式。动态最新状态和下一步以 `HANDOFF.md` 为准。

## 当前判断

可以继续做，而且已有证据表明本包携带了大量模型、纹理、技能图标、战斗和 UI 资源。离线改造的主要难点不是重新绘制宠物，而是恢复“资源路径/宠物 ID/配置 ID”的映射，以及把原先由服务器确认的状态变化改成本地权威逻辑。

目前还不能承诺“所有宠物百分之百完整”。补丁目录中的 THX 清单通常比 APK 内实际 WPK 条目多，说明清单包含未随基础包安装的候选或远程补丁资源。可验证的准确说法是：APK 当前打包了约 1.71 GiB WPK 数据、153,400 个可寻址条目；其中模型仓库相关条目约 42,000 个、技能图标 1,693 个。待恢复名称映射后，才能逐个输出宠物资源覆盖率。

## WPK/IDX 容器结构

全部 21 个 IDX 都满足同一固定布局，且每个条目的 `part + offset + stored_size` 均落在对应 WPK 文件边界内。

```text
IDX header: 36 bytes
  0x00  char[4]  "SKPW"
  0x04  uint32   check1（语义待确认）
  0x08  uint32   reserved
  0x0c  uint32   entry_count
  0x10  byte[16] 03 重复（语义待确认）
  0x20  uint32   check2（语义待确认）

IDX entry: 28 bytes
  0x00  byte[12] 路径标识/哈希
  0x0c  uint32   stored_size
  0x10  uint32   WPK offset
  0x14  uint32   WPK part（从 1 开始）
  0x18  uint32   entry check/hash（语义待确认）
```

已实现只读验证和提取工具：

```bash
python3 scripts/android/kktkky_wpk_index.py \
  --inventory-dir "$MXXY_WORK/hashres/data"

python3 scripts/android/kktkky_wpk_index.py \
  "$MXXY_WORK/hashres/data/repository.idx" \
  --entry 0 --extract-dir /tmp/kktkky-entry
```

### 容器总量

| 指标 | 数量 |
|---|---:|
| IDX 文件 | 21 |
| WPK 文件 | 36 |
| 可寻址条目 | 153,400 |
| 条目存储数据 | 1,837,237,235 bytes |
| RC4 标记条目 | 35,917 |
| texture 标记条目 | 67,632 |
| image 标记条目 | 24,405 |
| Messiah 标记条目 | 2,247 |
| 其他 `_g18xxh_` 条目 | 23,199 |

### 与目标玩法直接相关的资源组

| 资源组 | APK 中条目 | 已确认类型 | 对离线版的意义 |
|---|---:|---|---|
| `repository` | 22,978 | 2,247 Messiah + 20,730 其他模型仓库数据 | 模型、材质和动作引用的主仓库 |
| `res_MsNonRepo` | 19,234 | image/shape 数据 | 非仓库模型/形状资源；字符串可见 `akShape` 等标记 |
| `res_skillicon` | 1,693 | texture | 宠物/人物技能图标 |
| `res_effects` | 4,020 | texture + image | 技能、战斗和 UI 特效 |
| `res_fight_misc` | 58 | texture + image | 战斗杂项素材 |
| `res_ui1` + `res_ui1ext` | 47,038 | texture + image | 原商城、抽奖、合宠等界面素材 |
| `Json` | 23,396 | RC4 | 配置数据候选区 |
| `script` | 12,520 | RC4 | 客户端玩法和界面逻辑候选区 |

WPK 条目常见的物理前缀是：

```text
_g18xxh_ + 4 opaque bytes + .MESSIAH
_g18xxh_ + 4 opaque bytes + _g18RC4_2
_g18xxh_ + 4 opaque bytes + _g18IMG_
_g18xxh_ + 4 opaque bytes + TEX_SIZE
```

`Json` 和 `script` 的条目全部使用 `_g18RC4_2`。多个条目的密文有大段相同前缀，说明解密后还有共同的二进制封装头；不能把它们直接当作 UTF-8 JSON/Lua 文本。

## THI/THX 补丁目录

补丁目录共有 194 个 THI/THX 文件、604,222 条固定记录。已确认物理布局：

```text
THI: "THDX" + 12-byte header tail + N * 12-byte opaque slots
THX: "THDO" + 72-byte header tail + N * 28-byte opaque records
```

存在长度恰好为 76 字节的空 THX 文件，因此 THX 的 76 字节头不是按大小猜出的任意分割。解析工具：

```bash
python3 scripts/android/kktkky_thd_index.py \
  --inventory-dir "$MXXY_WORK/hashres/thd"
```

关键目录记录数：

| 清单 | 记录数 |
|---|---:|
| `shapeconfig.thx` | 38,138 |
| `res_shape.thx` | 19,415 |
| `res_shape.thi` | 15,366 |
| `res_item.thx` | 11,311 |
| `res_item.thi` | 10,897 |
| `res_skillicon.thx` | 1,700 |
| `res_skillicon.thi` | 1,705 |
| `res_fight_misc.thx` | 60 |
| `Json.thx` | 24,566 |
| `script.thx` | 12,522 |
| `repository.thx` | 60,184 |

`res_shape`、`shapeconfig`、`res_item`、`res_skillicon`、`res_fight_misc` 的明文组名是宠物展示和战斗资源在客户端存在的直接证据。THI/THX 的 ID 与 IDX 的 12 字节 ID 不能直接按原始字节匹配，说明两者使用不同的派生值或其中一层仍被混淆。

## 目标功能依赖矩阵

| 功能 | 本地资源证据 | 当前缺口 | 离线实现方式 |
|---|---|---|---|
| 宠物完整显示 | 模型仓库约 42k 条；`res_shape`、`shapeconfig` 清单存在 | 宠物 ID 到模型/材质/动作路径映射；未安装远程资源覆盖率 | 恢复配置和路径哈希后复用原渲染管线；缺失条目标红并补入经授权资源 |
| 抽奖 | 原 UI、图标、JSON、脚本均在包内 | 卡池配置、动画调用链、结果由谁确认 | 本地 RNG + 可配置权重/保底 + 本地事务发奖，再调用原结果 UI |
| 合宠 | 宠物形状、技能图标、脚本候选均在包内 | 原配方/技能继承入口、结果对象格式 | 自定义公式产生新宠物快照，复用原宠物详情和模型展示 |
| 个人战斗 | `res_fight_misc`、特效、阵法、地图资源存在 | 战斗状态机、AI、伤害结算和协议边界 | 将战斗权威状态机本地化；先做固定敌人回合制闭环，再扩技能/AI |
| 商城免费购买 | 原 UI 资源和 MPay 外层代码存在 | 游戏内商品表和背包变更调用链 | 完全离线时禁用真实支付，商品价格本地设为 0，本地事务写背包/货币 |
| 活动 | 大量 UI/脚本候选；有 `res_huodong` 补丁清单 | 在线时间、排行榜、跨服、运营下发数据 | 仅保留可单人化活动；用本地日历和静态配置替代服务器活动中心 |

## 能否保持“完全一致”

视觉和操作层可以最大程度复用当前 APK；数值和结果层必须本地重建。以下内容不能仅靠重签 APK 自动保留：实时运营活动、跨服/排行榜、官方账号资产、服务器生成的商城和赛季数据。目标应定义为“与该客户端版本视觉资源和主要单人交互一致”，而不是“与持续变化的在线服状态完全一致”。

对于用户指定的个人战斗、抽奖、合宠和宠物展示，技术路线成立：保留原 UI/模型/动画，替换登录、数据读取、随机数、结算和存档边界。这样不是伪造第三方服务器购买成功，而是在完全隔离的本地世界中把购买正式定义为免费操作。

## 下一阶段入口

### 静态工作

1. 找到 IDX 12 字节路径标识的生成函数或恢复候选路径字典。
2. 从 `libGame.so` 定位 THI/THX/WPK 读取函数，确认 RC4 后的二进制封装。
3. 批量恢复 `Json`/`script` 名称与明文，搜索宠物、技能、抽奖、合宠和战斗配置。

### 动态工作

已经准备资源定位脚本：

```bash
frida -U -f com.netease.my \
  -l scripts/android/kktkky-resource-trace.js
```

脚本跟踪 WPK/IDX/THI/THX 的读取，并在进程比较 `_g18RC4_`、`_g18xxh_`、`_g18IMG_` 标记时记录 `libGame.so` 调用偏移和回溯。拿到第一个回溯后，可直接对标记解析函数挂入口/返回 Hook，导出解密后的缓冲区。

该脚本已经在网络隔离的 Android 11 ARM64 AVD 中实测并通过延迟 hook 修复了启动崩溃。当前稳定运行但尚未看到 HashRes 读取事件，说明还需覆盖 base.apk ZIP/mmap、自定义归档和文件描述符读取路径。核心 DEX 已成功恢复；资源解密函数仍待定位。

## 进入实现逻辑的验收门槛

满足以下条件后开始改 APK，而不是提前做不可验证的 UI 假成功：

1. 能列出至少一个宠物 ID 的模型、材质、动作和技能图标资源链，并在测试进程中正确显示。
2. 能读取/构造宠物对象，退出重进后从本地存档恢复。
3. 能离线完成一次抽奖并事务性写入宠物/道具。
4. 能离线完成一次合宠并用自定义公式生成可展示的新宠物。
5. 能进入一场固定敌人的个人战斗，完成行动、结算、奖励和存档闭环。
6. 所有真实支付入口和第三方服务地址均禁用；独立包名、签名和“离线个人版”标识明确。
