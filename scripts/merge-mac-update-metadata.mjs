// Combine the two macOS matrix jobs' electron-updater metadata after their
// artifacts are downloaded. Each job builds one architecture and therefore
// writes its own latest-mac.yml; publishing either one alone breaks updates
// for the other architecture.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseMetadata(text, arch) {
  const lines = text.replace(/\r\n/gu, '\n').trimEnd().split('\n')
  const version = /^version: (\d+\.\d+\.\d+)$/u.exec(lines[0])?.[1]
  if (version === undefined || lines[1] !== 'files:') throw new Error(`${arch}: invalid metadata header`)

  const files = []
  let index = 2
  while (lines[index]?.startsWith('  - url: ')) {
    const url = lines[index++].slice('  - url: '.length)
    const sha512 = /^    sha512: (.+)$/u.exec(lines[index++] ?? '')?.[1]
    const size = /^    size: (\d+)$/u.exec(lines[index++] ?? '')?.[1]
    if (!url.startsWith(`dsh-desktop-${arch}.`) || !['zip', 'dmg'].includes(url.split('.').at(-1)) ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(sha512 ?? '') || size === undefined) {
      throw new Error(`${arch}: invalid file entry ${url}`)
    }
    files.push({ url, sha512, size })
  }
  const path = /^path: (.+)$/u.exec(lines[index++] ?? '')?.[1]
  const primaryHash = /^sha512: (.+)$/u.exec(lines[index++] ?? '')?.[1]
  const releaseDate = /^releaseDate: (.+)$/u.exec(lines[index++] ?? '')?.[1]
  if (index !== lines.length || files.length !== 2 ||
      !files.some((file) => file.url === `dsh-desktop-${arch}.zip`) ||
      !files.some((file) => file.url === `dsh-desktop-${arch}.dmg`) ||
      files.find((file) => file.url === path)?.sha512 !== primaryHash || !releaseDate) {
    throw new Error(`${arch}: incomplete or unexpected metadata`)
  }
  return { version, files, releaseDate }
}

export function mergeMetadata(armText, intelText) {
  const arm = parseMetadata(armText, 'arm64')
  const intel = parseMetadata(intelText, 'x64')
  if (arm.version !== intel.version) throw new Error(`macOS metadata versions differ: ${arm.version} / ${intel.version}`)
  const files = [
    ...arm.files.filter((file) => file.url.endsWith('.zip')),
    ...intel.files.filter((file) => file.url.endsWith('.zip')),
    ...arm.files.filter((file) => file.url.endsWith('.dmg')),
    ...intel.files.filter((file) => file.url.endsWith('.dmg')),
  ]
  const primary = files[0]
  return [
    `version: ${arm.version}`,
    'files:',
    ...files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: ${arm.releaseDate}`,
    '',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? 'artifacts')
  const armPath = join(directory, 'latest-mac-arm64.yml')
  const intelPath = join(directory, 'latest-mac-x64.yml')
  const merged = mergeMetadata(readFileSync(armPath, 'utf8'), readFileSync(intelPath, 'utf8'))
  writeFileSync(join(directory, 'latest-mac.yml'), merged)
  unlinkSync(armPath)
  unlinkSync(intelPath)
  console.log(`Merged latest-mac.yml for ${/^version: (.+)$/mu.exec(merged)?.[1]} (arm64 + x64)`)
}
