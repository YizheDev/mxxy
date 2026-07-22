# 门闩绕过记录 — 2026-07-22

本文档记录 2026-07-22 会话中攻破下载器门闩的完整过程，包括尝试的方法、失败原因、最终方案和当前状态。

```yaml
session_date: 2026-07-22
target: kktkky-MXXY_M-1.563.apk
emulator: Android 11 API 30 ARM64 (AVD: kktkky_api30_arm64)
frida: 17.16.4 (host + server)
device_state: airplane_mode=1, wifi=0, data=0
```

## 一、攻击路径总览

```
1. Frida spawn + Java hooks → 失败（Java bridge 不可用）
2. Frida attach + Java hooks → 失败（Java 在 attach 时仍未定义）
3. Native hooks (getaddrinfo/DNS/URL patch) → 部分成功（DNS 重定向生效，但 Check header 失败）
4. Stub server 修复响应头 → 失败（Check header 仍失败）
5. Native 层 __android_log_print 追踪 → 发现 checkHeaderValue 在 Java 层
6. Smali 补丁 → ✅ 成功绕过
```

## 二、各阶段详情

### 阶段 1: Frida Java hook 尝试（失败）

**目标**: 在 spawn/attach 模式下 hook Java 方法

**尝试的方法**:
- Frida spawn 模式 + `Java.perform` / `Java.performNow`
- Frida attach-after-start 模式（am start + 等 N 秒 + attach）

**失败原因**:
- 诊断脚本确认: `Module.findExportByName(null, name)` 在该 Frida 版本抛 `TypeError: not a function`
- 需改用 `Module.findGlobalExportByName(name)`（native hook 可用此方法）
- Java bridge 确认不可用: 诊断脚本输出 `"kind": "diag-java-undefined"` 持续 28 秒（140 次检查，每次 200ms）
- NetEase UniSec 保护阻止了 Frida 的 Java bridge 初始化，Java 对象在 Frida 的 JS 运行时中始终为 undefined
- **结论**: 在此 APP 上无法使用 Frida Java hooks，必须改用其他路线

### 阶段 2: Native hook 尝试（部分成功）

**目标**: 通过 Frida native hooks 拦截网络流量和文件访问

**成功的操作**:
- `Module.findGlobalExportByName()` 可以正常查找符号
- `__android_log_print` 成功 hook（虽然没捕获到下载器日志——下载器直接写文件）
- `getaddrinfo` / `android_getaddrinfofornet` / `android_getaddrinfofornetcontext` DNS 劫持成功
- libGame.so URL base 地址替换成功（`zy.czzdpb.com` → `127.0.0.1.com`，同长度替换）
- `memcmp` hook 成功（强制 MD5 比较返回相等）
- Loopback stub 服务器成功接收并响应 HTTP 请求

**失败的操作**:
- `libc.enumerateExports()` 返回 0 条（可能在受保护进程中不可用）
- `Module.findExportByName(null, ...)` 抛异常（需用 `findGlobalExportByName` 替代）
- `__android_log_print` 未捕获下载器日志（下载器直接写 patchlog 文件，不走 Android logging）
- Stub 文件写入失败（Frida 进程无权限写入 APP 私有目录）
- `curl_easy_perform` 等 libcurl 符号未找到（可能静态链接在 libGame.so 中）

### 阶段 3: Stub 服务器优化（部分成功）

**修改**: 添加 Content-MD5 响应头，处理 patchlist 和所有 dynamic/static 请求

**结果**:
- Patchlist 请求 (`/my_cloud_patchlist_android.3`) 成功返回 `{"list":[]}`
- Shapeconfig 资源请求仍报 `Check header error`
- 即使响应 HTTP 200 + 正确 Content-MD5，native 下载器仍拒绝接受

**根因分析**: `Check header error` 并非 HTTP 响应头验证问题，而是 Java 方法 `Untitles.checkHeaderValue(String)` 在验证某 header 值时返回 false。该方法的验证规则：字符串不能包含控制字符（除了 tab）或非 ASCII 字符。但在离线场景下，可能传入 null 或空字符串，导致验证失败。

### 阶段 4: Smali 补丁（✅ 成功）

**发现**: JADX 反编译输出中搜索到 `com.dev.downloader.utils.Untitles.checkHeaderValue(String)` — 恰好是 "Check header" 的验证方法。同时确认 `PatchListProxy.needDownload()` 控制补丁列表下载。

**补丁列表**:
1. `PatchListProxy.needDownload()` → `return false`（跳过补丁列表下载）
2. `Untitles.checkHeaderValue(String)` → `return true`（接受所有 header 值）
3. `HttpDnsAgent.switchDnsMode(Context, String)` → `return true`（阻止 DNS 模式切换）
4. `HttpDns.fetch(Context, String, boolean)` → `return true`（阻止 DNS 网络拉取）

**遇到的问题和解决**:
- **apktool 重建缺少 AndroidManifest.xml**: 从 `original/AndroidManifest.xml` 手动注入二进制 manifest → ✅ 解决
- **Smali VerifyError**: `.locals 1` 但使用了 v1 寄存器 → 改为仅用 v0 + `const/4 v0, 0x1; return v0` → ✅ 解决
- **Smali VerifyError**: `LogUtil.i(String, String)` / `Logging.detail(String)` 参数不匹配 → 简化为无日志版本 → ✅ 解决

### 阶段 5: 测试验证

**v5 APK 测试结果**:
- ✅ 无 VerifyError 崩溃
- ✅ 无下载器错误（patchlog 不存在！）
- ✅ 无 `NeteaseHttpDns` 循环日志
- ✅ OpenGL 渲染引擎初始化（`OpenGLRendor: start to call display`）
- ✅ 启动初始化序列完成（`AppTimeRecorder_v2: app time recorder end`）
- ✅ 无 `XposedBridge` 或 `legend.Hook` 等兼容性崩溃
- 🟡 卡在 splash 画面 159415 bytes（推断为 UniSDK 登录层等待服务器响应）

## 三、Logcat 关键发现

### 补丁前（v3，有 VerifyError）
```
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.VerifyError: Verifier rejected class
  com.netease.ntunisdk.core.httpdns.HttpDnsAgent:
  boolean switchDnsMode(Context, String) failed to verify:
  [0x4] invalid argument count (2) exceeds outsSize (1)
W NeteaseHttpDns: [WARN]: UrlException: Error Code: 3  (每10秒重复)
W NeteaseHttpDns: [WARN]: UrlException: Error Code: 2  (每10秒重复)
```

### 补丁后（v5，正常启动）
```
I AppTimeRecorder_v2: Regulation{delayMilliSec=1000, cnt=4}  → 0
I AppTimeRecorder_v2: Regulation{delayMilliSec=2000, cnt=5}  → 0
I AppTimeRecorder_v2: Regulation{delayMilliSec=5000, cnt=8}  → 0
I AppTimeRecorder_v2: app time recorder end
I OpenGLRendor: start to call display(26), pointer:0x786649000
I OpenGLRendor: EM start to call display(16), pointer:0x786549000
```

启动时间线：
```
T+0s    AM start
T+1s    1000ms × 5 倒计时开始
T+5s    2000ms × 5 倒计时开始
T+15s   5000ms × 8 倒计时开始
T+55s   app time recorder end
T+55s+  OpenGL 持续渲染，但画面停留在 splash
```

## 四、当前屏幕状态

**Splash 画面**:
- UI 元素: `ImageView id=img_splash content-desc="splash"` 全屏
- 无可见文本、按钮或交互元素
- 画面大小稳定在 159415 bytes
- OpenGL 在后台持续渲染但画面不更新

**推断**: APP 已完成引擎初始化，正在等待 UniSDK 的登录/认证回调。`SdkController.openLoginView()` 或其调用链在等待网络连接，在飞行模式下永不完成。

## 五、下一步建议

1. **UniSDK 登录绕过**（最高优先级）:
   - 目标文件: `smali/com/netease/ntunisdk/base/SdkBase.smali`, `smali_classes4/com/netease/ntunisdk/base/SdkBase.smali`
   - 目标类: `com.netease.ntunisdk.base.GamerInterface`（登录接口）
   - 备选: 在 libGame.so native 层 hook 登录相关 JNI 调用

2. **如果 UniSDK 无法 smali patch**（核心 DEX 受保护）:
   - 通过 libGame.so native 层注入绕过
   - 或使用 Frida native hooks（绕过 Java bridge 限制）

3. **G1 宠物资源链验证**（登录绕过后的下一步）:
   - Shape 8/4/15 已就绪（详见 `docs/HANDOFF.md`）
   - 验证 Messiah 渲染管线可以加载完整宠物模型

## 六、环境信息

```bash
# 复现环境
export MXXY_REPO=/path/to/mxxy
export MXXY_WORK=/path/to/private-mxxy-work
export ANDROID_SDK_ROOT=/path/to/android-sdk

# 模拟器
AVD: kktkky_api30_arm64 (Pixel 4, API 30, arm64-v8a)
Emulator: 36.6.11

# Frida
frida-venv/bin/frida --version  # 17.16.4
adb shell /data/local/tmp/frida-server --version  # 17.16.4

# 启动前
adb root
adb shell settings put global airplane_mode_on 1
adb shell svc wifi disable
adb shell svc data disable

# 安装
adb install -r dist/mxxy-patch-v5-signed.apk
adb shell am start -n com.netease.my/com.netease.game.MessiahNativeActivity
```

## 七、产生的制品

### 仓库内（mxxy git repo）
- `docs/HANDOFF.md` — 更新至最新状态
- `docs/SMALI_PATCHES.md` — 详细 smali 补丁文档
- `docs/GATE_BYPASS_LOG.md` — 本文档
- `scripts/android/kktkky-thx-filter-bypass.js` — DNS 劫持脚本
- `scripts/android/kktkky-consent-click.js` — 隐私同意自动点击
- `scripts/android/kktkky_g18_crypto.py` — RC4 加解密
- `scripts/android/kktkky_g18_img.py` — IMG 解码

### 私有工作目录（private-mxxy-work，不进 Git）
- `offline-apk/patch-skip-v5-unsigned.apk` — 补丁后未签名 APK (2GB)
- `offline-apk/dist/mxxy-patch-v5-signed.apk` — 已签名可安装 APK
- `unpacked/patch-skip/` — apktool 解包目录（含所有 smali）
- `runtime/logs/device-shots-smali/` — 测试截图
- `runtime/logs/device-shots-bypass/` — 测试截图
- `runtime/logs/trace-events.jsonl` — Frida 追踪事件
- `runtime/logs/gate-bypass-events.jsonl` — Gate bypass 事件
- `runtime/logs/run_gate_bypass.py` — Frida 启动脚本
- `runtime/logs/patch-failopen.js` — Frida failopen 脚本
- `runtime/logs/trace-check-header.js` — __android_log_print 追踪
- `runtime/logs/java-diag.js` — Java bridge 诊断
- `runtime/logs/loopback_stub_server.py` — Loopback HTTP stub 服务器
