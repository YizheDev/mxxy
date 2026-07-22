# 隔离动态审计日志

所有实验都在用户授权样本和本地 ARM64 AVD 中完成。Wi-Fi、移动数据关闭，飞行模式开启；未探测、登录或写入第三方服务。本文只保存脱敏后的技术证据。

## 环境基线（2026-07-22）

| 项目 | 已验证值 |
|---|---|
| Host | Apple Silicon arm64 macOS 26.4.1 |
| Java | OpenJDK 21.0.11 |
| Emulator | 36.6.11 |
| ADB | 1.0.41 / platform-tools 37.0.0 |
| Guest | Android 11 / API 30 default arm64-v8a |
| AVD | Pixel 4，12 GiB data，4 GiB RAM，host GPU |
| Frida | host/server 17.16.4，tools 14.10.4 |
| App | `com.netease.my`，1.555.0/15550 |

## 实验 1：安装、保护层文件和原生装载

结果：APK 在 ARM64 AVD 安装成功。启动阶段观察到：

- `app_ntp0/1.555.0_15550/.ntp.dex`：69 bytes。
- `.ntp2.dex`：0 bytes。
- `.unzip/classes.dex`：8,763,836 bytes，但首次落盘是私有格式。
- 私有格式文件 SHA-256：`8c4740aaaf0a134a875e2ded97f4f63d578c54209b82a3b8a273c8d8035ca355`。

第一次追踪脚本用 Java 替换 `System.loadLibrary`，导致 `UnsatisfiedLinkError: libGame.so not found`。根因是替换改变了 Android 按调用者类选择 ClassLoader 的语义。处理：删除 Java 层替换，仅保留 `android_dlopen_ext` 等 native 日志。结果：`libGame.so` 正常加载。

## 实验 2：JNI 映射

`libunisec.so` 运行时 `RegisterNatives` 记录：

| Java native | 签名 | 模块偏移 |
|---|---|---:|
| `initNative` | `(String,String,String,String,int)V` | `0x49f80` |
| `initDexOptDexLoad` | `(int,int)I` | `0x4b100` |
| `II0IOI0O` | `(Context)Object` | `0x4f29c` |
| `II0IOI00` | `(ClassLoader)V` | `0x4ff04` |
| `II0IOIOO` | `(ClassLoader,Object[])V` | `0x5216c` |
| `II0IOIO0` | `(ArrayList,ClassLoader,File,boolean)Object[]` | `0x51388` |
| `II0I0IO0` | `(String,String,String,boolean,boolean)V` | `0x4f940` |
| `onCreate` | `()V` | `0x54570` |

偏移以当前 `libunisec.so` 为准；换样本必须重新测量。

## 实验 3：运行时 DEX 导出

脚本扫描 1,805 个可读内存范围，导出 48 个标准 DEX，合计 119,663,024 bytes。扫描期间有少量不可读页异常，但遍历完成。

核心文件：

```text
size:   8,763,836 bytes
magic:  dex\n035
sha256: 62de0096e2d045633af22effaf4c0c61cb726ba41500006833a4743305d3debc
```

JADX 1.5.6 处理约 1,952 classes，完成时 7 个错误，生成 3,141 个 Java 文件。确认存在 `PatchListCore`、`PatchListProxy`、`MessiahNativeActivity`、`MessiahNativeActivityBase`、`SdkController`。

## 实验 4：离线启动和补丁边界

通过 Java `Button.performClick()` 在本地接受隐私协议后，断网界面显示：

- “下载列表失败，请稍后重试？”
- “获取补丁列表失败，请检查网络后重试”
- 客户端/引擎版本均显示 1.555.0。

观察到客户端尝试构造三个动态 `shapeconfig` 资源名：

```text
c4/b00e0c05975f81d4025c0aa8212a9b  suffix=e2shapeconfig
d9/d4ea67004deafb19640d8e441ed182  suffix=e1shapeconfig
8b/a3208b364f1e51fe3e499cea0f1026  suffix=e1shapeconfig
```

请求因网络隔离以 curl code 6 失败。没有主动重放这些请求。结论：当前版本至少部分形状配置依赖未随基础 APK 安装的动态资源，不能宣称所有宠物资源完整。

## 实验 5：本地引擎能力

补丁失败前后仍观察到：

- `libGame.so` 成功装载。
- Skeleton、Material、Scene 等大量 Messiah 引擎类型注册。
- 文件、内存、日志和渲染子系统初始化。
- 生成数百个 `LocalShaders/es3_noubo` cache 和 `compiled.es3_noubo`。

因此“本地渲染管线能启动”已验证；“宠物可完整显示”尚未验证。日志还提示缺少 `qatest.lua`、`char_param4game/lib_uiext.lua`、两个 emote plist。AVD 不支持 ASTC 并产生 GL 错误，最终视觉验收需 ASTC 兼容环境。

## 实验 6：资源追踪器稳定性

初版同时挂 read/pread/memcmp/strcmp，启动时触发 Android 11 `perfetto_hprof` 预初始化线程崩溃。调整为：

- open/openat、`AAssetManager_open` 从进程启动立即挂钩。
- AAsset data 与 read/pread 延迟 1,500 ms。
- memcmp/strcmp/strncmp 延迟 2,500 ms。

调整后 spawn 稳定，但没有出现 HashRes 读取事件。当前推断（未证实）：资源可能通过 base.apk 的 ZIP offset + mmap、自定义归档或未覆盖的文件描述符 API 读取。

下一实验应覆盖：`mmap`、`AAssetManager_openFileDescriptor`、minizip/zlib、APK ZIP 映射，并把文件描述符和 offset 关联回 base.apk 条目。

## 实验 7：URL xref + shapeconfig MD5 映射（2026-07-22）

`arm64_string_xrefs.py` 对 static/dynamic URL RVA 得到 10 个 ADRP+ADD 命中（见 `$MXXY_WORK/runtime/logs/url-rva-xrefs.json`）。

运行时确认：

| RVA | 作用 |
|---|---|
| `0x1cb53c0` | 16-byte MD5 → `xx/yyyy...` 相对路径 |
| `0x1cb6040` / `0x1cb60d4` | 取 static/dynamic base 字符串 |
| `0x1cbb4e4` | dynamic base + 相对路径 → 完整 URL |

三个离线失败下载与 `shapeconfig.thx` 记录对应：CDN MD5 = THX 记录 `opaque_id_a \|\| opaque_id_b[0:4]`；后缀 `e1shapeconfig` / `e2shapeconfig`。

## 实验 8：g18 容器解析与 `_g18RC4_` 明文（2026-07-22）

Marker `strncmp` 回溯定位解析器：

| Marker | Parser RVA | 行为 |
|---|---|---|
| `_g18RC4_` | `0x1cfe480` | 去 8 字节魔数后 RC4；导出 consolidate JSON 与 43 项 `pkginfo` |
| `_g18xxh_` | `0x1cfd2e0` | 去 12 字节头；输出 `ZZZ4` 或嵌套 `_g18RC4_2` |

RC4 底层：`0x1bc569c` 初始化状态，`0x1bc58e8` PRGA。从 ciphertext/plaintext 对恢复 **5952-byte 包级静态 keystream**（非盲猜密钥穷举）。工具：`scripts/android/kktkky_g18_crypto.py`。原始 dump：`$MXXY_WORK/runtime/logs/decrypt-dumps/`。

`_g18RC4_2` 不能套用该 keystream。Json.idx 等条目在 xxh 解包后均为 `_g18RC4_2`。

在 `pkres/data` 等路径预置 stub **未**阻止 dynamic URL 构造；仍不伪造 HTTP 成功响应。

## 已知 native 定位点

当前 `libGame.so` SHA-256：

```text
65fb150c91f4e625c31dd954da12fdbe92870bcfcb47eea5ac7b61bccf1e7f9a
```

| 含义 | file offset / RVA |
|---|---|
| static base URL | file `0x4b2c0e8` / RVA `0x4b2e0e8` |
| dynamic base URL | file `0x4b2c2e8` / RVA `0x4b2e2e8` |
| path format | RVA `0x1cb53c0` |
| dynamic URL build | RVA `0x1cbb4e4` |
| `_g18RC4_` parser | RVA `0x1cfe480` |
| `_g18xxh_` parser | RVA `0x1cfd2e0` |
| RC4 KSA helper | RVA `0x1bc4c98`（候选） |
| RC4 PRGA | RVA `0x1bc58e8` |

勿再对全库跑 `aaaa`。

## 未解决问题清单

1. 12-byte IDX path ID 的生成/加密函数。
2. THI/THX 字段语义及其与 IDX ID 的关联（CDN MD5 映射已部分 verified）。
3. `_g18RC4_2` 密钥材料与解密后格式。
4. shapeconfig 解析入口、三个缺失补丁的本地替代、最小可用宠物配置。
5. 宠物 ID 到模型/材质/动作/头像/技能的完整链（G1）。
6. 抽奖、合宠、战斗的 native/脚本协议边界。

## 2026-07-22 Gate Bypass 会话

### Frida Java bridge 诊断（新发现）
- `Java` 对象在 spawn 和 attach 模式均保持 undefined（验证 140+ 次，28s+）
- `Module.findExportByName(null, name)` 在该 Frida 17.16.4 + Android 11 组合下抛 `TypeError: not a function`
- 需改用 `Module.findGlobalExportByName(name)`
- `libc.enumerateExports()` 返回 0 条（可能被 UniSec 限制）
- **结论**: NetEase UniSec 保护阻止 Frida Java bridge 初始化，Java hooks 不可用

### Smali 补丁 — 下载器门闩绕过
- `PatchListProxy.needDownload()` → `return false`（跳过 patch list HTTP 下载）
- `Untitles.checkHeaderValue(String)` → `return true`（绕过响应头验证）
- APK 通过 apktool 3.0.3 重建，手动注入 `original/AndroidManifest.xml`
- zipalign + apksigner v1/v2/v3 签名成功

### Smali 补丁 — HTTP DNS 循环绕过
- `HttpDnsAgent.switchDnsMode(Context, String)` → `return true`
- `HttpDns.fetch(Context, String, boolean)` → `return true`
- 消除了飞行模式下每 10 秒的 `NeteaseHttpDns` Error Code 2/3 重试循环

### 测试结果
- ✅ 飞行模式启动: 无下载错误（patchlog 不存在）
- ✅ OpenGL 渲染引擎初始化 (`OpenGLRendor: start to call display`)
- ✅ 启动序列完成 (`app time recorder end`, 55s 三阶段倒计时)
- 🟡 Splash 画面卡住（待绕过 UniSDK 登录）

### 未解决问题更新
- 7. **UniSDK 登录绕过**: SdkController 在受保护 DEX，需从可访问的 SdkBase/NeteaseBase smali 或 libGame.so native 层绕过
