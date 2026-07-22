# kktkky-MXXY_M-1.563.apk 静态逆向报告

分析日期：2026-07-22
样本：`kktkky-MXXY_M-1.563.apk`（原始 APK 不进入 Git，校验和见制品清单）

> 状态说明：本文保留初始静态审计证据。动态阶段已经完成，最新结论、修正和下一步以 `HANDOFF.md` 与 `DYNAMIC_AUDIT_LOG.md` 为准。

## 1. 结论摘要

该 APK 是一个经过网易 `StubApp` / `UniSec` 原生保护、并集成 `UniFix` 热更新的 Android 游戏包。外层 DEX 主要暴露 SDK、渠道和保护壳代码，核心入口 `com.netease.game.MessiahNativeActivity` 不在当前可见 DEX 中；启动阶段会把 `assets/_ntcfgss.dat` 复制为 `.unzip/classes.dex`，再由保护层继续处理或装载，因此下一阶段需要在受控 ARM64 Android 环境中动态抓取解密后的 DEX。

包内同时存在三组很强的定制构建信号：Android Debug 证书、文件名 `1.563` 与内部版本 `1.555.0` 不一致、认证及资源地址被替换为 `czzdpb.com`。据此可高置信度判断它不是原发行方的标准生产签名包，而是重签/定制服务器构建；这只描述技术形态，不对来源或用途作恶意判断。

已确认一个高风险安全问题：导出的 `UxFileProvider` 无读写权限保护，并将应用私有 `files/` 与 `cache/` 的根目录全部映射出去。任意本机应用在知道相对文件名时，可以读取、覆盖、截断或删除其中的文件。

## 2. 样本基线

| 项目 | 值 |
|---|---|
| 文件大小 | 2,063,820,551 bytes（约 1.92 GiB） |
| MD5 | `fe95da770df23eced0db31d63ba7a6d0` |
| SHA-1 | `67283d715dacb277b7ecf7b4daec2dfd7271f443` |
| SHA-256 | `d520f56c541cb2400f7cf0048a66f328a91355f292425f3afba532c568bd0543` |
| 包名 | `com.netease.my` |
| 内部版本 | `versionCode=15550`, `versionName=1.555.0` |
| SDK | `minSdk=21`, `targetSdk=30` |
| ZIP 条目 | 6,254 |
| DEX | 10 个，约 39 MB |
| 原生库 | 132 个，`arm64-v8a` 与 `armeabi-v7a` |

JADX 1.5.6 对抽取后的 DEX 共处理 11,233 个类，报告 113 个反编译错误，约占 1%。这足以审计外层 Java/Kotlin 代码，但不代表核心保护内容已经恢复。

构建信息 `assets/__version`：

```json
{"version":"release-v1.15.0.4","svnVer":"155174","isOversea":false,"taskId":"g18_wb.linshuting_20260311025420_DUi6P"}
```

`taskId` 中的数字看起来对应 2026-03-11 02:54:20；这是基于命名格式的推断，不是签名时间证明。

## 3. 签名与构建形态

- V1/JAR 签名校验通过。
- 证书主题和签发者均为 `CN=Android Debug, O=Android, C=US`。
- 证书 SHA-256：`CA:7D:15:4E:FB:0C:CF:CD:7E:2A:73:D5:E9:C6:D6:0E:99:39:14:FB:DD:76:28:64:B4:55:AC:A9:C2:59:1B:1A`。
- 证书有效期：2022-01-10 至 2052-01-03。
- APK 文件名为 `1.563`，Manifest 内部版本为 `1.555.0`。

如果这是要对外分发的正式包，应改用受控的发布证书，并把版本信息纳入可重复构建和发布校验。

## 4. 壳、隐藏 DEX 与动态装载

Manifest 的 Application 是：

```text
com.netease.ntunisdk.unifix_hotfix_library.proxyApplication.UFProxyApplication
```

元数据继续指向：

```text
UNIFIX_APPLICATION_CLASS_NAME=com.netease.android.protect.StubApp
APPLICATION_CLASS_NAME=com.netease.ntunisdk.application.NtSdkApplication
```

保护层代码会执行以下流程：

1. 读取 `assets/_ntcfg_.data`；其首个小端整数为 `1`，表示一个隐藏 DEX 数据文件。
2. 将 `_ntcfgss.dat` 复制成应用私有目录下 `.unzip/classes.dex`，并设为只读。
3. 配合 `.ntp.dex`、`libunisec.so` 和本地代码继续装载。

证据位于：

- `projects/android/kktkky-mxxy-1-563/jadx/sources/com/netease/android/protect/a.java:214`
- `projects/android/kktkky-mxxy-1-563/jadx/sources/com/netease/android/protect/a.java:299`
- `projects/android/kktkky-mxxy-1-563/jadx/sources/com/netease/android/protect/a.java:336`

`_ntcfgss.dat` 大小为 8,763,836 bytes，SHA-256 为 `8c4740aaaf0a134a875e2ded97f4f63d578c54209b82a3b8a273c8d8035ca355`，没有裸 DEX/ZIP/ELF 文件头。因此仅把它改名后交给 JADX 不会得到核心代码。

## 5. 原生层观察

主库 `libGame.so`：

- ARM64 大小 80,324,352 bytes。
- SHA-256：`65fb150c91f4e625c31dd954da12fdbe92870bcfcb47eea5ac7b61bccf1e7f9a`。
- Build ID：`483048d3ef0c770d937b76575e42394659ebaa3a`。
- 已剥离符号，启用 NX、RELRO 与 `BIND_NOW`。
- ELF section-name string table 异常，Rizin/LLVM 对多个节名给出无效或乱码结果；动态符号也有明显随机化。这是有意的原生混淆/加固信号。
- 字符串中出现 `/proc/self/maps`，可能用于模块枚举、诊断或反注入检查；当前没有足够证据将其直接定性为反 Frida。
- 能看到 `Messiah::GExternalProfilerThreadContext`，与 Manifest 中的 Messiah 游戏入口一致。

## 6. 网络与资源定制

Java 层将生产和测试认证入口都设为：

```text
https://auth.czzdpb.com/mpay
```

证据：`projects/android/kktkky-mxxy-1-563/jadx/sources/com/netease/mpay/ServerAddress.java:14` 和 `:20`。

`libGame.so` 中还存在：

```text
http://zy.czzdpb.com/static/
http://zy.czzdpb.com/dynamic/
```

Manifest 与 `network_security_config.xml` 都允许全局明文 HTTP。若资源层没有额外的签名/哈希校验，HTTP 资源存在被同网段或链路中间人篡改的风险；是否存在有效内容校验仍需动态验证。本次没有主动访问或探测上述域名，因为用户对 APK 的授权不自动扩展到第三方服务器。

`HashRes` 下 5 个资源索引以 `_g18RC4_` 开头，`.idx` 以 `SKPW` 开头，大型 `.wpk` 为资源容器。已尝试若干直观候选密钥但没有恢复明文；下一步应在应用完成解密后抓缓冲区，而不是继续盲猜密钥。

## 7. 已确认安全问题：导出私有文件 Provider

### 严重度

高。若 `files/` 中保存账号、会话、热更新、配置或脚本，实际影响可能上升。

### 证据链

Manifest 将 Provider 无权限导出：

```xml
<provider
    android:name="org.gux.widget.provider.view.support.UxFileProvider"
    android:authorities="com.netease.my.widget_file_provider"
    android:exported="true"
    android:grantUriPermissions="true" />
```

路径配置映射完整私有目录：

```xml
<cache-path name="widget_file_cache" path="/" />
<files-path name="widget_files" path="/" />
```

Provider 实现支持 `r`、`w`、`wt`、`wa`、`rw`、`rwt`，并直接提供 `openFile()` 和 `delete()`，没有调用方权限检查。相应证据：

- `resources/AndroidManifest.xml:520`
- `resources/res/xml/widget_file_provider_path.xml:4`
- `UxFileProvider.java:193`
- `UxFileProvider.java:270`
- `UxFileProvider.java:297`

此外，路径边界检查只用了字符串 `startsWith(rootPath)`。即使未来缩窄根目录，也应使用 `candidate.equals(root) || candidate.startsWith(root + File.separator)`，避免相同前缀目录绕过。

### 修复

1. 如果仅应用内部使用，设 `android:exported="false"`。
2. 如果确需跨应用共享，使用 signature 级读写权限或只对单个 URI 临时授权。
3. 不要把 `files/`、`cache/` 根目录整体映射，改成专用子目录。
4. 能只读就不要开放写入、截断和删除。
5. 修复规范化路径的目录边界判断，并加入负向测试。

动态验证时只在模拟器中创建无敏感测试文件，验证读取/覆盖后立即清理；不要对真实用户数据执行删除测试。

## 8. Manifest 攻击面

- 59 项权限声明，其中包含电话状态、存储、悬浮窗、录音、相机、定位、安装 APK、日历等高敏感权限；部分系统/签名权限在普通安装中不会被授予。
- 组件规模：169 Activities、20 Services、10 Receivers、18 Providers、6 Activity aliases。
- 多个支付、分享和深链 Activity 被导出。当前没有静态确认可直接利用的问题，但动态阶段应重点做 Intent 参数污染、身份校验和敏感返回值检查。
- `allowBackup=false`，这是合理配置。
- `requestLegacyExternalStorage=true` 与 `targetSdk=30` 表明仍依赖旧存储模型，建议逐步迁移。

## 9. 动态逆向方案与后续结果

仓库提供保护层抓点脚本：

```text
scripts/android/kktkky-unpack-trace.js
```

推荐在隔离的 ARM64 模拟器或测试机上：

```bash
frida -U -f com.netease.my -l scripts/android/kktkky-unpack-trace.js
```

脚本记录 `open/openat/close`、`dlopen/android_dlopen_ext`、`AAssetManager_open`、`DexClassLoader`、`DexFile.loadDex` 与 `RegisterNatives`，重点观察 `.unzip/classes.dex`、`_ntcfgss.dat`、`HashRes`、`libunisec.so` 和 `libGame.so`。

后续已在网络隔离的 Android 11 ARM64 AVD 中实测：恢复了 8,763,836-byte 标准核心 DEX、`MessiahNativeActivity` 等类和 `libunisec.so` JNI 映射；`libGame.so` 及本地渲染子系统可以启动。资源解密和宠物路径映射仍在进行，详情见 `DYNAMIC_AUDIT_LOG.md`。

当前动态目标：

1. 覆盖 APK ZIP/mmap/文件描述符资源读取，获得首个 WPK marker 调用栈。
2. 定位 URL 构造与 shapeconfig 解析边界，关联逻辑资源名、12-byte path ID 与本地条目。
3. 在 `_g18RC4_2` 解析函数返回点导出解密 buffer，确认二进制封装。
4. 闭合至少一个宠物的模型、材质、动作、头像和技能图标链。

## 10. 产物位置

Git 只保留 `scripts/android/` 下的抓取工具和 `artifacts/manifests/` 下的哈希。JADX、Manifest/资源、DEX 和 ARM64 原生库放在仓库外的私有工作目录，按 `ENVIRONMENT_RUNBOOK.md` 再生或迁移。
