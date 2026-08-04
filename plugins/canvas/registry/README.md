# 官方插件注册表(集中构建 + 远程发布)

本目录**只放构建脚本**,不放构建产物。官方插件由 CI 构建后发布到自有仓库的孤儿分支 `plugins-dist`。分叉版本不再默认连接任何上游插件源；需要远程插件时，由部署方通过 `VITE_PLUGIN_REGISTRY_URL` 显式指定自建清单地址。第三方插件不进本流程,由用户自行填 JS URL 安装。

```
registry/
  package.json    # 构建依赖(esbuild + SDK)
  build.mjs       # 一次进程构建所有官方插件 → dist/(gitignore)+ 生成清单
  dist/           # 构建产物(gitignore,不提交;CI 发布到 plugins-dist 分支)
```

**产物不进 git**:`dist/` 与 `node_modules/` 均被 `.gitignore` 覆盖。`main` 分支只有源码与脚本。

## 发布流程(CI 自动)

`.github/workflows/publish-plugins.yml` 在**打版本 tag(`v*`)**或手动触发(`workflow_dispatch`)时,与 GitHub Pages 发布一起跑:

1. `npm install && npm run build` → 在 `dist/` 产出各 `<id>.js` 与 `official-plugins.json`;
2. 把 `dist/` 强推到孤儿分支 **`plugins-dist`**(仅含产物,force-push 覆盖)。

前端默认不配置远程插件清单。部署方可将 `plugins-dist` 托管到自己的静态服务，并设置：

```
VITE_PLUGIN_REGISTRY_URL=https://your-domain.example/official-plugins.json
```

清单里每条的 `entry`(相对文件名)由前端解析成与清单同目录的绝对 URL,再走既有 URL 安装流程。

## 新增 / 更新官方插件

- 改完某官方插件源码后,在 `build.mjs` 的 `OFFICIAL` 里保持登记(新增插件在此加一条),提交到 `main`;
- 下次打版本 tag(或手动 `workflow_dispatch`)时,CI 自动重新构建并发布到 `plugins-dist`。

## 本地自测官方面板

```bash
cd plugins/canvas/registry && npm install && npm run build   # 产出 dist/
# 用任意静态服务器伺服 dist/,把 VITE_PLUGIN_REGISTRY_URL 指向其 official-plugins.json
```
