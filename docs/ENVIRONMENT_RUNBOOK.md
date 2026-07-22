# 环境复现手册

本手册用于在新 Mac/Linux 设备上复现审计环境。所有路径都通过任务专用变量传入，禁止把本机绝对路径写入仓库。

## 1. 输入与变量

```bash
export MXXY_REPO=/absolute/path/to/mxxy
export MXXY_APK=/absolute/path/to/kktkky-MXXY_M-1.563.apk
export MXXY_WORK=/absolute/path/to/private-mxxy-work
export ANDROID_SDK_ROOT=/absolute/path/to/android-sdk
```

校验输入：

```bash
shasum -a 256 "$MXXY_APK"
```

必须得到：

```text
d520f56c541cb2400f7cf0048a66f328a91355f292425f3afba532c568bd0543
```

若不同，停止沿用现有偏移、版本和结论，为新样本创建独立清单。

## 2. 已验证工具版本

以下是已成功运行的组合，不是唯一可用组合：

- Apple Silicon / arm64 macOS 26.4.1
- OpenJDK 21.0.11
- Android emulator 36.6.11
- Android platform-tools 37.0.0，ADB 1.0.41
- Android 11 / API 30 default arm64-v8a system image
- Frida host/server 17.16.4，frida-tools 14.10.4
- JADX 1.5.6
- Python 3、Node.js、Rizin

先验证仓库脚本：

```bash
cd "$MXXY_REPO"
make verify
```

## 3. 私有工作目录

建议结构：

```text
$MXXY_WORK/
  input/                 原始 APK
  unpacked/              apktool/unzip 输出
  hashres/data/          IDX/WPK
  hashres/thd/           THI/THX
  runtime/dex/           Frida 导出的 DEX
  runtime/native/        本次使用的 SO 副本
  runtime/logs/          未脱敏原始日志，不提交
  jadx-core/             核心 DEX 反编译树
```

该目录可删除后再生，但成本较高。跨设备时可通过用户控制的加密私有存储同步；不要放进普通 Git。

## 4. 静态资源检查

假定 `HashRes` 已从 APK 解包到 `$MXXY_WORK/hashres`：

```bash
python3 "$MXXY_REPO/scripts/android/kktkky_wpk_index.py" \
  --inventory-dir "$MXXY_WORK/hashres/data" --json \
  > "$MXXY_WORK/wpk-inventory.json"

python3 "$MXXY_REPO/scripts/android/kktkky_thd_index.py" \
  --inventory-dir "$MXXY_WORK/hashres/thd" --json \
  > "$MXXY_WORK/thd-inventory.json"
```

仓库快捷命令：

```bash
cd "$MXXY_REPO"
make inventory HASHRES_DIR="$MXXY_WORK/hashres"
```

期望摘要：21 IDX、153,400 WPK 条目；194 THI/THX、604,222 条记录。

## 5. 隔离 Android 环境

已验证 AVD 参数：Pixel 4、API 30、`default` arm64-v8a、12 GiB data、4 GiB RAM、host GPU。无需迁移 AVD，换机后重建即可。

启动后，在安装/启动目标应用前完成隔离：

```bash
adb shell svc wifi disable
adb shell svc data disable
adb shell settings put global airplane_mode_on 1
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true
adb shell settings get global airplane_mode_on
```

期望最后输出 `1`。同时从宿主防火墙阻止目标模拟器访问第三方域名。动态测试期间不要关闭隔离。

安装：

```bash
adb install -r "$MXXY_APK"
```

## 6. Frida 环境

Host 与 Android frida-server 必须严格同版本、同架构。将服务端二进制保存在私有工具目录，不提交仓库。

```bash
python3 -m venv "$MXXY_WORK/frida-venv"
"$MXXY_WORK/frida-venv/bin/pip" install \
  'frida==17.16.4' 'frida-tools==14.10.4'

adb push /absolute/path/to/frida-server-17.16.4-android-arm64 /data/local/tmp/frida-server
adb shell chmod 755 /data/local/tmp/frida-server
adb shell su -c '/data/local/tmp/frida-server >/dev/null 2>&1 &'
"$MXXY_WORK/frida-venv/bin/frida-ps" -U
```

抓取保护层与 DEX：

```bash
"$MXXY_WORK/frida-venv/bin/frida" -U -f com.netease.my \
  -l "$MXXY_REPO/scripts/android/kktkky-unpack-trace.js"

"$MXXY_WORK/frida-venv/bin/frida" -U -f com.netease.my \
  -l "$MXXY_REPO/scripts/android/kktkky-dex-dump.js"
```

资源路径追踪：

```bash
"$MXXY_WORK/frida-venv/bin/frida" -U -f com.netease.my \
  -l "$MXXY_REPO/scripts/android/kktkky-resource-trace.js"
```

原始日志只放 `$MXXY_WORK/runtime/logs`。提交结论前移除 app key、设备 ID、交易 ID、账号和 token。

## 7. 核心 DEX 验证

从运行时 dump 中选出大小 8,763,836 bytes 且以 `dex\n035` 开头的核心文件：

```bash
shasum -a 256 "$MXXY_WORK/runtime/dex/core-classes.dex"
```

期望 SHA-256：

```text
62de0096e2d045633af22effaf4c0c61cb726ba41500006833a4743305d3debc
```

反编译：

```bash
jadx -d "$MXXY_WORK/jadx-core" "$MXXY_WORK/runtime/dex/core-classes.dex"
```

JADX 少量错误不等于整体失败；记录版本、类数量、错误数量和目标类是否存在。

## 8. 复现结束检查

- 飞行模式保持开启，未向第三方域名发出成功请求。
- 样本/DEX/SO 哈希与清单一致。
- `make verify` 通过。
- 新观察已写入 `docs/DYNAMIC_AUDIT_LOG.md`，当前判断同步到 `docs/HANDOFF.md`。
- 原始日志和制品仍在私有目录，没有进入 Git 状态。

## 9. Smali 补丁 + APK 重建（门闩绕过）

此步骤用于绕过下载器门闩，使 APK 可在飞行模式下启动。详细文档见 `docs/SMALI_PATCHES.md`。

### 9.1 安装 apktool

```bash
brew install apktool
# 验证: apktool --version  # 应输出 3.0.3+
```

### 9.2 解包 APK

```bash
cd "$MXXY_WORK"
apktool d "$MXXY_APK" -o unpacked/patch-skip
```

### 9.3 应用 smali 补丁

修改以下 4 个文件（具体替换内容见 `docs/SMALI_PATCHES.md`）：

1. `unpacked/patch-skip/smali_classes8/com/netease/download/list/PatchListProxy.smali`
   - `needDownload()Z` → `const/4 v0, 0x0; return v0`

2. `unpacked/patch-skip/smali_classes6/com/dev/downloader/utils/Untitles.smali`
   - `checkHeaderValue(Ljava/lang/String;)Z` → `const/4 v0, 0x1; return v0`

3. `unpacked/patch-skip/smali/com/netease/ntunisdk/core/httpdns/HttpDnsAgent.smali`
   - `switchDnsMode(Landroid/content/Context;Ljava/lang/String;)Z` → `const/4 v0, 0x1; return v0`

4. `unpacked/patch-skip/smali/com/netease/ntunisdk/core/httpdns/dns/HttpDns.smali`
   - `fetch(Landroid/content/Context;Ljava/lang/String;Z)Z` → `const/4 v0, 0x1; return v0`

### 9.4 重建 APK

```bash
apktool b unpacked/patch-skip -o offline-apk/patch-skip-unsigned.apk
```

### 9.5 注入 AndroidManifest（apktool 重建时缺失）

```bash
python3 -c "
import zipfile, shutil
shutil.copy2('offline-apk/patch-skip-unsigned.apk', 'offline-apk/patch-skip-fixed.apk')
with open('unpacked/patch-skip/original/AndroidManifest.xml', 'rb') as f:
    data = f.read()
with zipfile.ZipFile('offline-apk/patch-skip-fixed.apk', 'a', zipfile.ZIP_DEFLATED) as zf:
    if 'AndroidManifest.xml' not in zf.namelist():
        zf.writestr('AndroidManifest.xml', data)
"
```

### 9.6 签名 + 安装

```bash
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools

# 对齐
$ANDROID_SDK_ROOT/build-tools/34.0.0/zipalign -p -f 4 \
  offline-apk/patch-skip-fixed.apk offline-apk/patch-skip-aligned.apk

# 签名（keystore 从私有目录复制，不进 Git）
$ANDROID_SDK_ROOT/build-tools/34.0.0/apksigner sign \
  --ks "$MXXY_WORK/offline-apk/keystore/offline-debug.jks" \
  --ks-pass pass:mxxyoffline --ks-key-alias mxxy-offline \
  --key-pass pass:mxxyoffline \
  --out dist/mxxy-patched-signed.apk \
  offline-apk/patch-skip-aligned.apk

# 安装
adb -s emulator-5554 install -r dist/mxxy-patched-signed.apk
```

### 9.7 启动测试

```bash
# 确保飞行模式
adb shell settings put global airplane_mode_on 1

# 启动
adb shell am start -n com.netease.my/com.netease.game.MessiahNativeActivity

# 验证
# - patchlog 不应存在（无下载错误）
# - 不应有 NeteaseHttpDns 循环日志
# - 不应有 VerifyError 崩溃
# - 应在 55s 后看到 app time recorder end
```
