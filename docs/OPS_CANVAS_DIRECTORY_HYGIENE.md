# Canvas 生产目录卫生规则

生产运行目录 `/opt/infinite-canvas` 只保存当前 Canvas 源码、当前 Compose 配置、构建配置和持久数据 `server-data/`。

不得在该目录创建或保留历史发布包、回滚目录、暂存源码、旧网关配置、旧主页/Insight 文件或历史调试资料。

## 归档位置

- Canvas 历史回滚资料：`/opt/hoosland-archive/canvas-history-<timestamp>/`
- Canvas 根目录清理归档：`/opt/hoosland-archive/canvas-root-cleanup-<timestamp>/`
- 主页与 Insight 历史静态内容：`/opt/hoosland-archive/legacy-canvas-content-<timestamp>/`

## 发布与回滚

每次涉及 Canvas 运行的变更，先将回滚材料写入对应的 `/opt/hoosland-archive/` 时间戳目录，并记录清单、容器状态和关键校验结果。运行目录不建立指向历史备份的兼容软链接。

`server-data/` 是当前 Canvas 持久数据，不能作为常规清理目标。主页、Insight、全站网关分别在各自独立目录和 Compose 项目中管理。
