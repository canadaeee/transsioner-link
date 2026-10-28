/**
 * 测试用的最小宿主：只为拿到 apply() 注册的工具表，不启动 DSH。
 *
 * 它不模拟 DSH 的任何行为差异——`inject`/`effect`/`tools.register` 的语义与真实
 * Host 一致（effect 立即执行一次，返回 disposer），所以工具里的注册路径是同一份代码。
 */
import { apply } from '../index.js'

export function loadTools(config = {}) {
  const tools = new Map()
  const warnings = []

  const scope = {
    effect(fn, _label) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  }

  const ctx = {
    inject(_names, callback) {
      return callback(scope)
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  }

  apply(ctx, config)
  return { tools, warnings, config }
}

/** 直接执行某个工具，返回它交给模型的字符串。 */
export async function callTool(tools, name, args = {}) {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`工具未注册：${name}`)
  return tool.execute(args, { signal: undefined })
}
