/**
 * Types for the built-in skill definition.
 *
 * The shape mirrors what `@deepseek-ai/dsh-skill` validates at registration and, more strictly,
 * at load time (`validateDefinition`): `name` (kebab-case), `description`, `source` and `content`
 * are required strings, `whenToUse` is optional, and `invocation` — when present — must carry two
 * booleans. This file exists so the guard test can import the JS module with types.
 */

export interface DesktopBrowserSkill {
  /** Kebab-case; the name users and the model look it up by. */
  readonly name: string
  readonly description: string
  /** Where the skill came from; required at load time, shown in the skill catalogue. */
  readonly source: string
  /** The instructions the model reads. */
  readonly content: string
  readonly whenToUse?: string
  readonly invocation?: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
}

export declare const BROWSER_SKILL: DesktopBrowserSkill
