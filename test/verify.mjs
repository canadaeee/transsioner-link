/**
 * 交付前自检：清单、导出、图标、locale、files 完整性，最后跑一遍离线冒烟。
 * 跑：node test/verify.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const problems = []
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    problems.push(`${label}：${error.message}`)
    console.log(`  ✗ ${label}：${error.message}`)
  }
}

console.log('manifest')
// 允许大写：本地 link: 插件不经过 registry，DSH 的组装器也接受（已用 dump-config 验证）。
// 若哪天要发布到 npm，再改回全小写。
check('name 是合法包名而不是路径', () => assert.match(pkg.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/))
check('dsh.bundle.patch 指向真实文件', () => {
  const patch = join(root, pkg.dsh.bundle.patch)
  assert.equal(existsSync(patch), true)
  assert.match(readFileSync(patch, 'utf8'), /^\s*-\s*insert:/m)
})
check('patch 里的 name 与包名一致', () => {
  const patch = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8')
  assert.match(patch, new RegExp(`name:\\s*['"]?${pkg.name}['"]?`))
})
check('exports 暴露入口、locale、图标', () => {
  for (const key of ['.', './package.json', './locale/*.json', './icon']) {
    assert.equal(typeof pkg.exports[key], 'string', `缺少 exports.${key}`)
  }
})

console.log('显示元数据')
for (const locale of ['zh', 'en']) {
  check(`${locale}.json 有 meta.title/description`, () => {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8')).meta
    assert.equal(typeof meta.title, 'string')
    assert.equal(meta.title.length > 0, true)
    assert.equal(typeof meta.description, 'string')
    assert.equal(meta.description.length > 10, true)
  })
}
check('图标是有效 SVG 且 ≤ 256 KiB', () => {
  const file = join(root, 'icon.svg')
  const size = statSync(file).size
  assert.equal(size <= 256 * 1024, true, `图标 ${size} 字节`)
  const head = readFileSync(file, 'utf8').slice(0, 200)
  assert.match(head, /<svg[\s>]/)
})

console.log('files 完整性')
check('运行时文件都在 files 里', () => {
  const listed = new Set(pkg.files)
  const required = ['index.js', 'cordis.patch.yml', 'icon.svg', 'README.md']
  for (const file of required) assert.equal(listed.has(file), true, `files 缺 ${file}`)
  for (const dir of ['lib', 'locale']) assert.equal(listed.has(dir) || listed.has(`${dir}/*.json`), true, `files 缺 ${dir}`)
})
check('lib 里的模块都存在', () => {
  for (const name of ['cli.js', 'docx.js', 'format.js', 'link.js']) {
    assert.equal(existsSync(join(root, 'lib', name)), true, `缺 lib/${name}`)
  }
})
check('没有把凭据或备份放进包里', () => {
  const suspicious = ['node_modules', '.env', '.lark-home']
  for (const name of suspicious) assert.equal(existsSync(join(root, name)), false, `包里不该有 ${name}`)
})

console.log('离线冒烟')
check('test/smoke.mjs 通过', () => {
  const out = execFileSync(process.execPath, [join(root, 'test', 'smoke.mjs')], { encoding: 'utf8' })
  assert.match(out, /项通过/)
})

if (problems.length > 0) {
  console.error(`\n${problems.length} 项不通过：\n${problems.map((p) => ` - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`\n自检通过（${relative(process.cwd(), root) || '.'}）`)
