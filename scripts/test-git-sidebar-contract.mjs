import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../plugins/dsh-client-ui-review/lib/client.js', import.meta.url), 'utf8')
assert.match(source, /sidebarRightTabs[\s\S]*register\(\{[\s\S]*kind: KIND/u)
assert.match(source, /const KIND = 'git'/u)
assert.match(source, /key: SIDEBAR_ID/u)
assert.match(source, /IconBranchOutline16/u)
assert.doesNotMatch(source, /ctx\.slots\.inject\(HERO_SLOT/u)
assert.match(source, /react\.createElement\(ReviewPanel,[\s\S]*embedded: true/u)
assert.match(source, /const activeId = state\?\.current \?\? sessionId/u)
assert.match(source, /state\?\.byId\?\.\[activeId\]\?\.cwd/u)
assert.match(source, /const embedded = props\?\.embedded === true/u)
assert.match(source, /panelLogIntent\.request\(\)[\s\S]*sidebar\.openTab\(KIND, \{\}\)/u)
assert.doesNotMatch(source, /embedded \? null : react\.createElement\([\s\S]{0,120}'data-review-icon-button':[\s\S]{0,120}title: t\('refresh'\)/u)
console.log('PASS Git is registered through the official right Sidebar API and icon system')
console.log('PASS the legacy shell.overlay project Git entry is not registered')
console.log('PASS Sidebar Git derives its workspace from the active Harness session')
console.log('PASS compare navigation opens the official Git Sidebar and preserves refresh')
