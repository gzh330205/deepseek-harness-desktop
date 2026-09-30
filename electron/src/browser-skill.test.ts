/**
 * The built-in skill must survive the registry's *load-time* validation, not just registration.
 *
 * This is a regression guard with a specific history: `ctx.skills.register()` accepted our skill
 * (it only checks name/description/invocation), but opening it failed in the UI with
 * `loaded skill "sidebar-browser" source must be a string` — because loading re-runs
 * `validateDefinition()`, which additionally requires `source` and `content` to be strings.
 *
 * The plugin's skill lives in its own module so this test can import it directly. The field list
 * below mirrors `validateDefinition` in `@deepseek-ai/dsh-skill`; a real-registry check lives in
 * `scripts/check-skill-contract.mjs` for DSH upgrades.
 *
 * Run: node --test src/browser-skill.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BROWSER_SKILL } from '../../src-tauri/resources/dsh-desktop-shell/browser-skill.js'

/** `SKILL_NAME` in `@deepseek-ai/dsh-skill`. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

test('the skill passes every field check the registry applies when loading it', () => {
  assert.equal(typeof BROWSER_SKILL.name, 'string')
  assert.match(BROWSER_SKILL.name, SKILL_NAME)

  assert.equal(typeof BROWSER_SKILL.description, 'string')
  assert.notEqual(BROWSER_SKILL.description.trim(), '', 'a loaded skill requires a description')

  // The field that was missing: required by `validateDefinition` at load time.
  assert.equal(typeof BROWSER_SKILL.source, 'string')
  assert.notEqual(BROWSER_SKILL.source.trim(), '', 'source must be a non-empty string')

  assert.equal(typeof BROWSER_SKILL.content, 'string')
  assert.notEqual(BROWSER_SKILL.content.trim(), '', 'content is what the model actually reads')

  if (BROWSER_SKILL.whenToUse !== undefined) assert.equal(typeof BROWSER_SKILL.whenToUse, 'string')
  if (BROWSER_SKILL.invocation !== undefined) {
    assert.equal(typeof BROWSER_SKILL.invocation.modelInvocable, 'boolean')
    assert.equal(typeof BROWSER_SKILL.invocation.userInvocable, 'boolean')
  }
  // Nothing in the definition may be a function/Date/etc: the registry serialises summaries.
  assert.deepEqual(JSON.parse(JSON.stringify(BROWSER_SKILL)), BROWSER_SKILL)
})

test('the skill teaches the workflow the tools actually implement', () => {
  const content = BROWSER_SKILL.content
  // The order that matters: look, then act by index, then verify.
  for (const tool of ['state', 'tabs', 'navigate', 'snapshot', 'click', 'type', 'find', 'wait', 'screenshot']) {
    assert.ok(content.includes(tool), `the skill should mention ${tool}`)
  }
  // The two habits that keep an agent out of trouble.
  assert.match(content, /索引/u, 'the skill must push index-based clicking')
  assert.match(content, /验证/u, 'the skill must ask for verification after acting')
  assert.match(content, /确认/u, 'side-effectful actions must be confirmed with the user first')
})
