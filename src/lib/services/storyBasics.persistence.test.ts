import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { parse } from 'svelte/compiler'
import { describe, expect, it, vi } from 'vitest'
import { storyBasicsUpdate } from './storyBasics'

const source = readFileSync('src/lib/stores/story.svelte.ts', 'utf8')
const ast = ts.createSourceFile('story.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(
  (n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'StoryStore',
)!
const method = declaration.members.find((n) => n.name?.getText(ast) === 'updateStoryBasics')!
const code = ts.transpileModule(`return class Store { ${method.getText(ast)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

describe('story basics save boundary', () => {
  function fixture() {
    const database = { updateStory: vi.fn(async () => {}) }
    const ui = { submissionScope: null as unknown }
    const Store = new Function('database', 'ui', 'storyBasicsUpdate', code)(
      database,
      ui,
      storyBasicsUpdate,
    )
    const store = new Store()
    store.currentStory = {
      id: 's',
      description: 'old',
      settings: { pov: 'first', collaborativeNovelPlan: { confirmed: 'plan' } },
    }
    store.allStories = [store.currentStory]
    store.assertNotBusy = vi.fn()
    return { store, database, ui }
  }
  const draft = { description: 'new', genre: '', tone: '克制', themes: '秘密\n秘密' }

  it('uses one database write and updates both views only on success', async () => {
    const { store, database } = fixture()
    await store.updateStoryBasics(draft)
    expect(database.updateStory).toHaveBeenCalledTimes(1)
    expect(store.currentStory).toEqual(store.allStories[0])
    expect(store.currentStory.settings).toEqual({
      pov: 'first',
      collaborativeNovelPlan: { confirmed: 'plan' },
      tone: '克制',
      themes: ['秘密'],
    })
    expect(store.currentStory.genre).toBeNull()
  })
  it('does not change in-memory data on failure or write during generation preparation', async () => {
    const { store, database, ui } = fixture()
    const before = structuredClone(store.currentStory)
    database.updateStory.mockRejectedValueOnce(new Error('disk full'))
    await expect(store.updateStoryBasics(draft)).rejects.toThrow('disk full')
    expect(store.currentStory).toEqual(before)
    expect(store.allStories).toEqual([before])
    ui.submissionScope = {}
    await expect(store.updateStoryBasics(draft)).rejects.toThrow('生成准备')
    expect(database.updateStory).toHaveBeenCalledTimes(1)
  })
  it('does not apply an old save to another story selected while the write was pending', async () => {
    const { store, database } = fixture()
    let done!: () => void
    database.updateStory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve
        }),
    )
    const pending = store.updateStoryBasics(draft)
    store.currentStory = { id: 'other', description: 'other' }
    done()
    await pending
    expect(store.currentStory.description).toBe('other')
    expect(store.allStories[0].description).toBe('new')
  })
  it('keeps the UI draft after a failed save and resets it after success', async () => {
    const component = readFileSync('src/lib/components/settings/tabs/story-settings.svelte', 'utf8')
    const parsed = parse(component, { modern: true })
    const functions = parsed.instance!.content.body.filter(
      (n) =>
        n.type === 'FunctionDeclaration' &&
        ['saveBasics', 'resetBasics'].includes(n.id?.name ?? ''),
    )
    const body = ts.transpileModule(
      functions
        .map((n) => {
          const { start, end } = n as typeof n & { start: number; end: number }
          return component.slice(start, end)
        })
        .join('\n'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText
    const story = {
      currentStory: { id: 's', description: 'saved', settings: {} },
      updateStoryBasics: vi.fn(async () => {}),
    }
    const ui = new Function(
      'story',
      'draft',
      `let basics = {...draft}, basicsBusy = false, basicsSaving = false, basicsError = '', basicsSaved = false; ${body}; return { save: saveBasics, reset: resetBasics, state: () => ({basics, basicsError, basicsSaved}) }`,
    )(story, draft)
    story.updateStoryBasics.mockRejectedValueOnce(new Error('disk full'))
    await ui.save()
    expect(ui.state().basics).toEqual(draft)
    expect(ui.state().basicsError).toBe('disk full')
    await ui.save()
    expect(ui.state().basics.description).toBe('saved')
    expect(ui.state().basicsSaved).toBe(true)
  })
})
