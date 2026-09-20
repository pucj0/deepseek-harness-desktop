// 轮询等待某次 CI 运行结束。只用于发布后确认结果，不参与构建。
//
//   node scripts/ci-wait.mjs [最多等待分钟数]
import { execFileSync } from 'node:child_process'

const repo = 'pucj0/deepseek-harness-desktop'
const limitMinutes = Number(process.argv[2] ?? 30)
const deadline = Date.now() + limitMinutes * 60 * 1000

/** 从 git 凭据助手取 token。 */
function githubToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git 凭据里没有 github.com 的 token')
  return line.slice('password='.length).trim()
}

const headers = {
  authorization: `Bearer ${githubToken()}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-desktop-ci-wait',
}

const get = async (url) => {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
console.log(`等待 CI：提交 ${head.slice(0, 7)}，最多 ${limitMinutes} 分钟`)

let lastLine = ''
for (;;) {
  const runs = await get(`https://api.github.com/repos/${repo}/actions/runs?per_page=5`)
  const run = runs.workflow_runs.find((r) => r.head_sha === head)
  if (run === undefined) {
    console.log('  还没有对应这次提交的运行，等 20 秒…')
  } else {
    const jobs = await get(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`)
    const parts = jobs.jobs.map((job) => `${job.name}=${job.conclusion ?? job.status}`)
    const line = `#${run.run_number} ${run.conclusion ?? run.status} | ${parts.join(' ')}`
    if (line !== lastLine) {
      console.log(`  ${line}`)
      lastLine = line
    }
    if (run.status === 'completed') {
      console.log('')
      for (const job of jobs.jobs) {
        const failed = job.steps.find((s) => s.conclusion === 'failure')
        console.log(`  ${String(job.conclusion ?? job.status).padEnd(10)} ${job.name}${failed ? `  <- 失败步骤: ${failed.name}` : ''}`)
      }
      console.log(`\n最终结论: ${run.conclusion}`)
      process.exit(run.conclusion === 'success' ? 0 : 1)
    }
  }
  if (Date.now() > deadline) {
    console.log(`\n超过 ${limitMinutes} 分钟仍未结束，先放弃等待（CI 仍在后台跑）。`)
    process.exit(2)
  }
  await new Promise((resolve) => setTimeout(resolve, 20000))
}
