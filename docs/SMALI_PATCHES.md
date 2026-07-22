# Smali 补丁文档 — 离线门闩绕过

本文档记录通过 smali 补丁绕过离线启动门闩的完整方案。所有补丁已通过 apktool 重建、签名、安装和运行验证。

```yaml
updated: 2026-07-22T18:45+0800
status: partial (3 gates bypassed, 1 remaining)
apktool_version: 3.0.3
target_apk: kktkky-MXXY_M-1.563.apk
```

## 补丁概览

| # | 目标类 | 方法 | 修改 | 目的 |
|---|--------|------|------|------|
| 1 | `PatchListProxy` | `needDownload()Z` | return false | 跳过补丁列表下载 |
| 2 | `Untitles` | `checkHeaderValue(String)Z` | return true | 绕过 HTTP 响应头验证 |
| 3 | `HttpDnsAgent` | `switchDnsMode(Context, String)Z` | return true | 阻止 HTTP DNS 重试循环 |
| 4 | `HttpDns` | `fetch(Context, String, boolean)Z` | return true | 阻止 DNS 网络拉取 |

## 构建流程

```bash
# 1. 解包 APK
apktool d input.apk -o unpacked/patch-skip

# 2. 修改 smali 文件（见下文各节）

# 3. 重建 APK
apktool b unpacked/patch-skip -o patch-skip-unsigned.apk

# 4. 注入 AndroidManifest.xml（apktool 重建时缺少）
python3 -c "
import zipfile, shutil
shutil.copy2('patch-skip-unsigned.apk', 'patch-skip-fixed.apk')
with open('unpacked/patch-skip/original/AndroidManifest.xml', 'rb') as f:
    data = f.read()
with zipfile.ZipFile('patch-skip-fixed.apk', 'a', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('AndroidManifest.xml', data)
"

# 5. 对齐和签名
zipalign -p -f 4 patch-skip-fixed.apk patch-skip-aligned.apk
apksigner sign --ks keystore/offline-debug.jks \
  --ks-pass pass:mxxyoffline --ks-key-alias mxxy-offline \
  --key-pass pass:mxxyoffline --out dist/signed.apk \
  patch-skip-aligned.apk

# 6. 安装
adb install -r dist/signed.apk
```

## Smali 文件路径

所有 smali 文件位于 apktool 解包目录：
```
unpacked/patch-skip/
  smali_classes8/com/netease/download/list/PatchListProxy.smali
  smali_classes6/com/dev/downloader/utils/Untitles.smali
  smali/com/netease/ntunisdk/core/httpdns/HttpDnsAgent.smali
  smali/com/netease/ntunisdk/core/httpdns/dns/HttpDns.smali
```

---

## 补丁 1: PatchListProxy.needDownload

**文件**: `smali_classes8/com/netease/download/list/PatchListProxy.smali`
**方法**: `needDownload()Z`
**作用**: 补丁列表下载入口，返回 false 可完全跳过 HTTP 下载

### 原始逻辑
```java
public boolean needDownload() {
    // 检查文件是否存在、MD5 是否匹配等
    // 返回 true 时触发 HTTP 下载
}
```

### 补丁后 smali
```smali
.method public needDownload()Z
    .locals 2
    const/4 v0, 0x0
    return v0
.end method
```

### 效果
- `PatchListProxy.start()` 检查 `needDownload()` 返回 false → 走 skip 分支
- `sendFinishMsg(0, …)` + return 0
- native 层收到成功信号，不弹「解析下载列表出错」

---

## 补丁 2: Untitles.checkHeaderValue

**文件**: `smali_classes6/com/dev/downloader/utils/Untitles.smali`
**方法**: `checkHeaderValue(Ljava/lang/String;)Z`
**作用**: HTTP 响应头验证函数

### 原始逻辑
```java
public static boolean checkHeaderValue(String str) {
    if (str == null) return false;
    for (int i = 0; i < str.length(); i++) {
        char c = str.charAt(i);
        if ((c <= 31 && c != '\t') || c >= 127) return false;
    }
    return true;
}
```

验证字符串是否仅包含合法的 ASCII 可打印字符（+ tab）。

### 补丁后 smali
```smali
.method public static checkHeaderValue(Ljava/lang/String;)Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method
```

### 效果
- 所有 header 值验证通过（包括空值、null、异常字符）
- 解决了 `[Downloader]Check header error` 错误
- 该错误发生在 native 层尝试下载 shapeconfig 资源文件时的响应验证阶段

---

## 补丁 3: HttpDnsAgent.switchDnsMode

**文件**: `smali/com/netease/ntunisdk/core/httpdns/HttpDnsAgent.smali`
**方法**: `switchDnsMode(Landroid/content/Context;Ljava/lang/String;)Z`
**作用**: NetEase HTTP DNS 模式切换入口

### 原始逻辑
```java
public static boolean switchDnsMode(Context ctx, String domain) {
    // 检查缓存的 DNS 条目
    // 如果 IP 优先 → 切换下一个 IP 或回退本地 DNS
    // 如果本地优先 → 切换到 IP 优先
    // 如果无缓存 → HTTP DNS fetch
    HttpDns.getInstance().fetch(ctx, domain, true); // 阻塞网络调用
}
```

### 补丁后 smali
```smali
.method public static switchDnsMode(Landroid/content/Context;Ljava/lang/String;)Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method
```

### 效果
- 阻止所有 HTTP DNS 网络请求
- 解决飞行模式下 `NeteaseHttpDns` 无限重试循环（每 10 秒一次）
- 错误码 Error Code: 2 和 Error Code: 3 不再出现

---

## 补丁 4: HttpDns.fetch

**文件**: `smali/com/netease/ntunisdk/core/httpdns/dns/HttpDns.smali`
**方法**: `fetch(Landroid/content/Context;Ljava/lang/String;Z)Z`
**作用**: HTTP DNS 实际网络拉取

### 原始逻辑
```java
public boolean fetch(Context ctx, String url, boolean ipPrior) {
    String host = NetUtils.getHost(url);
    if (TextUtils.isEmpty(host)) return false;
    updateAnycastIp(ctx);
    HttpDnsHandler handler = new HttpDnsHandler();
    // HTTP 请求获取 DNS 记录
    HandlerResult result = handler.fetchHostAddress(appId, host, appKey);
    // 缓存结果
    if (result != null && result.ips != null && !result.ips.isEmpty()) {
        dnsMap.records.put(host, new HttpDnsEntry(result.ips)...);
        return true;
    }
    return false;
}
```

### 补丁后 smali
```smali
.method public fetch(Landroid/content/Context;Ljava/lang/String;Z)Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method
```

### 效果
- 任何 DNS fetch 请求直接返回成功
- 防止 `switchDnsMode` 之外的代码路径触发网络请求

---

## Smali 编写注意事项

### `.locals` 计数
```smali
# 错误: .locals 1 但使用了 v1
.method public static foo()Z
    .locals 1
    const-string v0, "tag"       # 使用 v0
    const-string v1, "message"   # v1 不存在! → VerifyError

# 正确: 不需要额外 local 时只用 v0
.method public static foo()Z
    .locals 1
    const/4 v0, 0x1             # 仅用 v0
    return v0
```

### LogUtil.i 签名
```smali
# NetEase 下载器 LogUtil 位于 com/netease/download/util/LogUtil
invoke-static {v0, v1}, Lcom/netease/download/util/LogUtil;->i(Ljava/lang/String;Ljava/lang/String;)V

# 其他模块的 LogUtil 位于不同包:
invoke-static {v0}, Lcom/netease/ntunisdk/core/httpdns/widget/Logging;->detail(Ljava/lang/String;)V
invoke-static {v0, v1}, Lcom/dev/downloader/utils/LogUtil;->i(Ljava/lang/String;Ljava/lang/String;)V
```

### 方法参数与寄存器
- 静态方法: p0, p1, ... 为方法参数
- 实例方法: p0 = this, p1+ = 方法参数
- v0, v1, ... 为局部变量（数量由 .locals 声明）

---

## 验证结果

```
✅ APK 重建成功 (apktool 3.0.3)
✅ AndroidManifest.xml 手动注入成功
✅ zipalign 通过
✅ apksigner v1/v2/v3 签名验证通过
✅ 安装成功 (adb install -r)
✅ 飞行模式下启动成功
✅ 无 VerifyError 崩溃
✅ 无下载器错误 (patchlog 不存在)
✅ 无 HTTP DNS 循环错误
✅ OpenGL 渲染引擎初始化 (logcat: "OpenGLRendor")
🟡 卡在 splash 画面（待绕过 UniSDK 登录）
```

## 未包含的补丁

以下类在受保护的 DEX 中（核心 classes.dex），apktool 无法反编译，因此无法进行 smali 补丁：
- `com.netease.my.SdkController` — 登录/认证/支付控制
- `com.netease.game.MessiahNativeActivity` — 主 Activity
- `com.netease.messiah.Platform` — Messiah 引擎桥接

这些需要 native hook（Frida/libGame.so）或其他绕过方案。

## 换机复现

在新设备上：
1. 克隆仓库并准备私有工作目录（详见 `docs/GIT_AND_MIGRATION.md`）
2. 安装 apktool 3.0.3+
3. 在原始 APK 上执行 `apktool d` 解包
4. 按本文档修改对应 smali 文件
5. 按构建流程重建 APK
6. 用独立签名安装测试
