# Smali 补丁文档 — 离线门闩绕过

```yaml
updated: 2026-07-23T00:15+0800
status: partial (download gate bypassed, SdkController replacement in progress)
apktool_version: 3.0.3
target_apk: kktkky-MXXY_M-1.563.apk
```

## 补丁概览

### A 组：下载器门闩（4 个，已验证通过）

| # | 目标类 | 方法 | 修改 |
|---|--------|------|------|
| 1 | `PatchListProxy` | `needDownload()Z` | return false |
| 2 | `Untitles` | `checkHeaderValue(String)Z` | return true |
| 3 | `HttpDnsAgent` | `switchDnsMode(Context,String)Z` | return true |
| 4 | `HttpDns` | `fetch(Context,String,boolean)Z` | return true |

### B 组：HTTP DNS 清理（2 个，已验证通过）

| # | 目标类 | 方法 | 修改 |
|---|--------|------|------|
| 8 | `HttpDnsAgent$a` | `run()V` | no-op |
| 9 | `HttpDns` | `updateAnycastIp(Context)V` | no-op |

### C 组：登录状态（4 个，已验证通过）

| # | 目标类 | 方法 | 修改 |
|---|--------|------|------|
| 5 | `SdkBase` (classes4) | `hasLogin()Z` | return true |
| 6 | `SdkBase` (classes4) | `hasGuestLogined()Z` | return true |
| 12 | `NeteaseUtils` | `is3rdLoginChannel()Z` | return true |
| 15 | `ServerAddress` | 4 个 URL 字段 | → 127.0.0.1:8080 |

### D 组：登录流程（3 个，已验证通过）

| # | 目标类 | 方法 | 修改 |
|---|--------|------|------|
| 7 | `NeteaseBase` | `ntLogin()V` | loginDone(0) + ntGameLoginSuccess |
| 13 | `SdkNetease` | `login()V` | loginDone(0) |
| 14 | `SdkNetease` | `logout()V` | no-op |

### E 组：SDK 初始化（2 个，已验证通过）

| # | 目标类 | 方法 | 修改 |
|---|--------|------|------|
| 10 | `SdkNetease` | `init(OnFinishInitListener)V` | skip network, finishInit(0) |
| 11 | `NeteaseBase` | `init(OnFinishInitListener)V` | skip ClientLog |

### F 组：SdkController 替代（1 个文件 + libGame.so 二进制补丁）

| # | 目标 | 说明 |
|---|------|------|
| 16 | `smali_classes4/com/netease/my/SdkController.smali` | 完整替代类，拦截 protected DEX |
| 17 | `lib/arm64-v8a/libGame.so` offset 0x4b2c0e8 | URL → 127.0.0.1:8080/s/ |
| 18 | `lib/arm64-v8a/libGame.so` offset 0x4b2c2e8 | URL → 127.0.0.1:8080/d/ |

## F 组详解：SdkController ClassLoader 劫持

### 原理

Android PathClassLoader 按顺序搜索 DEX：基 APK 的 `classes.dex` 优先于运行时加载的 `.unzip/classes.dex`（受保护 DEX）。因此将替代 SdkController 放在基 APK 的 smali_classes4 中即可拦截同名类。

### SdkController 模板位置

`artifacts/smali-templates/SdkController.smali` — 包含所有已识别的 native JNI 入口方法。

### 关键方法

- `init()` — 触发 SDK 初始化 + 直接调用 ntGameLoginSuccess 绕过登录
- `openLoginView()` — 静态方法，native 代码通过 JNI GetStaticMethodID 查找
- `getPlatform()`, `getUdid()`, `getAppChannel()`, `getChannel()` — JNI 入口，需返回正确值
- `showSplash()` — 静态 no-op（splash 由 native 层控制）
- `buyProduct(String)` — 直接返回成功（免费购买）
- `gameLoginSuccess()` — 调用 SdkMgr.getInst().ntGameLoginSuccess()

### 缺失方法错误处理

遇到 `NoSuchMethodError: No static method XXX` 时，在 SdkController.smali 中添加对应静态方法。遇到 `NoSuchFieldError: No field XXX` 时，添加对应字段。

## libGame.so URL 补丁

### 工具

`scripts/android/patch_lib_urls.py` — Python 脚本替换 zy.czzdpb.com 为 127.0.0.1:8080

### 补丁点

```text
Offset 0x4b2c0e8: "http://zy.czzdpb.com/static/"  → "http://127.0.0.1:8080/s/\x00\x00\x00\x00"
Offset 0x4b2c2e8: "http://zy.czzdpb.com/dynamic/" → "http://127.0.0.1:8080/d/\x00\x00\x00\x00"
```

替换长度必须完全一致（28/29 bytes），多余空间用 \x00 填充。

### 本地服务器

`scripts/android/local_server.py` — 运行在主机 8080 端口，通过 `adb reverse tcp:8080 tcp:8080` 转发到模拟器。需部署 stub 文件响应 shapeconfig 请求。

## 构建流程

```bash
# 1. 解包
apktool d input.apk -o unpacked/patch-skip

# 2. 应用所有 smali 补丁
cp artifacts/smali-templates/SdkController.smali \
   unpacked/patch-skip/smali_classes4/com/netease/my/

# 3. 重建 APK
apktool b unpacked/patch-skip -o unsigned.apk

# 4. 注入 patched libGame.so
python3 scripts/android/patch_lib_urls.py unsigned.apk

# 5. 对齐和签名
zipalign -p -f 4 unsigned.apk aligned.apk
apksigner sign --ks artifacts/keystore/offline-debug.jks \
  --ks-pass pass:mxxyoffline --ks-key-alias mxxy-offline \
  --key-pass pass:mxxyoffline --out dist/signed.apk aligned.apk

# 6. 部署 stub + 服务器
python3 scripts/android/local_server.py 8080 &
adb reverse tcp:8080 tcp:8080
adb push artifacts/stubs/* /sdcard/Android/data/com.netease.my/files/pkres/data/

# 7. 安装测试
adb install -r dist/signed.apk
adb shell am start -n com.netease.my/com.netease.game.MessiahNativeActivity
```

## 验证结果

```
✅ APK 重建成功 (apktool 3.0.3)
✅ zipalign + apksigner 签名通过
✅ 飞行模式下启动成功
✅ 无 VerifyError 崩溃
✅ 无下载器错误 (patchlog 不存在)
✅ 无 HTTP DNS 循环错误
✅ OpenGL 渲染引擎初始化
✅ SDK 初始化完成 (onfinishInit:0)
✅ libGame.so CDN URL 重定向至 127.0.0.1:8080 (游戏原生下载器已连接)
✅ SdkController 替代类被 ClassLoader 优先加载
🟡 openLoginView 尚未被 native 代码调用 (需在 init() 中直接触发)
```

## 常见问题

### VerifyError: register index out of range
`.locals N` 声明了 N 个寄存器，只能用 v0..v(N-1)。静态方法无 p0 参数。参见 AGENTS.md 陷阱表。

### NoSuchMethodError: No static method XXX
SdkController 缺少 JNI 入口方法。在 `artifacts/smali-templates/SdkController.smali` 中添加：
```smali
.method public static XXX()V
    .locals 0
    return-void
.end method
```

### zipalign 报错 "Targeting R+ requires resources.arsc uncompressed"
签名前必须 zipalign：`zipalign -p -f 4 input.apk output.apk`
