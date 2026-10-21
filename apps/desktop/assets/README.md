# DogO macOS 图标

`icon.png` 是用户于 2026-10-21 选定的第 5 号方案：奶油白圆角底、墨绿 D 与小狗侧脸。使用图像生成工具制作独立透明底原图，作为图标源资源保存。

在 Apple Silicon Mac 的仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @dogo/desktop package:mac
```

打包脚本使用系统 `sips` 生成标准和 Retina 尺寸，再以 `iconutil` 合成 `Contents/Resources/DogO.icns`；`CFBundleIconFile` 指向该文件，随后执行原签名流程。无需额外图像处理依赖。

完全退出旧应用后，用 `apps/desktop/release/` 中的新应用替换安装版。仅拉取源码不会改变已安装应用的图标。开发模式启动的 Electron 及菜单栏模板小图标不在本次修改范围。
