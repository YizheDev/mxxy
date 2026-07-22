# Agent 工作约定

任何新 Agent 开始工作前必须完整阅读 `docs/HANDOFF.md`，再按其中“下一步”选择任务。`docs/HANDOFF.md` 是当前状态的唯一权威来源；其他报告可能是历史快照。

## 每次工作的最低要求

1. 先检查实际工作树、当前分支、制品哈希和已有实验输出，不依赖对话记忆代替证据。
2. 动态实验保持 Wi-Fi、移动数据和第三方域名访问关闭。只允许在本地模拟器/测试机和本仓库范围内操作。
3. 不提交原始 APK、WPK/IDX、THI/THX、DEX、SO、完整反编译树、设备日志、账号/设备标识、密钥或令牌。
4. 对新结论记录：命令/环境、观察结果、证据强度、失败尝试、下一步；同步更新 `docs/HANDOFF.md` 和相应专项文档。
5. 不把启动到补丁失败页面称为“游戏可玩”，不把 UI 成功提示称为“数据事务成功”，不把资源名称存在称为“资源完整”。
6. 任何修改都要运行 `make verify`；涉及 APK 的结论还要通过 `docs/IMPLEMENTATION_SPEC.md` 的相应门槛。

## 实现边界

- 允许：离线本地账号、免费商城、本地抽奖/保底、本地合宠公式、单人战斗、本地存档、原授权资源复用。
- 不允许：绕过或欺骗第三方服务器、伪造第三方支付、修改第三方账号/数据库、探测未授权基础设施。
- 最终 APK 必须独立包名、签名和离线标识，且禁用真实支付与所有第三方服务地址。

## 文档状态规则

`docs/HANDOFF.md` 顶部的 `last_verified` 必须在获得新证据后更新。每项状态只能使用：

- `verified`：有当前可复现证据。
- `partial`：只证明一部分，不能外推。
- `unknown`：尚无足够证据。
- `blocked`：明确外部前置条件，且本地替代路径已穷尽。

保留失败记录，防止后续 Agent 重复盲猜 RC4 密钥、无目标执行全库分析或联网测试第三方服务。

## ⚠️ 已确认的技术陷阱（2026-07-22 更新）

以下操作已被证实浪费时间或会导致错误，**新 Agent 必须跳过**：

| 陷阱 | 现象 | 正确做法 |
|------|------|----------|
| `Module.findExportByName(null, name)` | 抛出 `TypeError: not a function` | 改用 `Module.findGlobalExportByName(name)` |
| Frida `Java.perform` / `Java.performNow` | `Java` 对象始终 undefined（NetEase UniSec 保护阻止 Java bridge） | 用 smali 补丁或 SdkController 替代 |
| `libc.enumerateExports()` | 返回 0 条结果 | 用 `Module.findGlobalExportByName` 逐个查找 |
| `__android_log_print` 追踪下载器日志 | hook 成功但捕获不到下载器消息 | 下载器直接写 patchlog 文件，不走 Android logging |
| `curl_easy_perform` 等 libcurl 符号 | 全部返回 null | libcurl 静态链接在 libGame.so 中，无导出符号 |
| Smali `.locals 1` + 使用 v0,v1 两个寄存器 | `VerifyError: invalid argument count exceeds outsSize` | `.locals 1` 时只能用 v0，多用寄存器需增加 `.locals N` |
| `LogUtil.i(String, String)` 签名 | smali 中写成 `invoke-static {v0, v1}, LogUtil;->i(Ljava/lang/String;)V` 参数不匹配 | LogUtil.i 接受 (String, String) 两个参数 |
| apktool 重建 APK | 产物缺少 AndroidManifest.xml | 从 `original/AndroidManifest.xml` 手动注入 |
| SdkController smali 查找 | 文件不在 apktool 解包目录中 | **使用 ClassLoader 劫持**：在 smali_classes4 中放置同名类，基 APK 优先加载 |
| Stub 文件写入 APP 私有目录 | `Permission denied` | 用 `adb push`（root）在 APP 启动前预置文件 |
| Frida getaddrinfo Interceptor.replace | 导致 SIGSEGV 崩溃 | 不要在 Frida 中完全替换 getaddrinfo，改用 Interceptor.attach |
| libGame.so 二进制 URL patch | 替换字符串长度必须完全一致 | 短于原始值的 URL 用 \\x00 填充到相同长度 |
| NeteaseBase.init() 中调用 setPropStr | String.substring(-1) 崩溃 | SdkNetease 重写了 setPropStr 做额外验证，init 阶段不可直接调用 |
