import assert from 'node:assert/strict'
import { mergeMetadata } from './merge-mac-update-metadata.mjs'

const metadata = (arch, version = '1.6.8') => `version: ${version}
files:
  - url: dsh-desktop-${arch}.zip
    sha512: YWJjZA==
    size: 200
  - url: dsh-desktop-${arch}.dmg
    sha512: ZWZnaA==
    size: 220
path: dsh-desktop-${arch}.zip
sha512: YWJjZA==
releaseDate: '2026-09-28T00:00:00.000Z'
`

const merged = mergeMetadata(metadata('arm64'), metadata('x64'))
assert.deepEqual([...merged.matchAll(/^  - url: (.+)$/gmu)].map((match) => match[1]), [
  'dsh-desktop-arm64.zip', 'dsh-desktop-x64.zip', 'dsh-desktop-arm64.dmg', 'dsh-desktop-x64.dmg',
])
assert.match(merged, /^path: dsh-desktop-arm64.zip$/mu)
assert.match(merged, /^version: 1\.6\.8$/mu)
assert.throws(() => mergeMetadata(metadata('arm64'), metadata('x64', '1.6.9')), /versions differ/u)
assert.throws(() => mergeMetadata(metadata('arm64').replace('dsh-desktop-arm64.dmg', 'missing.dmg'), metadata('x64')), /invalid file entry/u)
console.log('PASS parallel macOS metadata contains both architectures and rejects mismatched inputs')
