# kktkky 自有后端实施路线

> **历史文档，当前不执行。** 用户最终选择完全离线单人版。本文件只保留早期协议依赖分析，不能作为部署第三方兼容服务、支付绕过或当前项目进度的指令。现行方案见 `HANDOFF.md` 与 `IMPLEMENTATION_SPEC.md`。

## 目标与边界

目标是在拥有客户端、资源和协议合法使用权的前提下，为 `com.netease.my` 建立独立的认证、区服、游戏数据、支付和资源服务。

APK 是客户端，不包含完整服务端实现。当前能直接重建的是 MPay HTTP 认证协议；角色、场景、战斗等核心协议仍需要从运行中的客户端采集并做兼容实现。

## 当前结论

后端至少分为两个彼此独立的协议面：

1. **MPay HTTP 层**：外层 DEX 中接口路径、表单字段和 JSON 解析器基本完整，可以先做兼容服务。
2. **核心游戏层**：位于隐藏 DEX 与混淆后的 `libGame.so`，服务器地址可能由登录响应、加密配置或资源更新动态下发。必须动态恢复。

只完成 MPay 层，客户端最多能通过账号界面；没有兼容的游戏网关仍然无法进入角色和场景。

## 已恢复的 MPay 接口

所有路径以当前基础地址 `/mpay` 为前缀。

| 功能 | 路径 |
|---|---|
| 游戏配置 | `/games/{game_id}/config` |
| 注册/账号登录 | `/games/{game_id}/devices/{device_id}/users` |
| 游客登录 | `/games/{game_id}/devices/{device_id}/users/by_guest` |
| 用户信息 | `/games/{game_id}/devices/{device_id}/users/{user_id}/info` |
| 登录方式 | `/games/{game_id}/login_methods` |
| 登出 | `/games/{game_id}/devices/{device_id}/users/{user_id}/logout` |
| 创建订单 | `/games/{game_id}/orders/{order_id}/init` |
| 查询订单 | `/games/{game_id}/orders/{order_id}.json` |
| 支付方式 | `/games/{game_id}/orders/{order_id}/payments` |

常见公共表单字段包括：

```text
game_id, gv, gvn, cv, sdk, app_type, app_mode, sdk_language,
jf_game_id, pkg_channel, app_channel, transid, mcount_app_key,
mcount_transaction_id, queue_token
```

账号/游客登录的业务参数位于 `params` 字段，客户端会先把 JSON 加密并编码。认证 MVP 可以先只开放游客登录并忽略该字段，但正式环境必须恢复加密参数并做完整校验。

## MPay 最小成功响应

登录解析器把“不包含 `code` 的 JSON”视为成功，并要求存在 `user` 对象。最小模型可以从以下结构开始：

```json
{
  "user": {
    "id": "user-10001",
    "token": "signed-session-token",
    "login_channel": "local",
    "login_type": 1,
    "client_username": "guest-10001",
    "display_username": "guest-10001",
    "nickname": "Player",
    "avatar": "",
    "realname_status": 1,
    "realname_verify_status": 0,
    "need_aas": false,
    "detect_is_new_user": true,
    "mobile_bind_status": 0,
    "related_login_status": 0,
    "need_mask": false,
    "need_bind": 0,
    "global_game_user_id": "user-10001"
  },
  "force_pwd": false,
  "verify_status": {
    "need_passwd": 0,
    "need_email": 0,
    "need_real_name": 0,
    "need_sms": 0
  }
}
```

错误响应需要包含字符串形式的 `code` 和 `reason`；客户端会依据特定错误码进入实名、短信或延迟重试流程。

## 畅玩服与免费购买设计

目标不是伪造一个“购买成功”弹窗，而是让免费购买成为自有服务端认可并持久化的正式业务模式。该模式只能在完全隔离的自有服务器中启用，不能把本地成功回调用于官方或第三方服务器。

### 三种实现方式

| 方式 | 表面效果 | 重登后数据 | 建议 |
|---|---|---|---|
| 只修改 APK，点击后直接弹成功 | 看起来成功 | 通常丢失，服务器没有发货 | 不采用 |
| APK 伪造支付成功，再让服务端信任客户端 | 可以发货 | 可以持久化，但任何修改客户端都能任意发货 | 不采用 |
| 自有服务端提供免费购买模式 | 服务端确认后显示成功 | 正确持久化，可审计、可回滚 | 采用 |

### 推荐购买流程

```text
玩家点击商品
      |
      v
客户端发送 purchase_intent(item_id, quantity, request_id)
      |
      v
自有游戏服务器校验商品、账号、数量和幂等键
      |
      +-- free_shop=true --> 价格视为 0 / 不扣货币
      |
      v
同一数据库事务：创建订单 + 写背包 + 写货币账本
      |
      v
服务端返回 committed=true、新背包版本和新余额
      |
      v
客户端显示“购买成功”并刷新背包
```

客户端只能在收到 `committed=true` 后显示成功。这样即使崩溃、断网或重复点击，也不会出现显示成功但没有道具，或重复发货的问题。

### 经济模式配置

服务端建议支持明确的环境级开关：

```yaml
economy_mode: sandbox_free
real_payment_enabled: false
free_shop_enabled: true
consume_currency_on_shop: false
grant_all_products: true
```

不要把该开关放在客户端；由服务端和部署环境控制。正式启动时还应在客户端明显显示“测试服/免费服”，避免与真实支付混淆。

### 两类购买需要分别处理

1. **游戏内商店购买**：通常走核心游戏网关协议。服务端直接给道具、角色能力或货币，这是实现“随便买”的主要位置。
2. **人民币充值/MPay**：当前外层 SDK 包含订单初始化、支付方式和订单状态查询。免费服应禁用支付宝、微信等真实渠道，用自有的 `sandbox_free` 通道或直接隐藏充值入口。

当前 MPay 订单代码可确认客户端会读取：

- `order.goods_name`
- `order.price`、`discount_price`
- `pay_methods[]`
- 订单查询结果的 `order.status`、`reason`、`pay_amount`、`need_repay`

因此重打包后可以让支付界面显示“免费”，但真正到账仍应由自己的订单和游戏服务完成。

### 数据一致性

- `orders.request_id` 建唯一索引，重复点击返回第一次结果。
- `wallet_ledger` 和 `inventory_items` 与订单在同一事务提交。
- 货币采用账本事件，不直接接受客户端提交余额。
- 免费购买也生成审计订单，金额为 0，来源标记为 `SANDBOX_FREE`。
- 发货结果返回背包版本号；客户端版本落后时强制重新拉取。
- 提供管理员回滚和重放工具，但不能直接手改余额而不留记录。

### APK 需要修改的内容

- 将认证、区服、游戏网关和资源域名改到自有环境。
- 禁用真实支付 SDK 和第三方支付回调入口。
- 把“充值”入口隐藏或改成“免费领取”，避免误导。
- 游戏内购买按钮继续发请求，但指向自己的购买协议。
- 只在服务端提交成功后调用原有成功 UI/回调。
- 为测试服加入明显水印、独立包名和独立签名。
- 修复 `UxFileProvider`，关闭全局明文 HTTP。

由于商店购买逻辑大概率位于隐藏 DEX 或 `libGame.so`，上述 APK 修改要在核心 DEX dump 和购买调用链定位后实施。

## 建议服务架构

```text
                     +------------------+
APK -- HTTPS ------> | Auth / MPay API  | ---- PostgreSQL
                     +------------------+         |
                              | JWT              | users, sessions
                              v                  |
                     +------------------+         |
APK -- TCP/UDP ----> | Game Gateway     | --------+
                     +------------------+
                              |
              +---------------+----------------+
              |               |                |
          Role Service   World Service    Payment Service
              |               |                |
              +---------------+----------------+
                              |
                        PostgreSQL + Redis

APK -- HTTPS ------> Resource Manifest / Object Storage / CDN
```

### 最小数据表

- `users`: 本地账号主体，不保存明文密码。
- `devices`: 设备与游客账号映射。
- `sessions`: 短期会话、刷新令牌和吊销状态。
- `realms`: 区服、网关地址、版本和维护状态。
- `roles`: 账号、区服和角色基础信息。
- `role_snapshots`: 角色状态版本化快照。
- `inventory_items`: 背包物品、数量和版本号。
- `wallet_ledger`: 游戏货币只追加账本。
- `orders`: 商户订单、支付状态和幂等键。
- `payment_events`: 支付机构回调原始事件及验签结果。

## 实施阶段

### 阶段 0：建立隔离测试环境

- ARM64 Android 模拟器或测试机，允许安装测试 CA、使用 Frida 和拉取应用私有文件。
- 所有账户、手机号和支付均使用测试数据及支付沙箱。
- 保存 APK、DEX、SO、脚本和每次 dump 的哈希。

退出条件：客户端能稳定启动，Frida 在壳初始化前注入且不会立即退出。

### 阶段 1：恢复核心 DEX

- 抓取 `.unzip/classes.dex` 从写入到 ART 装载的时间点。
- Hook `DexClassLoader`、`DexFile.loadDex`、`open/openat/mmap` 与 `RegisterNatives`。
- 对有效 DEX 重新运行 JADX，定位 `MessiahNativeActivity`、登录回调、区服和网关初始化。

退出条件：恢复主 Activity 及从 MPay token 到游戏登录请求的调用链。

### 阶段 2：采集游戏协议

- Hook DNS、`connect`、`send/recv`、TLS 明文层和游戏序列化函数。
- 逐个录制冷启动、游客登录、选服、创建角色、进入场景、背包变化和退出重登。
- 对每次操作建立请求、响应、状态变化三元组。
- 搜索 Protobuf descriptor、消息 ID 表、字段映射和压缩/加密函数。

退出条件：确定网关地址来源、传输层、帧头、握手、登录消息和至少一个角色查询响应。

### 阶段 3：MPay 兼容服务

- 先实现游戏配置、游客登录、用户信息、登出。
- 使用 HTTPS、自有域名、自有发布证书和短期签名 token。
- 客户端配置改到测试域名，禁止明文 HTTP。
- 暂不实现真实短信、实名和第三方 OAuth；测试环境返回明确禁用状态。

退出条件：客户端仅连接自有认证域名，并能获得稳定的本地用户 ID 和 token。

### 阶段 4：最小游戏网关

- 实现握手、token 校验、心跳和断线重连。
- 实现区服列表、角色列表、创建角色、读取/保存角色快照。
- 每个状态变更使用版本号和事务，拒绝客户端直接提交货币余额。

退出条件：创建角色后退出应用，重新登录仍能恢复同一角色。

### 阶段 5：游戏功能迭代

- 按真实客户端调用顺序补充场景、任务、背包、邮件、好友和战斗消息。
- 服务端决定经验、掉落、货币和物品变化；客户端只提交动作意图。
- 未实现的协议返回明确的兼容错误，不能静默篡改数据。

### 阶段 6：支付

- 第一目标部署采用 `sandbox_free`，完全关闭真实支付渠道。
- 所有免费购买仍创建 0 金额订单，并由服务端事务发货。
- 如果未来启用真实支付，使用合法商户和支付沙箱创建订单。
- 只有支付机构服务端回调验签成功后才能写入 `wallet_ledger`。
- 回调、补单和发货均以支付事件 ID 和商户订单号做幂等。
- 客户端显示不能作为到账依据。

退出条件：同一回调重复发送不会重复发货，退款和撤销可以追溯。

### 阶段 7：资源服务与发布

- 解密并重建 `_g18RC4_` 清单与 WPK/IDX 更新链。
- 使用版本化对象存储、资源哈希和清单签名。
- 修复导出的 `UxFileProvider`，改为自有 release 证书签名。
- 维护客户端版本、协议版本和资源版本的兼容矩阵。

## 当前阻塞项

当前唯一真正阻塞游戏后端开发的是缺少运行中的协议样本。静态代码已经足够启动 MPay API 实现，但尚不能确定：

- 游戏网关的真实地址、端口和下发位置。
- 帧格式、消息 ID、压缩与业务加密。
- 游戏登录 token 是否直接使用 MPay token，还是需要二次换票。
- 角色、背包和场景的请求/响应结构。
- 客户端是否验证服务器公钥、资源签名或证书固定。

因此下一步不是先写大量猜测性的角色服务，而是连接一台隔离 ARM64 Android 测试设备，完成阶段 1 和阶段 2。拿到登录到角色列表的完整协议后，才能准确确定服务端语言、网络框架和 MVP 工期。

## 已有证据位置

- MPay 基础地址：`jadx/sources/com/netease/mpay/ServerAddress.java`
- HTTP 公共参数和错误处理：`jadx/sources/com/netease/mpay/server/request/k.java`
- 登录响应模型：`jadx/sources/com/netease/mpay/server/request/login/AbstractC0970a.java`
- 账号登录请求：`jadx/sources/com/netease/mpay/server/request/login/S.java`
- 游客登录请求：`jadx/sources/com/netease/mpay/server/request/login/C0988t.java`
- 游戏配置解析：`jadx/sources/com/netease/mpay/server/request/b.java`
- 现有脱壳脚本：`scripts/android/kktkky-mxxy-1-563-unpack.js`
