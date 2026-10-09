import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  collaborativeTruncationPlanStatements,
  restoreCharacterStatement,
} from './collaborativeTransactions'

const fixture = JSON.parse(
  readFileSync('src-tauri/src/db_tx/fixtures/collaborative-truncation.json', 'utf8'),
)

describe('frontend/native transaction fixture parity', () => {
  it('uses exactly the current frontend truncation batch in native SQLite tests', () => {
    expect(collaborativeTruncationPlanStatements(fixture.input)).toEqual(fixture.statements)
  })

  it('uses the current nullable-branch restore statement in native SQLite tests', () => {
    expect(restoreCharacterStatement(fixture.mainInput.scope, fixture.mainInput.state)).toEqual(
      fixture.mainStatements[0],
    )
  })
})
