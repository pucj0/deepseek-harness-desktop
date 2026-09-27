/**
 * shell-bridge 的 host 半边。
 *
 * 这个插件只做一件事：把「Harness 当前项目」告诉 Electron 外壳。那件事发生在**浏览器**
 * 里（`ctx.sessions.list` 的当前会话属于哪个工作区只有渲染进程知道），因此真正的实现
 * 全在 `./client`。
 *
 * host 半边仍然必须存在，而且必须是一个能被 loader 挂载的合法插件：内置插件是通过
 * profile 的 bundle patch（`cordis.patch.yml` 的 `insert`）挂进插件树的，缺了 `apply` /
 * `name` 会让整个 profile 启动失败——那会表现为三个插件一起从界面上消失。
 *
 * 它刻意**不做**任何事：不注册设置、不提供服务、不监听事件。少一个 host 侧行为，就少一份
 * "外壳状态"泄漏进 Harness 的机会。
 */

/** 插件名（与 cordis.patch.yml 里的 id 对应）。 */
export const name = 'ui-shell-bridge'

/** 无需 host 侧行为。 */
export function apply() {}
