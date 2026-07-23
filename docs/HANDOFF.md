# MXXY 离线单人版交接总览

```yaml
project: mxxy-offline-single-player
last_verified: 2026-07-23T10:30+0800
phase: sdk-controller-replacement
overall_status: partial
buildable_apk: true
key_breakthrough: sdk-init-ntgameloginsuccess-triggered
previous: downloader-gate-bypassed-via-smali
authoritative_input_sha256: d520f56c541cb2400f7cf0048a66f328a91355f292425f3afba532c568bd0543
working_apk: dist/mxxy-v27-signed.apk
patches_total: 16 smali + 2 libGame.so binary + 1 SdkController replacement
```

## 一、最终目标

基于用户拥有并授权的 `kktkky-MXXY_M-1.563.apk`，做成不访问任何第三方服务、数据仅保存在本机的单人 APK。核心体验：宠物展示、抽奖、合宠、个人战斗、本地免费商城。

（详见 IMPLEMENTATION_SPEC.md）

## 二、三大突破

### 突破 #1：下载器门闩绕过（已完成）

4 个 smali 补丁使 APK 在飞行模式下启动，不弹「解析下载列表出错」。OpenGL 渲染引擎正常初始化。详见 `docs/GATE_BYPASS_LOG.md` 和 `docs/SMALI_PATCHES.md`。

### 突破 #2：SdkController ClassLoader 劫持（进行中）

**核心发现**：Android ClassLoader 优先加载基 APK 的 DEX，后加载受 UniSec 保护的 `.unzip/classes.dex`。因此在基 APK 的 `smali_classes4/com/netease/my/SdkController.smali` 中放置替代实现即可拦截受保护 DEX 的同名类。

**已知 native JNI 入口**（均需 static 方法）：
- `getPlatform()`, `getSdkValue(String)`, `getUdid()`, `getAppChannel()`, `getChannel()`, `isMuMu()`, `getSdkVersion()`, `getEngineVersion()`, `getProjectId()`, `getAppKey()`
- `init()`, `initWeb()`, `uploadDrpf(String)`, `uploadDrpf(Context)`, `uploadDrpf()`, `upload_drpf()`
- `setActivity(Activity)`, `showSplash()`, `openLoginView()`, `checkLoginSucc(String,String)`, `gameLoginSuccess()`
- `openAnnouncement()`, `closeAnnouncement()`, `initDrpf()`, `checkDrpf()`, `drpfCallback()`
- 字段：`OPEN_ANNOUNCEMENT:Z`, `CLOSE_ANNOUNCEMENT:Z`, `IS_SDK_INIT:Z`, 等

**策略**：在 `init()` 中直接设置 UID/SESSION/LOGIN_STAT 并调用 `ntGameLoginSuccess()`，绕过 openLoginView 等待。

### 突破 #3：libGame.so URL 重定向（已完成）

成功将 libGame.so 中的 `http://zy.czzdpb.com/static/` → `http://127.0.0.1:8080/s/` 和 `http://zy.czzdpb.com/dynamic/` → `http://127.0.0.1:8080/d/`，Java 层 `ServerAddress.smali` 中 MPay URL 也指向本地。原生下载器已连接至本地服务器。Shapeconfig stub 文件阻止了 CDN 重试循环。

## 三、当前状态矩阵

| 要求 | 状态 | 证据 |
|---|---|---|
| 下载器门闩 | verified | 4 smali 补丁，飞行模式无下载错误 |
| HTTP DNS 循环 | verified | 3 补丁消除 DNS 错误 |
| Shapeconfig 下载 | verified | Stub + URL redirect 阻止 CDN |
| CDN/Auth URL 重定向 | verified | libGame.so + ServerAddress patch |
| SdkController 替代 | partial | 基 APK 假类被优先加载，25 个方法已实现 |
| 登录绕过 | partial | hasLogin/ntLogin 已 patch，init() 中直接触发 ntGameLoginSuccess |
| 构建安装 APK | verified | apktool + zipalign + apksigner 工具链 |
| 补充： | | |
| 资源容器可读 | verified | 21 IDX, 36 WPK, 153,400 entries |
| 核心 DEX 可恢复 | verified | 8,763,836 bytes, 3,141 Java files |
| 本地渲染引擎 | verified | libGame.so 离线初始化，OpenGL 正常 |
| 宠物资源 | partial | Shape 4/8/15 资源链接近完整，3 个远端 shapeconfig 缺失 |
| G1-G6 玩法实现 | unknown | 需先通过登录 |

## 四、当前最优下一步

### 2026-07-23 会话进展（v27）

**已确认**：
- `SdkNetease.init()` 会被 native 代码调用 ✅
- `OnFinishInitListener` 正确方法名是 `finishInit(I)` **不是** `onfinishInit(I)` ✅（修复了之前的崩溃）
- `ntGameLoginSuccess()` 在 SdkNetease.init() 中成功调用 ✅
- 进程不再被 ANR 杀掉，保持存活 ✅
- Messiah 引擎正常启动（PhysicsSceneBody, SceneComponent 类型已注册）✅

**仍卡在 splash 画面**，引擎在等待未知信号才会切换场景。

### 下一步

**找出 native 引擎期待的场景转换信号**。可能的方向：
1. **服务器数据响应**：引擎可能在等待 game server 的 enter world / role list 响应。需要抓取或本地模拟。
2. **额外 SDK 回调**：除了 ntGameLoginSuccess()，可能还需要其他回调如角色选择、服务器选择等。
3. **Native 层分析**：在 libGame.so 中寻找 splash→scene 的分支逻辑（Frida native hooks）。
4. **Lua 脚本触发**：场景转换可能在 Lua 层控制，需要在 `@view/` 脚本中寻找触发点。

**达到可玩需要**：
1. 场景成功从 splash 切换到游戏主界面
2. 本地服务器返回正确格式的资源文件
3. 删除 INTERNET 权限 + 独立包名/签名

## 五、补丁清单

### Smali 补丁（16 个）

| # | 文件 | 方法 | 修改 |
|---|------|------|------|
| 1 | PatchListProxy.smali | needDownload() | return false |
| 2 | Untitles.smali | checkHeaderValue() | return true |
| 3 | HttpDnsAgent.smali | switchDnsMode() | return true |
| 4 | HttpDns.smali | fetch() | return true |
| 5 | SdkBase.smali (classes4) | hasLogin() | return true |
| 6 | SdkBase.smali (classes4) | hasGuestLogined() | return true |
| 7 | NeteaseBase.smali | ntLogin() | loginDone(0) + ntGameLoginSuccess |
| 8 | HttpDnsAgent$a.smali | run() | no-op |
| 9 | HttpDns.smali | updateAnycastIp() | no-op |
| 10 | SdkNetease.smali | init() | skip network, call finishInit(0) |
| 11 | NeteaseBase.smali | init() | skip client log |
| 12 | NeteaseUtils.smali | is3rdLoginChannel() | return true |
| 13 | SdkNetease.smali | login() | loginDone(0) |
| 14 | SdkNetease.smali | logout() | no-op |
| 15 | ServerAddress.smali | 4 URLs | → 127.0.0.1:8080/mpay |
| 16 | SdkController.smali (NEW) | 完整替代实现 | 拦截 protected DEX |

### libGame.so 二进制补丁（2 个）

| # | 偏移 | 修改 |
|---|------|------|
| 17 | 0x4b2c0e8 | `http://zy.czzdpb.com/static/` → `http://127.0.0.1:8080/s/` |
| 18 | 0x4b2c2e8 | `http://zy.czzdpb.com/dynamic/` → `http://127.0.0.1:8080/d/` |

## 六、构建命令

```bash
# 1. 解包
apktool d input.apk -o unpacked/patch-skip

# 2. 应用所有 smali 补丁（见 SMALI_PATCHES.md）

# 3. 添加 SdkController 替代实现
cp SdkController.smali unpacked/patch-skip/smali_classes4/com/netease/my/

# 4. 重建
apktool b unpacked/patch-skip -o unsigned.apk

# 5. 注入 libGame.so URL patch
python3 patch_lib_urls.py unsigned.apk

# 6. 对齐 + 签名
zipalign -p -f 4 unsigned.apk aligned.apk
apksigner sign --ks keystore/offline-debug.jks --ks-pass pass:mxxyoffline \
  --ks-key-alias mxxy-offline --key-pass pass:mxxyoffline --out dist/signed.apk aligned.apk

# 7. 安装前部署 stub 文件
adb shell mkdir -p /sdcard/Android/data/com.netease.my/files/pkres/{data,res}
adb push artifacts/stubs/* /sdcard/Android/data/com.netease.my/files/pkres/data/
adb push artifacts/stubs/* /sdcard/Android/data/com.netease.my/files/pkres/res/

# 8. 启动本地服务器
python3 scripts/android/local_server.py 8080 &
adb reverse tcp:8080 tcp:8080

# 9. 安装启动
adb install -r dist/signed.apk
adb shell am start -n com.netease.my/com.netease.game.MessiahNativeActivity
```

## 七、容器/仓库

Git 仅保存脱敏文档、脚本、SdkController 模板。私有制品（原始 APK, WPK/IDX, DEX/SO, keystream）不在仓库中。Keystore 位于 `artifacts/keystore/`。

关键 SHA-256：
- 原始 APK: `d520f56c541cb2400f7cf0048a66f328a91355f292425f3afba532c568bd0543`
- 核心 DEX: `62de0096e2d045633af22effaf4c0c61cb726ba41500006833a4743305d3debc`
