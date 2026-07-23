# MXXY Offline Game APK

独立 Android 壳工程，实现基于真实解码数据的离线宠物游戏。

## 构建

```bash
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug
# APK 输出: app/build/outputs/apk/debug/app-debug.apk
```

## 数据来源

- 30 个技能图标: 从 APK 资源文件 ASTC 5×5 解码为 PNG
- 9 个 shape_id: 从 WPK/IDX 资源索引提取
- 22 字段数据结构: 从 infobeast.lua ZZZ4/LZ4 解压
- 资源路径: 从 repository / Json.idx 条目提取

## 游戏功能

- 合宠融合: 双亲属性加权平均 + 随机扰动, 技能去重随机遗传
- 资质洗炼: 5项资质 + 成长值随机, 30% 提升概率
- 技能打书: 从 30 个真实解码图标学习, 满时随机替换
- 本地存档: SharedPreferences 持久化

## 签名

Debug keystore: keystore/offline-debug.jks
密码: mxxyoffline, 别名: mxxy-offline
