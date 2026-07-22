# Git、制品与换机续接规范

## 为什么现在提交基线

审计本身已经产生可复现的代码、格式结论和失败经验。先提交基线可以让其他 Agent 在同一事实状态上继续，而不是重复解包、盲猜密钥或误以为 APK 已经可玩。

## 远端与分支

目标远端：

```text
https://github.com/YizheDev/mxxy.git
```

建议：

- `main`：经过校验的可交接状态。
- `codex/audit-*`：逆向、资源映射和探针。
- `codex/feat-offline-*`：本地存档、抽奖、合宠、战斗等实现。
- 达到关键里程碑后打 annotated tag，例如 `audit-v1`、`pet-render-v1`、`offline-alpha-v1`。

每个提交只包含一类变更，推荐前缀：`docs:`、`tools:`、`test:`、`feat(android):`、`fix(android):`。

## 哪些进入 Git

进入普通 Git：

- 脱敏 Markdown 结论、实验手册、设计和决策记录。
- 只读解析器、Frida 脚本、测试、构建配置。
- 输入和派生产物的 SHA-256、尺寸、逻辑名称。
- 后续可复现的 Android 源代码和非版权/自制资源。

不进入普通 Git：

- 1.92 GiB 原始 APK、WPK/IDX、THI/THX、DEX、SO。
- 约 3 GiB 反编译树、AVD、shader cache、运行截图/录屏。
- 原始设备日志、app key、设备/账号/交易 ID、token、密钥。
- 本机绝对路径和个人环境配置。

如需团队共享大文件，使用用户控制的私有对象存储或单独的私有 Git LFS 仓库；即使使用 LFS，也先确认这些授权资源允许上传。主仓库的哈希清单是两者的连接点。

## 首次提交与推送

```bash
cd /absolute/path/to/mxxy
make verify
git diff --check
git switch -c codex/audit-baseline
git add README.md AGENTS.md Makefile .gitignore .gitattributes \
  docs scripts artifacts
git commit -m "docs: add reproducible APK audit baseline"
git push -u origin codex/audit-baseline
```

若远端私有，先在本机通过 Git Credential Manager、GitHub CLI 或 SSH key 登录一个有写权限的账号。不要把 Personal Access Token 写入 remote URL、shell 历史或仓库文件。

## 新设备续接步骤

1. 安装 Git，配置有仓库权限的 GitHub 认证。
2. `git clone https://github.com/YizheDev/mxxy.git`。
3. 阅读 `README.md`、`AGENTS.md`、`docs/HANDOFF.md`。
4. 从用户控制的私有存储复制原 APK到任意非仓库目录，校验 SHA-256。
5. 可选复制 `runtime/` DEX/SO/反编译树；缺失时按环境手册再生。
6. 设置 `MXXY_REPO`、`MXXY_APK`、`MXXY_WORK`、`ANDROID_SDK_ROOT`。
7. 执行 `make verify`，再按 HANDOFF 的“当前最优下一步”继续。

AVD 不需要同步；重建更可复现。密钥、GitHub token、签名 keystore 走独立密码管理器/加密备份，绝不进 Git。

## 新 Agent 交接协议

每次有实质进展时，提交前必须：

1. 更新 `docs/HANDOFF.md` 的日期、状态矩阵、已解决问题和下一步。
2. 将动态命令与脱敏观察写入 `docs/DYNAMIC_AUDIT_LOG.md`。
3. 新脚本加入 `make verify` 或相应测试。
4. 更新制品哈希清单（若出现新的权威派生产物）。
5. 确认 `git status --ignored` 中没有私有制品误入跟踪范围。
6. 在提交消息中说明“证据是什么”，不要只写“update”。

## 无法访问 GitHub 时的本地兜底

本地 commit 仍是完整进度。可在仓库外生成 bundle：

```bash
git bundle create /absolute/private/path/mxxy-audit.bundle --all
git bundle verify /absolute/private/path/mxxy-audit.bundle
```

另一台电脑可从 bundle 克隆，再添加 GitHub remote。bundle 仅包含 Git 已跟踪文件，不包含 APK/DEX/WPK 等私有制品。
